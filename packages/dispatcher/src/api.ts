import { Hono } from 'hono';
import { setTimeout as delay } from 'node:timers/promises';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { configRevision, workerProjection } from '../../shared/src/config.ts';
import type { ConfigManager } from '../../shared/src/config.ts';
import { secretEqual } from '../../shared/src/hash.ts';
import { ContractError, efforts, families } from '../../shared/src/types.ts';
import type { Store } from './storage/index.ts';
import type { Preflight } from './storage/index.ts';
import type { WorkClaim } from '../../shared/src/protocol.ts';

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
const identity = z.strictObject({
  attemptId: z.string().uuid(),
  generation: z.number().int().positive(),
});
const completed = identity.extend({
  result: z.strictObject({
    kind: z.enum(['completed', 'needs_reply', 'failed']),
    text: z.string().min(1).max(2000000),
    links: z.array(z.url()).max(100).optional(),
    origin: z.enum(['ai', 'runtime']).optional(),
  }),
});

export function createApp(
  store: Store,
  configs: ConfigManager,
  registrationToken: string,
  verifyInput?: (claim: WorkClaim) => Promise<Preflight>,
) {
  const app = new Hono<{ Variables: { worker: string } }>();
  app.use('*', bodyLimit({ maxSize: 4 * 1024 * 1024 }));
  app.onError((error, c) => {
    if (error instanceof ContractError) return c.json({ error: error.code }, error.status as 400);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: 'invalid_request' }, 400);
    // Errors can contain request payloads or tokens; only a fixed code is exposed.
    return c.json({ error: 'internal_error' }, 500);
  });
  app.get('/health/live', (c) => c.json({ live: true }));
  app.get('/health/ready', (c) =>
    c.json({
      ready: true,
      configRevision: configRevision(configs.current),
      configError: configs.lastError,
    }),
  );
  app.post('/v1/register', async (c) => {
    if (!secretEqual(c.req.header('Authorization') ?? '', 'Bearer ' + registrationToken))
      throw new ContractError('unauthorized', 401);
    const request = z
      .strictObject({ capabilities: capabilitiesSchema, token: z.string().min(32).max(200) })
      .parse(await c.req.json());
    store.workers.register(request.capabilities, request.token);
    return c.json({ protocolVersion: 1, configRevision: configRevision(configs.current) });
  });
  app.use('/v1/*', async (c, next) => {
    const worker = c.req.header('X-ForgeCrew-Worker') ?? '';
    const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
    if (!store.workers.authenticate(worker, bearer)) throw new ContractError('unauthorized', 401);
    c.set('worker', worker);
    await next();
  });
  app.get('/v1/status', (c) =>
    c.json({
      ...store.diagnostics.status(c.get('worker')),
      configRevision: configRevision(configs.current),
      configError: configs.lastError,
    }),
  );
  app.get('/v1/config/:revision', (c) => {
    const projection = workerProjection(store.configs.get(c.req.param('revision')));
    if (c.req.header('If-None-Match') === '"' + projection.payloadHash + '"')
      return c.body(null, 304);
    c.header('ETag', '"' + projection.payloadHash + '"');
    return c.json(projection);
  });
  app.post('/v1/heartbeat', async (c) => {
    const capabilities = capabilitiesSchema.parse(await c.req.json());
    store.workers.heartbeat(c.get('worker'), capabilities);
    return c.json({
      configRevision: configRevision(configs.current),
      controls: store.executions.pendingControls(c.get('worker')),
    });
  });
  app.post('/v1/claim', async (c) => {
    const deadline =
      Date.now() + (c.req.query('wait') === '1' ? configs.current.runtime.longPollTimeout : 0);
    let claim;
    do {
      if (c.req.raw.signal.aborted) break;
      claim = store.executions.claim(c.get('worker'), configs.current);
      if (claim || Date.now() >= deadline || store.deliveries.hasPending(c.get('worker'))) break;
      await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, {
        signal: c.req.raw.signal,
      }).catch(() => {});
    } while (!c.req.raw.signal.aborted);
    claim ??= null;
    if (claim && verifyInput) {
      let decision: Preflight;
      try {
        decision = await verifyInput(claim);
      } catch {
        store.executions.preflight(claim.attemptId, c.get('worker'), claim.generation, {
          status: 'hold',
          reason: 'input_verification_unavailable',
        });
        throw new ContractError('input_verification_unavailable', 503);
      }
      if (!store.executions.preflight(claim.attemptId, c.get('worker'), claim.generation, decision))
        return c.json({ claim: null });
    }
    return c.json({ claim });
  });
  app.post('/v1/renew', async (c) => {
    const r = identity.parse(await c.req.json());
    return c.json(store.executions.renew(r.attemptId, c.get('worker'), r.generation));
  });
  app.post('/v1/complete', async (c) => {
    const r = completed.parse(await c.req.json());
    return c.json({
      deliveries: store.executions.complete(r.attemptId, c.get('worker'), r.generation, r.result),
    });
  });
  app.post('/v1/cancel', async (c) => {
    const r = identity.parse(await c.req.json());
    store.executions.cancel(r.attemptId, c.get('worker'), r.generation);
    return c.json({ ok: true });
  });
  app.post('/v1/release', async (c) => {
    const r = identity.parse(await c.req.json());
    store.executions.release(r.attemptId, c.get('worker'), r.generation);
    return c.json({ ok: true });
  });
  app.post('/v1/steer-restart', async (c) => {
    const r = identity
      .extend({ controlId: z.string().regex(/^[0-9a-f]{64}$/) })
      .parse(await c.req.json());
    return c.json({
      claim: store.executions.restartSteer(r.attemptId, c.get('worker'), r.generation, r.controlId),
    });
  });
  app.post('/v1/controls/:id/ack', (c) => {
    store.executions.ackControl(c.get('worker'), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/v1/deliveries/claim', (c) =>
    c.json({
      delivery: store.deliveries.claim(c.get('worker'), configs.current.runtime.leaseDuration),
    }),
  );
  app.post('/v1/deliveries/:id/renew', (c) =>
    c.json(store.deliveries.renew(c.get('worker'), c.req.param('id'))),
  );
  app.post('/v1/deliveries/:id/begin', (c) => {
    store.deliveries.beginPost(c.get('worker'), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/v1/deliveries/:id/receipt', async (c) => {
    const r = z.strictObject({ githubId: z.string().regex(/^\d+$/) }).parse(await c.req.json());
    store.deliveries.receipt(c.get('worker'), c.req.param('id'), r.githubId);
    return c.json({ ok: true });
  });
  return app;
}
