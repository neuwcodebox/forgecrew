import { describe, expect, it } from 'vitest';
import { invocation } from '../packages/worker/src/cli/options.ts';
import { setupConfiguration } from '../packages/worker/src/cli/setup.ts';
import type { LocalConfig } from '../packages/worker/src/local.ts';

const existing: LocalConfig = {
  schemaVersion: 1,
  id: '98f2c835-1ef3-4ec3-bf33-c122ed386787',
  token: 't'.repeat(48),
  dispatcher: 'https://dispatcher.example',
  hostname: 'github.example',
  maxConcurrentSessions: 2,
  engines: { codex: '/installed/codex' },
};
const options = (...args: string[]) => invocation(args, '/installed/forgecrew').value;

describe('Worker setup configuration contract', () => {
  it('creates a validated identity and enables the explicitly selected engines', () => {
    const config = setupConfiguration(
      options(
        '--dispatcher',
        existing.dispatcher,
        '--hostname',
        existing.hostname,
        '--engine',
        'both',
        '--claude',
        '/installed/claude',
      ),
    );
    expect(config.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(config.token.length).toBeGreaterThanOrEqual(32);
    expect(config.engines).toEqual({ codex: 'codex', claude: '/installed/claude' });
    expect(config.maxConcurrentSessions).toBe(2);
  });
  it('preserves identity and engine paths when reconfiguring the connection and capacity', () => {
    const snapshot = structuredClone(existing);
    const config = setupConfiguration(
      options('--dispatcher', 'https://replacement.example', '--sessions', '3'),
      existing,
    );
    expect(config).toEqual({
      ...existing,
      dispatcher: 'https://replacement.example',
      maxConcurrentSessions: 3,
    });
    expect(existing).toEqual(snapshot);
  });
  it('retains an existing executable when adding another engine and removes deselected engines', () => {
    const both = setupConfiguration(options('--engine', 'both'), existing);
    expect(both.engines).toEqual({ codex: '/installed/codex', claude: 'claude' });
    expect(setupConfiguration(options('--engine', 'claude'), both).engines).toEqual({
      claude: 'claude',
    });
    expect(both.id).toBe(existing.id);
    expect(both.token).toBe(existing.token);
  });
  it('rejects missing or invalid options before a configuration can be saved', () => {
    expect(() => setupConfiguration(options())).toThrow('engine_required');
    expect(() => setupConfiguration(options('--engine', 'unknown'), existing)).toThrow(
      'invalid_engine',
    );
    expect(() => setupConfiguration(options('--sessions', '0'), existing)).toThrow();
    expect(() => setupConfiguration(options('--engine'), existing)).toThrow('missing_option_value');
  });
});
