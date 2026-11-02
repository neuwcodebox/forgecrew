import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command, spawnProcess } from '../../process.ts';
import type { Model, Result } from '../../../../shared/src/types.ts';
import { instructions, userInput } from '../types.ts';
import type { Provider, ProviderRun, RunRequest } from '../types.ts';
import { ClaudeStream } from './stream.ts';
import { claudeModel } from './catalog.ts';
import type { ClaudeModelInfo } from './catalog.ts';

export class ClaudeProvider implements Provider {
  readonly executable: string;
  constructor(executable: string) {
    this.executable = executable;
  }
  private open(args: string[] = [], cwd?: string) {
    return new ClaudeStream(
      spawnProcess(
        this.executable,
        [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--permission-mode',
          'auto',
          '--permission-prompts',
          'none',
          '--system-prompt-snapshot',
          'off',
          ...args,
        ],
        cwd,
      ),
    );
  }
  async probe(): Promise<Model[]> {
    const auth = await command(this.executable, ['auth', 'status']);
    if (auth.code !== 0) throw new Error('claude_auth_required');
    const status = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string };
    if (!status.loggedIn || !['claude.ai', 'oauth_token'].includes(status.authMethod ?? ''))
      throw new Error('claude_subscription_login_required');
    const stream = this.open();
    try {
      const init = await stream.control<{
        models: ClaudeModelInfo[];
        claude_code_version?: string;
      }>({ subtype: 'initialize' });
      await stream.control({ subtype: 'set_permission_mode', mode: 'auto' });
      return init.models
        .map((m) => claudeModel(m, init.claude_code_version ?? 'unknown', Date.now()))
        .filter((m): m is Model => m !== null);
    } finally {
      await stream.close();
    }
  }
  run(request: RunRequest): ProviderRun {
    let stream: ClaudeStream | undefined;
    let directory: string | undefined;
    let settled = false;
    let initialized = false;
    let sessionSaved: Promise<void> = Promise.resolve();
    let interruptRequested = false;
    let closing = false;
    let resolveResult!: (r: Result) => void;
    let rejectResult!: (e: Error) => void;
    const result = new Promise<Result>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        rejectResult(error);
      }
    };
    const interrupt = async () => {
      interruptRequested = true;
      if (stream && initialized) await stream.control({ subtype: 'interrupt' });
    };
    const abort = () => {
      void interrupt().catch(() => {});
    };
    request.signal.addEventListener('abort', abort, { once: true });
    const start = (async () => {
      directory = await mkdtemp(join(tmpdir(), 'forgecrew-instructions-'));
      const file = join(directory, 'instructions.md');
      await writeFile(file, instructions(request), { mode: 0o600 });
      if (request.signal.aborted || closing) throw new Error('provider_interrupted');
      stream = this.open(
        [
          '--model',
          request.claim.runConfig.model,
          '--append-system-prompt-file',
          file,
          ...(request.claim.runConfig.effort ? ['--effort', request.claim.runConfig.effort] : []),
          ...(request.resume ? ['--resume', request.resume.id] : []),
        ],
        request.workspace,
      );
      stream.on('closed', () => {
        if (!settled) fail(new Error('claude_exited_before_result'));
      });
      stream.on('invalid_message', () => fail(new Error('claude_invalid_json')));
      stream.on('unattended_request', () => {
        fail(new Error('claude_unattended_request'));
        void interrupt().catch(() => {});
      });
      stream.on('message', (message) => {
        if (message.type === 'system' && message.subtype === 'init') {
          const sessionId = message.session_id;
          if (typeof sessionId !== 'string' || !sessionId) {
            fail(new Error('claude_invalid_session'));
            void interrupt().catch(() => {});
            return;
          }
          if (
            message.model !== request.claim.runConfig.model ||
            message.permissionMode !== 'auto'
          ) {
            fail(new Error('claude_effective_settings_mismatch'));
            void interrupt().catch(() => {});
            return;
          }
          sessionSaved = sessionSaved.then(() =>
            request.onSession({
              id: sessionId,
              engine: 'claude',
              workspace: request.workspace,
            }),
          );
          void sessionSaved.catch(() => fail(new Error('claude_session_persistence_failed')));
        }
        if (message.type === 'assistant' && message.error && !settled) {
          const error = message.error;
          fail(
            new Error(
              error === 'rate_limit'
                ? 'claude_rate_limited'
                : [
                      'authentication_failed',
                      'oauth_org_not_allowed',
                      'account_on_hold',
                      'verification_required',
                      'billing_error',
                    ].includes(error)
                  ? 'claude_auth_required'
                  : 'claude_turn_failed',
            ),
          );
          return;
        }
        if (message.type === 'result' && !settled) {
          if (interruptRequested || request.signal.aborted) {
            fail(new Error('provider_interrupted'));
            return;
          }
          const used = Object.keys(message.modelUsage ?? {});
          if (used.some((id) => id !== request.claim.runConfig.model)) {
            fail(new Error('claude_model_rerouted'));
            return;
          }
          if (message.is_error || typeof message.result !== 'string' || !message.result.trim()) {
            fail(new Error('claude_turn_failed'));
            return;
          }
          const text = message.result;
          void sessionSaved.then(
            () => {
              if (!settled) {
                settled = true;
                resolveResult({ kind: 'completed', text });
              }
            },
            () => fail(new Error('claude_session_persistence_failed')),
          );
        }
      });
      await stream.control({ subtype: 'initialize' });
      initialized = true;
      await stream.control({ subtype: 'set_permission_mode', mode: 'auto' });
      const settings = await stream.control<{
        applied?: { model?: string; effort?: string | null };
      }>({ subtype: 'get_settings' });
      if (
        settings.applied?.model !== request.claim.runConfig.model ||
        (request.claim.runConfig.effort !== null &&
          settings.applied?.effort !== request.claim.runConfig.effort)
      )
        throw new Error('claude_effective_settings_mismatch');
      if (request.signal.aborted || interruptRequested) throw new Error('provider_interrupted');
      stream.send({
        type: 'user',
        uuid: request.claim.attemptId,
        session_id: request.resume?.id ?? '',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: userInput(request) }] },
      });
    })().catch((error) => fail(error instanceof Error ? error : new Error('claude_start_failed')));
    return {
      result,
      interrupt,
      steer: async () => {
        throw new Error('steer_requires_restart');
      },
      close: async () => {
        closing = true;
        request.signal.removeEventListener('abort', abort);
        await stream?.close();
        await start;
        if (directory) await rm(directory, { recursive: true, force: true });
      },
    };
  }
}
