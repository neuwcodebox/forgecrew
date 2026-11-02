import { describe, expect, it } from 'vitest';
import { stringify, parse } from 'yaml';
import {
  ConfigManager,
  configRevision,
  parseConfig,
  validateProjection,
  workerProjection,
} from '../packages/shared/src/config/index.ts';
import { compareVersions, resolveLabels, selectWorker } from '../packages/shared/src/models.ts';
import { canWrite, parseControl } from '../packages/shared/src/input.ts';
import { renderOutput, splitOutput } from '../packages/shared/src/output.ts';
import { config, configSource, worker } from './helpers.ts';
import { hash } from '../packages/shared/src/hash.ts';

describe('central configuration', () => {
  it('parses the complete example and preserves prompt whitespace', () => {
    const c = config();
    expect(c.runtime.leaseDuration).toBe(90000);
    expect(c.agent.instructions.endsWith('\n')).toBe(true);
  });
  it('parses LF and CRLF configuration files identically', () => {
    expect(parseConfig(configSource.replace(/\n/g, '\r\n'))).toEqual(parseConfig(configSource));
  });
  it.each([
    configSource + '\nschemaVersion: 1\n',
    configSource.replace('leaseDuration: 90s', 'leaseDuration: 20s'),
    configSource.replace('reassignGrace: 15s', 'reassignGrace: 5s'),
    configSource + '\nunknown: true\n',
    configSource.replace('modelPrefix: "ai:model:"', 'modelPrefix: "ai:"'),
    configSource.replace(
      'attribution: |\n    <sub>🤖 AI-generated · ForgeCrew</sub>',
      'attribution: "<!-- hidden -->"',
    ),
    configSource.replace('schemaVersion: 1', 'schemaVersion: !!js/function nope'),
  ])('rejects malformed candidates', (source) => expect(() => parseConfig(source)).toThrow());
  it('keeps the entire last good revision after validation or persistence failure', () => {
    let fail = false;
    const m = new ConfigManager(configSource, () => {
      if (fail) throw new Error('snapshot persistence failed');
    });
    const before = configRevision(m.current);
    expect(m.reload(configSource + '\ninvalid: true')).toBe(false);
    expect(configRevision(m.current)).toBe(before);
    fail = true;
    expect(m.reload(configSource.replace('effort: high', 'effort: low'))).toBe(false);
    expect(configRevision(m.current)).toBe(before);
  });
  it('requires restart as an entire candidate, keeping live prompt unchanged', () => {
    const m = new ConfigManager(configSource);
    expect(
      m.reload(
        configSource.replace('port: 8080', 'port: 9090').replace('effort: high', 'effort: low'),
      ),
    ).toBe(false);
    expect(m.current.server.port).toBe(8080);
  });
  it('ignores comments and key order for revisions', () => {
    const c = config();
    expect(configRevision(parseConfig('# comment\n' + configSource))).toBe(configRevision(c));
    const source = stringify(
      Object.fromEntries(Object.entries(parse(configSource) as object).reverse()),
    );
    expect(configRevision(parseConfig(source))).toBe(configRevision(c));
  });
  it('projects explicit fields only and checks payload hash', () => {
    const p = workerProjection(config());
    expect(JSON.stringify(p)).not.toMatch(/tokenEnv|dataDir|FORGECREW_GITHUB_PAT|REGISTRATION/);
    validateProjection(p);
    p.payload.agent.instructions += 'tampered';
    expect(() => validateProjection(p)).toThrow();
  });
  it('rejects missing projection fields even when the hash was recomputed', () => {
    const p = workerProjection(config());
    const broken = { ...p, payload: { schemaVersion: 1 } };
    broken.payloadHash = hash(broken.payload);
    expect(() => validateProjection(broken)).toThrow('invalid config projection');
  });
  it('never expands shell-like prompt text', () => {
    const c = parseConfig(
      configSource.replace(
        'agent:\n  instructions: |',
        'agent:\n  instructions: |\n    ${SECRET} $PATH $(echo unsafe)',
      ),
    );
    expect(c.agent.instructions).toContain('${SECRET} $PATH $(echo unsafe)');
  });
});

