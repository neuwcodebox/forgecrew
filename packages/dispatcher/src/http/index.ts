import { Hono } from 'hono';
import { setTimeout as delay } from 'node:timers/promises';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { configRevision, workerProjection } from '../../../shared/src/config/index.ts';
import type { ConfigManager } from '../../../shared/src/config/index.ts';
import { secretEqual } from '../../../shared/src/hash.ts';
import { ContractError } from '../../../shared/src/types.ts';
import type { Store } from '../storage/index.ts';
import type { Preflight } from '../storage/index.ts';
import type { WorkClaim } from '../../../shared/src/protocol.ts';

import { capabilitiesSchema, attemptIdentity, completedRequest } from './schemas.ts';

type HttpStorage = Pick<Store, 'workers' | 'diagnostics' | 'configs' | 'executions' | 'deliveries'>;

export function createApp(
  store: HttpStorage,
  configs: Pick<ConfigManager, 'current' | 'lastError'>,
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
    const request = attemptIdentity.parse(await c.req.json());
    return c.json(store.executions.renew(request.attemptId, c.get('worker'), request.generation));
  });
  app.post('/v1/complete', async (c) => {
    const request = completedRequest.parse(await c.req.json());
    return c.json({
      deliveries: store.executions.complete(
        request.attemptId,
        c.get('worker'),
        request.generation,
        request.result,
      ),
    });
  });
  app.post('/v1/cancel', async (c) => {
    const request = attemptIdentity.parse(await c.req.json());
    store.executions.cancel(request.attemptId, c.get('worker'), request.generation);
    return c.json({ ok: true });
  });
  app.post('/v1/release', async (c) => {
    const request = attemptIdentity.parse(await c.req.json());
    store.executions.release(request.attemptId, c.get('worker'), request.generation);
    return c.json({ ok: true });
  });
  app.post('/v1/steer-restart', async (c) => {
    const request = attemptIdentity
      .extend({ controlId: z.string().regex(/^[0-9a-f]{64}$/) })
      .parse(await c.req.json());
    return c.json({
      claim: store.executions.restartSteer(
        request.attemptId,
        c.get('worker'),
        request.generation,
        request.controlId,
      ),
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
    const request = z
      .strictObject({ githubId: z.string().regex(/^\d+$/) })
      .parse(await c.req.json());
    store.deliveries.receipt(c.get('worker'), c.req.param('id'), request.githubId);
    return c.json({ ok: true });
  });
  return app;
}
