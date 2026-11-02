import { z } from 'zod';
import { efforts, families } from '../../../shared/src/types.ts';

const model = z.strictObject({
  family: z.enum(families),
  id: z.string().min(1).max(200),
  version: z.array(z.number().int().nonnegative()).min(1).max(8),
  efforts: z.array(z.enum(efforts)),
  defaultEffort: z.enum(efforts).nullable(),
  engine: z.enum(['codex', 'claude']),
  autoReview: z.boolean(),
  availability: z.enum(['ready', 'auth_required', 'rate_limited', 'unavailable']),
  observedAt: z.number().int().nonnegative(),
  runtimeVersion: z.string().max(100),
});
export const capabilitiesSchema = z.strictObject({
  id: z.string().uuid(),
  githubLogin: z.string().min(1).max(100),
  githubId: z.string().regex(/^\d+$/),
  version: z.string().min(1).max(100),
  schemaVersions: z.array(z.number().int().positive()).max(10),
  maxConcurrentSessions: z.number().int().min(1).max(100),
  repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(1000),
  models: z.array(model).max(1000),
  draining: z.boolean(),
  configRevision: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export const attemptIdentity = z.strictObject({
  attemptId: z.string().uuid(),
  generation: z.number().int().positive(),
});
export const completedRequest = attemptIdentity.extend({
  result: z.strictObject({
    kind: z.enum(['completed', 'needs_reply', 'failed']),
    text: z.string().min(1).max(2000000),
    links: z.array(z.url()).max(100).optional(),
    origin: z.enum(['ai', 'runtime']).optional(),
  }),
});