describe('model labels and scheduling', () => {
  it('compares version tuples numerically', () => {
    expect(compareVersions([6, 10], [6, 9])).toBe(1);
    expect(compareVersions([6], [6, 0])).toBe(0);
  });
  it('applies session, repository and global defaults', () => {
    expect(resolveLabels(['ai:model:opus', 'ai:effort:xhigh'], config(), 'team/project-a')).toEqual(
      { family: 'opus', effort: 'xhigh' },
    );
  });
  it.each([
    ['ai:model:sol', 'ai:model:terra'],
    ['ai:effort:high', 'ai:effort:low'],
    ['ai:model:unknown'],
    ['ai:effort:extra-high'],
  ])('rejects ambiguous or invalid settings %s', (...labels) => {
    expect(() => resolveLabels(labels, config(), 'team/project-a')).toThrow();
  });
  it('waits for the newest model instead of falling back to an idle older version', () => {
    const latest = worker();
    const old = worker();
    old.models[0]!.version = [6, 9];
    old.models[0]!.id = 'gpt-6.9-sol';
    expect(() =>
      selectWorker(
        [
          { worker: latest, active: 1, seenAt: 1000000 },
          { worker: old, active: 0, seenAt: 1000000 },
        ],
        'team/project-a',
        'sol',
        'high',
        1000000,
        config(),
      ),
    ).toThrow('latest_model_workers_busy');
  });
  it.each(['rate_limited', 'auth_required', 'unavailable'] as const)(
    'waits for an unavailable newest model (%s) without using an older version',
    (availability) => {
      const latest = worker(),
        old = worker();
      latest.models[0]!.availability = availability;
      old.models[0]!.version = [6, 9];
      old.models[0]!.id = 'gpt-6.9-sol';
      expect(() =>
        selectWorker(
          [
            { worker: latest, active: 0, seenAt: 1000000 },
            { worker: old, active: 0, seenAt: 1000000 },
          ],
          'team/project-a',
          'sol',
          'high',
          1000000,
          config(),
        ),
      ).toThrow('latest_model_unavailable');
    },
  );
  it('never downgrades a model to satisfy effort', () => {
    const w = worker();
    w.models[0]!.efforts = ['low'];
    expect(() =>
      selectWorker(
        [{ worker: w, active: 0, seenAt: 1000000 }],
        'team/project-a',
        'sol',
        'xhigh',
        1000000,
        config(),
      ),
    ).toThrow('unsupported_effort_or_auto_review');
  });
  it('rejects stale catalogues and absent auto review', () => {
    const w = worker();
    expect(() =>
      selectWorker(
        [{ worker: w, active: 0, seenAt: 5000000 }],
        'team/project-a',
        'sol',
        null,
        5000000,
        config(),
      ),
    ).toThrow();
    w.models[0]!.autoReview = false;
    expect(() =>
      selectWorker(
        [{ worker: w, active: 0, seenAt: 1000000 }],
        'team/project-a',
        'sol',
        null,
        1000000,
        config(),
      ),
    ).toThrow();
  });
});
describe('inputs and output attribution', () => {
  it('recognizes only a command at the first nonempty plain line', () => {
    expect(parseControl('\n /ai stop\n')).toEqual({ kind: 'stop' });
    expect(parseControl('/ai steer change this\nand that')).toEqual({
      kind: 'steer',
      text: 'change this\nand that',
    });
    for (const body of ['> /ai stop', '```\n/ai stop\n```', 'text\n/ai stop', '/ai stopped'])
      expect(parseControl(body)).toBeNull();
  });
  it('does not treat Triage or read permission as Write', () => {
    expect(canWrite({ permission: 'triage' })).toBe(false);
    expect(canWrite({ permission: 'read' })).toBe(false);
    expect(canWrite({ permission: 'maintain' })).toBe(true);
    expect(canWrite({ user: { permissions: { push: true } } })).toBe(true);
  });
  it('closes unfinished fences and HTML comments before attribution', () => {
    expect(renderOutput('```ts\nconst x=1', 'AI-generated', 'abc').body).toContain(
      'const x=1\n```\n\n<!-- forgecrew:managed:start -->',
    );
    expect(renderOutput('hello <!-- open', 'AI-generated', 'abc').body).toContain(
      '<!-- open\n-->\n\n',
    );
  });
  it('renders a managed footer exactly once without deleting quoted text', () => {
    const a = renderOutput('> AI-generated\nhello', 'AI-generated', 'abc');
    const b = renderOutput(a.body, 'New AI-generated', 'abc');
    expect(b.body).toContain('> AI-generated');
    expect(b.body.match(/forgecrew:managed:start/g)).toHaveLength(1);
  });
  it('splits long output with individual markers and bounded size', () => {
    const parts = splitOutput('한글😀'.repeat(20000), 'AI-generated', 'abc', 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.body.length).toBeLessThanOrEqual(1000);
      expect(part.body).toContain(`forgecrew:delivery=${part.id}`);
    }
  });
});
