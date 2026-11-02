import { parseDocument } from 'yaml';
import { z } from 'zod';
import { families, efforts } from '../types.ts';

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
