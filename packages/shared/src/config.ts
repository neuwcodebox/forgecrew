import { parseDocument } from 'yaml';
import { z } from 'zod';
import { hash } from './hash.ts';
import { families, efforts } from './types.ts';

const duration = z
  .string()
  .regex(/^\d+(?:ms|s|m|h)$/)
  .transform((value) => {
    const match = /^(\d+)(ms|s|m|h)$/.exec(value)!;
    return Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]!]!;
  })
  .pipe(
    z
      .number()
      .int()
      .positive()
      .max(2 ** 31 - 1),
  );
const nonempty = z.string().trim().min(1);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const family = z.enum(families);
const effort = z.enum(efforts).nullable();
const defaults = z.strictObject({ model: family.optional(), effort: effort.optional() });
const url = z.url().refine((v) => {
  const u = new URL(v);
  return !u.username && !u.password && !u.search && !u.hash;
});
const visible = z.string().refine(
  (v) =>
    v
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]*>/g, '')
      .trim().length > 0,
);

export const ConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    server: z.strictObject({
      listen: nonempty,
      port: z.number().int().min(1).max(65535),
      dataDir: nonempty,
      configReloadInterval: duration,
    }),
    github: z.strictObject({
      hostname: z.string().regex(/^[a-zA-Z0-9.-]+(?::\d+)?$/),
      apiBaseUrl: url,
      tokenEnv: envName,
      repositories: z
        .array(
          z.strictObject({
            name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
            defaults: defaults.optional(),
          }),
        )
        .min(1),
      polling: z.strictObject({
        interval: duration,
        overlap: duration,
        reconcileInterval: duration,
        maxConcurrentRequests: z.number().int().min(1).max(100),
      }),
      permissionCacheTtl: duration,
    }),
    registration: z.strictObject({ tokenEnv: envName }),
    labels: z.strictObject({
      enabled: nonempty,
      modelPrefix: nonempty,
      effortPrefix: nonempty,
      workerPrefix: nonempty,
      statusPrefix: nonempty,
    }),
    defaults: z.strictObject({ model: family, effort }),
    runtime: z.strictObject({
      heartbeatInterval: duration,
      leaseDuration: duration,
      interruptGrace: duration,
      reassignGrace: duration,
      requestTimeout: duration,
      longPollTimeout: duration,
      configCheckInterval: duration,
      modelCatalogRefreshInterval: duration,
      modelCatalogMaxAge: duration,
      reconnect: z.strictObject({ initialDelay: duration, maxDelay: duration }),
    }),
    updates: z.strictObject({
      registry: url,
      package: z.string().regex(/^(?:@[\w.-]+\/)?[\w.-]+$/),
      channel: z.string().regex(/^[\w.-]+$/),
      checkInterval: duration,
      drainTimeout: duration,
      stabilizationWindow: duration,
      failedVersionCooldown: duration,
    }),
    agent: z.strictObject({ instructions: z.string().refine((v) => v.trim().length > 0) }),
    output: z.strictObject({ attribution: visible, automationAttribution: visible }),
  })
  .superRefine((c, ctx) => {
    const error = (path: string[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (c.runtime.heartbeatInterval * 3 >= c.runtime.leaseDuration)
      error(['runtime', 'leaseDuration'], 'must exceed three heartbeat intervals');
    if (c.runtime.interruptGrace >= c.runtime.reassignGrace)
      error(['runtime', 'reassignGrace'], 'must exceed interrupt grace');
    if (c.runtime.interruptGrace + c.runtime.heartbeatInterval >= c.runtime.leaseDuration)
      error(['runtime', 'leaseDuration'], 'insufficient stop margin');
    if (c.runtime.longPollTimeout >= c.runtime.requestTimeout)
      error(['runtime', 'requestTimeout'], 'must exceed long poll timeout');
    if (c.runtime.reconnect.initialDelay > c.runtime.reconnect.maxDelay)
      error(['runtime', 'reconnect'], 'invalid backoff range');
    if (c.runtime.modelCatalogRefreshInterval > c.runtime.modelCatalogMaxAge)
      error(['runtime', 'modelCatalogMaxAge'], 'must cover refresh interval');
    const labels = Object.values(c.labels);
    if (
      labels.some((a, i) => labels.some((b, j) => i !== j && (a.startsWith(b) || b.startsWith(a))))
    )
      error(['labels'], 'overlapping label names or prefixes');
    const repos = c.github.repositories.map((r) => r.name.toLowerCase());
    if (new Set(repos).size !== repos.length)
      error(['github', 'repositories'], 'duplicate repository');
    const api = new URL(c.github.apiBaseUrl);
    if (
      api.host.toLowerCase() !== c.github.hostname.toLowerCase() &&
      !(c.github.hostname === 'github.com' && api.hostname === 'api.github.com')
    )
      error(['github', 'apiBaseUrl'], 'API host does not match GitHub host');
  });
export type Config = z.output<typeof ConfigSchema>;

export function parseConfig(source: string): Config {
  const doc = parseDocument(source, { version: '1.2', uniqueKeys: true, customTags: [] });
  // Report positions, never input values or prompt/secret-bearing YAML excerpts.
  if (doc.errors.length || doc.warnings.length)
    throw new Error('invalid YAML syntax, tag, or duplicate key');
  const parsed = ConfigSchema.safeParse(doc.toJS({ maxAliasCount: 20 }));
  if (!parsed.success)
    throw new Error(
      'invalid configuration: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  return parsed.data;
}
export function configRevision(config: Config): string {
  return hash(config);
}
export function workerProjection(config: Config) {
  const payload = {
    schemaVersion: 1 as const,
    github: {
      hostname: config.github.hostname,
      repositories: config.github.repositories.map((r) => r.name),
    },
    labels: config.labels,
    runtime: config.runtime,
    updates: config.updates,
    agent: config.agent,
    output: config.output,
  };
  return { configRevision: configRevision(config), payloadHash: hash(payload), payload };
}
export type Projection = ReturnType<typeof workerProjection>;
const milliseconds = z
  .number()
  .int()
  .positive()
  .max(2 ** 31 - 1);
const projectedRuntime = ConfigSchema.shape.runtime.extend({
  heartbeatInterval: milliseconds,
  leaseDuration: milliseconds,
  interruptGrace: milliseconds,
  reassignGrace: milliseconds,
  requestTimeout: milliseconds,
  longPollTimeout: milliseconds,
  configCheckInterval: milliseconds,
  modelCatalogRefreshInterval: milliseconds,
  modelCatalogMaxAge: milliseconds,
  reconnect: z.strictObject({ initialDelay: milliseconds, maxDelay: milliseconds }),
});
const projectedUpdates = ConfigSchema.shape.updates.extend({
  checkInterval: milliseconds,
  drainTimeout: milliseconds,
  stabilizationWindow: milliseconds,
  failedVersionCooldown: milliseconds,
});
const projectionSchema = z.strictObject({
  configRevision: z.string().regex(/^[0-9a-f]{64}$/),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  payload: z.strictObject({
    schemaVersion: z.literal(1),
    github: z.strictObject({
      hostname: ConfigSchema.shape.github.shape.hostname,
      repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)),
    }),
    labels: ConfigSchema.shape.labels,
    runtime: projectedRuntime,
    updates: projectedUpdates,
    agent: ConfigSchema.shape.agent,
    output: ConfigSchema.shape.output,
  }),
});
export function validateProjection(value: unknown): asserts value is Projection {
  const p = projectionSchema.safeParse(value);
  if (!p.success || hash(p.data.payload) !== p.data.payloadHash)
    throw new Error('invalid config projection');
  const r = p.data.payload.runtime;
  if (
    r.heartbeatInterval * 3 >= r.leaseDuration ||
    r.interruptGrace >= r.reassignGrace ||
    r.longPollTimeout >= r.requestTimeout
  )
    throw new Error('invalid config projection');
}
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
