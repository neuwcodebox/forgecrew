import { z } from 'zod';
import { hash } from '../hash.ts';
import { ConfigSchema } from './schema.ts';
import type { Config } from './schema.ts';

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
