import { hash } from '../hash.ts';
import { parseConfig } from './schema.ts';
import type { Config } from './schema.ts';
import { configRevision } from './projection.ts';

export function restartKey(c: Config): string {
  return hash([
    c.server.listen,
    c.server.port,
    c.server.dataDir,
    c.github.hostname,
    c.github.apiBaseUrl,
    c.github.tokenEnv,
    c.registration.tokenEnv,
  ]);
}
export class ConfigManager {
  current: Config;
  lastError: string | null = null;
  readonly persist: (config: Config) => void;
  constructor(source: string, persist: (config: Config) => void = () => {}) {
    this.persist = persist;
    this.current = parseConfig(source);
    persist(this.current);
  }
  reload(source: string): boolean {
    try {
      const next = parseConfig(source);
      if (restartKey(next) !== restartKey(this.current))
        throw new Error('configuration requires Dispatcher restart');
      if (configRevision(next) !== configRevision(this.current)) {
        this.persist(next);
        this.current = next;
      }
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'invalid configuration';
      return false;
    }
  }
}
