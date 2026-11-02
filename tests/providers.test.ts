import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../packages/dispatcher/src/storage/index.ts';
import { config, worker } from './helpers.ts';
import { CodexProvider } from '../packages/worker/src/providers/codex/index.ts';
import { ClaudeProvider } from '../packages/worker/src/providers/claude/index.ts';
import { claudeModel } from '../packages/worker/src/providers/claude/catalog.ts';
import type { RunRequest } from '../packages/worker/src/providers/types.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture(scenario: string) {
  const dir = await mkdtemp(join(tmpdir(), 'forgecrew-provider-'));
  directories.push(dir);
  const log = join(dir, 'requests.jsonl');
  await writeFile(log, '');
  const source = fileURLToPath(new URL('./fixtures/provider.cjs', import.meta.url));
  const executable = join(dir, process.platform === 'win32' ? 'provider.cmd' : 'provider');
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  await writeFile(
    executable,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${source}" "${scenario}" "${log}" %*\r\n`
      : `#!/bin/sh\nexec ${[process.execPath, source, scenario, log].map(quote).join(' ')} "$@"\n`,
  );
  await chmod(executable, 0o755);
  const s = new Store();
  const c = config(),
    w = worker(Date.now());
  s.workers.register(w, 'a'.repeat(48));
  s.sessions.upsert(
    { host: c.github.hostname, repository: 'team/project-a', kind: 'issue', number: 1 },
    ['ai:enabled'],
    true,
    Date.now(),
    'request',
    'writer',
  );
  const claim = s.executions.claim(w.id, c)!;
  s.close();
  if (scenario.startsWith('claude')) {
    claim.runConfig.engine = 'claude';
    claim.runConfig.model = 'claude-opus-5-5';
    claim.runConfig.family = 'opus';
  }
  const request: RunRequest = {
    claim,
    workspace: dir,
    context: 'conversation',
    signal: new AbortController().signal,
    onSession: async () => {},
  };
  const requests = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { executable, request, requests };
}
describe('Codex official process protocol', () => {
  it('discovers models and validates effective Auto Review before a turn', async () => {
    const f = await fixture('codex');
    const provider = new CodexProvider(f.executable);
    expect((await provider.probe())[0]?.version).toEqual([6, 10]);
    const run = provider.run(f.request);
    try {
      expect(await run.result).toEqual({ kind: 'completed', text: 'fixture answer' });
    } finally {
      await run.close();
    }
    const opened = (await f.requests()).find((m) => m.method === 'thread/start');
    expect(opened.params).not.toHaveProperty('sandbox');
    expect(opened.params.developerInstructions).toContain(
      f.request.claim.runConfig.payload.agent.instructions,
    );
    expect(opened.params.developerInstructions).toContain('Existing user instructions.');
  });
  it('does not start a turn if the runtime changes the selected model', async () => {
    const f = await fixture('codex-mismatch');
    const run = new CodexProvider(f.executable).run(f.request);
    try {
      await expect(run.result).rejects.toThrow('codex_effective_settings_mismatch');
    } finally {
      await run.close();
    }
    expect((await f.requests()).some((m) => m.method === 'turn/start')).toBe(false);
  });
  it('preserves a blocking question and ends the turn without fabricated answers', async () => {
    const f = await fixture('codex-question');
    const run = new CodexProvider(f.executable).run(f.request);
    try {
      const result = await run.result;
      expect(result.kind).toBe('needs_reply');
      expect(result.text).toContain('Which database?');
    } finally {
      await run.close();
    }
    expect((await f.requests()).some((m) => m.id === 101 && 'result' in m)).toBe(false);
  });
  it('reports native usage limits distinctly from an unsuccessful answer', async () => {
    const f = await fixture('codex-rate-limit'),
      run = new CodexProvider(f.executable).run(f.request);
    try {
      await expect(run.result).rejects.toThrow('codex_rate_limited');
    } finally {
      await run.close();
    }
  });
  it('steers only the expected active turn', async () => {
    const f = await fixture('codex-steer');
    const run = new CodexProvider(f.executable).run(f.request);
    try {
      await run.steer('change approach', 'control_1');
      expect((await run.result).kind).toBe('completed');
    } finally {
      await run.close();
    }
    const sent = (await f.requests()).find((m) => m.method === 'turn/steer');
    expect(sent.params.expectedTurnId).toBe('turn_1');
  });
});
describe('Claude official stream-json process protocol', () => {
  it('resolves numeric model versions from the runtime catalogue', async () => {
    const f = await fixture('claude');
    const models = await new ClaudeProvider(f.executable).probe();
    expect(models[0]?.id).toBe('claude-opus-5-5');
    expect(models[0]?.version).toEqual([5, 5]);
    expect(
      claudeModel({ value: 'opus', supportsAutoMode: true }, 'fixture', Date.now()),
    ).toBeNull();
  });
  it('checks settings before sending a prompt and returns only the terminal main result', async () => {
    const f = await fixture('claude');
    let session = '';
    f.request.onSession = async (s) => {
      session = s.id;
    };
    const run = new ClaudeProvider(f.executable).run(f.request);
    try {
      expect((await run.result).text).toBe('fixture answer');
    } finally {
      await run.close();
    }
    expect(session).toBe('claude_session_1');
    const sent = await f.requests();
    expect(sent.findIndex((m) => m.request?.subtype === 'get_settings')).toBeLessThan(
      sent.findIndex((m) => m.type === 'user'),
    );
  });
  it('rejects an invalid session identity without persisting it or accepting the answer', async () => {
    const fixtureProcess = await fixture('claude-invalid-session');
    const sessions: unknown[] = [];
    fixtureProcess.request.onSession = async (session) => {
      sessions.push(session);
    };
    const run = new ClaudeProvider(fixtureProcess.executable).run(fixtureProcess.request);
    try {
      await expect(run.result).rejects.toThrow('claude_invalid_session');
      expect(sessions).toEqual([]);
    } finally {
      await run.close();
    }
  });
  it('reports native authentication errors without treating them as an AI answer', async () => {
    const f = await fixture('claude-auth-error'),
      run = new ClaudeProvider(f.executable).run(f.request);
    try {
      await expect(run.result).rejects.toThrow('claude_auth_required');
    } finally {
      await run.close();
    }
  });
  it('rejects a silent model fallback before sending the request', async () => {
    const f = await fixture('claude-mismatch');
    const run = new ClaudeProvider(f.executable).run(f.request);
    try {
      await expect(run.result).rejects.toThrow('claude_effective_settings_mismatch');
    } finally {
      await run.close();
    }
    expect((await f.requests()).some((m) => m.type === 'user')).toBe(false);
  });
});
