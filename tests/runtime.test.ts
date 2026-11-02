import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../packages/dispatcher/src/storage/index.ts';
import { createApp } from '../packages/dispatcher/src/api.ts';
import { ConfigManager } from '../packages/shared/src/config.ts';
import { configSource, worker } from './helpers.ts';
import { DispatcherClient } from '../packages/worker/src/client.ts';
import { WorkerRuntime } from '../packages/worker/src/runtime.ts';
import { GhClient } from '../packages/worker/src/github.ts';
import { acquireLock } from '../packages/worker/src/lock.ts';
import { hash } from '../packages/shared/src/hash.ts';
import type { LocalConfig } from '../packages/worker/src/local.ts';
import type { DeliveryClaim, WorkClaim } from '../packages/shared/src/protocol.ts';
import type { Result } from '../packages/shared/src/types.ts';
import type { Provider, ProviderRun, RunRequest } from '../packages/worker/src/providers/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
class FakeGithub extends GhClient {
  posted: { id: number; body: string; user: { id: number; login: string } }[] = [];
  attempts = 0;
  losePostResponse = false;
  accountId = 123;
  accountLogin = 'coworker';
  readonly dir: string;
  constructor(host: string, dir: string) {
    super(host);
    this.dir = dir;
  }
  override async account() {
    return { id: this.accountId, login: this.accountLogin };
  }
  override async repositories(names: string[]) {
    return names;
  }
  override async context(_claim: WorkClaim, _signal?: AbortSignal) {
    return 'conversation from GitHub';
  }
  override async workspace() {
    return this.dir;
  }
  override async findDelivery(d: DeliveryClaim) {
    return this.posted.find(
      (p) => hash(p.body) === d.body_hash && d.authors.includes(String(p.user.id)),
    );
  }
  override async post(d: DeliveryClaim, _signal?: AbortSignal) {
    this.attempts++;
    const comment = {
      id: this.attempts,
      body: d.body,
      user: { id: this.accountId, login: this.accountLogin },
    };
    this.posted.push(comment);
    if (this.losePostResponse) {
      this.losePostResponse = false;
      throw new Error('post_response_lost');
    }
    return { id: comment.id, html_url: 'https://github.example/internal/comment' };
  }
}
class FakeProvider implements Provider {
  requests: RunRequest[] = [];
  factory: (r: RunRequest) => ProviderRun;
  constructor() {
    this.factory = (r) => ({
      result: r
        .onSession({
          id: 'provider_session_1',
          engine: r.claim.runConfig.engine,
          workspace: r.workspace,
        })
        .then(() => ({ kind: 'completed', text: 'answer' })),
      interrupt: async () => {},
      steer: async () => {},
      close: async () => {},
    });
  }
  async probe() {
    return worker(Date.now()).models;
  }
  run(request: RunRequest) {
    this.requests.push(request);
    return this.factory(request);
  }
}
async function setup(
  options: { loseCompletion?: boolean; engine?: 'codex' | 'claude'; secondEngine?: boolean } = {},
) {
  let offset = 0;
  const s = new Store(':memory:', () => Date.now() + offset);
  cleanup.push(async () => s.close());
  const configs = new ConfigManager(configSource, (c) => s.configs.save(c));
  const app = createApp(s, configs, 'r'.repeat(48));
  const dir = await mkdtemp(join(tmpdir(), 'forgecrew-runtime-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const local: LocalConfig = {
    schemaVersion: 1,
    id: randomUUID(),
    token: 't'.repeat(48),
    dispatcher: 'http://localhost',
    hostname: configs.current.github.hostname,
    maxConcurrentSessions: 1,
    engines:
      options.engine === 'claude'
        ? { claude: 'fixture' }
        : { codex: 'fixture', ...(options.secondEngine ? { claude: 'fixture' } : {}) },
  };
  const transport: {
    config?: ((url: string, response: Response) => Promise<Response>) | undefined;
    heartbeat?: ((url: string, response: Response) => Promise<Response>) | undefined;
  } = {};
  let lose = options.loseCompletion ?? false;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await app.request(new Request(input, init));
    if (String(input).endsWith('/v1/heartbeat') && transport.heartbeat)
      return transport.heartbeat(String(input), response);
    if (String(input).includes('/v1/config/') && transport.config)
      return transport.config(String(input), response);
    if (lose && String(input).endsWith('/v1/complete')) {
      lose = false;
      throw new Error('completion_ack_lost');
    }
    return response;
  };
  const provider = new FakeProvider();
  if (options.engine === 'claude')
    provider.probe = async () => [
      {
        ...worker(Date.now()).models[0]!,
        engine: 'claude',
        family: 'opus',
        id: 'claude-opus-5-5',
        version: [5, 5],
      },
    ];
  const secondProvider = new FakeProvider();
  secondProvider.probe = async () => [
    {
      ...worker(Date.now()).models[0]!,
      engine: 'claude',
      family: 'opus',
      id: 'claude-opus-5-5',
      version: [5, 5],
    },
  ];
  const github = new FakeGithub(local.hostname, dir);
  const logs: Record<string, unknown>[] = [];
  const runtime = new WorkerRuntime(local, dir, {
    logger: (r) => logs.push(r),
    client: new DispatcherClient(local, fetcher),
    github,
    providers: {
      [options.engine ?? 'codex']: provider,
      ...(options.secondEngine ? { claude: secondProvider } : {}),
    },
  });
  cleanup.push(() => runtime.settleControls());
  const key = {
    host: local.hostname,
    repository: 'team/project-a',
    kind: 'issue' as const,
    number: 1,
  };
  const id = s.sessions.upsert(
    key,
    options.engine === 'claude' ? ['ai:enabled', 'ai:model:opus'] : ['ai:enabled'],
    true,
    Date.now(),
    'request',
    'writer',
  );
  await runtime.initialize('r'.repeat(48));
  const peer = async () => {
    const peerLocal = { ...local, id: randomUUID(), token: 'p'.repeat(48) },
      peerDir = join(dir, 'peer'),
      peerGithub = new FakeGithub(local.hostname, peerDir),
      peerProvider = new FakeProvider();
    peerGithub.accountId = 456;
    peerGithub.accountLogin = 'peer';
    peerGithub.posted = github.posted;
    const peerRuntime = new WorkerRuntime(peerLocal, peerDir, {
      logger: (r) => logs.push(r),
      client: new DispatcherClient(peerLocal, fetcher),
      github: peerGithub,
      providers: { codex: peerProvider },
    });
    cleanup.push(() => peerRuntime.settleControls());
    await peerRuntime.initialize('r'.repeat(48));
    return { runtime: peerRuntime, provider: peerProvider, github: peerGithub, local: peerLocal };
  };
  return {
    s,
    configs,
    dir,
    local,
    runtime,
    provider,
    secondProvider,
    github,
    id,
    key,
    peer,
    logs,
    transport,
    tick: (ms: number) => {
      offset += ms;
    },
  };
}
describe('Dispatcher and Worker integration', () => {
  it('claims, executes, journals and publishes, then resumes with the next central instructions', async () => {
    const f = await setup();
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    await f.runtime.work();
    expect(f.provider.requests).toHaveLength(1);
    expect(f.github.posted).toHaveLength(1);
    expect(f.github.posted[0]!.body).toContain('AI-generated');
    expect(await readdir(join(f.dir, 'journal'))).toEqual([]);
    expect(
      f.configs.reload(
        configSource.replace(
          '응답은 현재 대화의 언어로',
          'NEW INSTRUCTIONS. 응답은 현재 대화의 언어로',
        ),
      ),
    ).toBe(true);
    f.s.sessions.enqueue(f.id, 'comment', '42', 'next request', 'writer', Date.now() + 1);
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    expect(f.provider.requests[1]!.resume?.id).toBe('provider_session_1');
    expect(f.provider.requests[1]!.claim.runConfig.payload.agent.instructions).toContain(
      'NEW INSTRUCTIONS.',
    );
  });
  it('retries lost completion acknowledgement without rerunning the Provider', async () => {
    const f = await setup({ loseCompletion: true });
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    expect(await readdir(join(f.dir, 'journal'))).toHaveLength(1);
    await f.runtime.work();
    expect(f.provider.requests).toHaveLength(1);
    expect(f.github.posted).toHaveLength(1);
  });
  it('reconciles a lost GitHub post response and publishes exactly one comment in the fixture', async () => {
    const f = await setup();
    f.github.losePostResponse = true;
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    await expect(f.runtime.work()).rejects.toThrow('post_response_lost');
    f.tick(f.configs.current.runtime.leaseDuration + 1);
    await f.runtime.work();
    expect(f.github.attempts).toBe(1);
    expect(f.s.sqlite.prepare('SELECT status FROM deliveries').get()).toEqual({ status: 'posted' });
  });
  it('stops the current turn and retains the queued follow-up', async () => {
    const f = await setup();
    const started = deferred<void>(),
      pending = deferred<Result>();
    f.provider.factory = () => ({
      result: pending.promise,
      interrupt: async () => {
        pending.reject(new Error('provider_interrupted'));
      },
      steer: async () => {},
      close: async () => {},
    });
    const old = f.provider.run.bind(f.provider);
    f.provider.run = (r) => {
      const result = old(r);
      started.resolve();
      return result;
    };
    await f.runtime.work();
    await started.promise;
    const a = [...f.runtime.active.values()][0]!;
    f.s.sessions.enqueue(f.id, 'comment', 'next', 'follow-up', 'writer', Date.now() + 1);
    f.s.executions.addControl(f.id, 'stop_comment', { kind: 'stop' }, Date.now());
    await f.runtime.heartbeat();
    await a.task;
    await f.runtime.settleControls();
    expect(f.s.sqlite.prepare('SELECT status FROM turns WHERE id=?').get(a.claim.turnId)).toEqual({
      status: 'cancelled',
    });
    expect(f.s.sqlite.prepare("SELECT status FROM inputs WHERE source_id='next'").get()).toEqual({
      status: 'queued',
    });
  });
  it('interrupts Claude then resumes the same logical turn with a new Attempt and steering', async () => {
    const f = await setup({ engine: 'claude' });
    const first = deferred<void>(),
      second = deferred<void>(),
      pending = deferred<Result>();
    let count = 0;
    f.provider.factory = (r) => {
      if (++count === 1) {
        first.resolve();
        return {
          result: pending.promise,
          interrupt: async () => {
            pending.reject(new Error('provider_interrupted'));
          },
          steer: async () => {},
          close: async () => {},
        };
      }
      second.resolve();
      return {
        result: Promise.resolve({ kind: 'completed', text: 'steered answer' }),
        interrupt: async () => {},
        steer: async () => {},
        close: async () => {},
      };
    };
    await f.runtime.work();
    await first.promise;
    const previous = f.provider.requests[0]!.claim;
    f.s.executions.addControl(
      f.id,
      'steer_comment',
      { kind: 'steer', text: 'use SSO' },
      Date.now(),
    );
    await f.runtime.heartbeat();
    await second.promise;
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    await f.runtime.settleControls();
    const next = f.provider.requests[1]!.claim;
    expect(next.turnId).toBe(previous.turnId);
    expect(next.generation).toBe(previous.generation + 1);
    expect(next.steering?.[0]?.text).toBe('use SSO');
    expect(f.s.sqlite.prepare('SELECT COUNT(*) AS n FROM turns').get()).toEqual({ n: 1 });
  });
  it('refuses a forged run snapshot before invoking a Provider', async () => {
    const f = await setup();
    const claim = f.s.executions.claim(f.local.id, f.configs.current)!;
    claim.runConfig.payload.agent.instructions = 'tampered';
    expect(() => f.runtime.start(claim)).toThrow();
    expect(f.provider.requests).toHaveLength(0);
  });
  it('keeps a single local process owner per Worker identity', async () => {
    const f = await setup();
    const path = join(f.dir, 'worker.lock');
    const release = await acquireLock(path);
    await expect(acquireLock(path)).rejects.toThrow('worker_already_running');
    await release();
    const next = await acquireLock(path);
    await next();
  });
  it('drains at the current Turn boundary while retaining queued inputs and pending delivery', async () => {
    const f = await setup(),
      started = deferred<void>(),
      result = deferred<Result>();
    f.provider.factory = () => {
      started.resolve();
      return {
        result: result.promise,
        interrupt: async () => {},
        steer: async () => {},
        close: async () => {},
      };
    };
    await f.runtime.work();
    await started.promise;
    f.s.sessions.enqueue(f.id, 'comment', 'next', 'follow-up', 'writer', Date.now() + 1);
    const draining = f.runtime.drain(60000);
    result.resolve({ kind: 'completed', text: 'finished before update' });
    await draining;
    await f.runtime.work();
    expect(f.provider.requests).toHaveLength(1);
    expect(f.github.posted).toHaveLength(1);
    expect(f.s.sqlite.prepare("SELECT status FROM inputs WHERE source_id='next'").get()).toEqual({
      status: 'queued',
    });
  });
  it('releases an interrupted Turn for recovery when the update drain deadline is reached', async () => {
    const f = await setup(),
      started = deferred<void>(),
      result = deferred<Result>();
    f.provider.factory = () => {
      started.resolve();
      return {
        result: result.promise,
        interrupt: async () => {
          result.reject(new Error('provider_interrupted'));
        },
        steer: async () => {},
        close: async () => {},
      };
    };
    await f.runtime.work();
    await started.promise;
    const claim = f.provider.requests[0]!.claim;
    await f.runtime.drain(0);
    expect(f.runtime.active.size).toBe(0);
    expect(f.s.sqlite.prepare('SELECT status FROM turns WHERE id=?').get(claim.turnId)).toEqual({
      status: 'recovering',
    });
    expect(f.github.posted).toHaveLength(0);
  });

  it('recovers posting on another account without replaying completed Provider work', async () => {
    const f = await setup({ loseCompletion: true });
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    // The accepted completion survives even if its ACK and original process are lost.
    const peer = await f.peer();
    await peer.runtime.work();
    expect(peer.provider.requests).toHaveLength(0);
    expect(peer.github.attempts).toBe(1);
    expect(peer.github.posted[0]!.user.id).toBe(456);
    await f.runtime.flushResults();
    expect(await readdir(join(f.dir, 'journal'))).toEqual([]);
    expect(f.provider.requests).toHaveLength(1);
  });
  it('reconciles an uncertain previous account post before another Worker publishes', async () => {
    const f = await setup();
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    f.github.losePostResponse = true;
    await expect(f.runtime.work()).rejects.toThrow('post_response_lost');
    f.tick(f.configs.current.runtime.leaseDuration + 1);
    const peer = await f.peer();
    await peer.runtime.work();
    expect(peer.github.attempts).toBe(0);
    expect(peer.provider.requests).toHaveLength(0);
    expect(f.github.posted).toHaveLength(1);
    expect(f.s.sqlite.prepare('SELECT status FROM deliveries').get()).toEqual({ status: 'posted' });
  });
  it('keeps a rate-limited request recoverable and prevents new execution until the engine recovers', async () => {
    const f = await setup();
    f.provider.factory = () => ({
      result: Promise.reject(new Error('codex_rate_limited')),
      interrupt: async () => {},
      steer: async () => {},
      close: async () => {},
    });
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    await f.runtime.work();
    expect(f.provider.requests).toHaveLength(1);
    expect(f.github.posted).toHaveLength(0);
    expect(f.s.sqlite.prepare('SELECT status FROM turns').get()).toEqual({ status: 'recovering' });
    expect(f.s.sessions.get(f.id)?.blocked_reason).toBe('latest_model_unavailable');
    f.provider.factory = () => ({
      result: Promise.resolve({ kind: 'completed', text: 'recovered' }),
      interrupt: async () => {},
      steer: async () => {},
      close: async () => {},
    });
    await f.runtime.refreshCapabilities();
    await f.runtime.heartbeat();
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    expect(f.provider.requests[1]!.claim.turnId).toBe(f.provider.requests[0]!.claim.turnId);
  });
  it('preserves the last known engine catalogue when a refresh loses authentication', async () => {
    const f = await setup();
    f.provider.probe = async () => {
      throw new Error('codex_auth_required');
    };
    await f.runtime.refreshCapabilities();
    await f.runtime.heartbeat();
    const stored = f.s.sqlite
      .prepare('SELECT capabilities FROM workers WHERE id=?')
      .get(f.local.id) as { capabilities: string };
    expect(JSON.parse(stored.capabilities).models[0]).toMatchObject({
      id: 'gpt-6.10-sol',
      availability: 'auth_required',
    });
    expect(f.s.executions.claim(f.local.id, f.configs.current)).toBeNull();
  });

  it('issues one owner under competing Claims and isolates stop across two concurrent sessions', async () => {
    const f = await setup(),
      peer = await f.peer(),
      first = deferred<Result>(),
      second = deferred<Result>(),
      firstStarted = deferred<void>(),
      secondStarted = deferred<void>();
    f.provider.factory = () => {
      firstStarted.resolve();
      return {
        result: first.promise,
        interrupt: async () => {
          first.reject(new Error('provider_interrupted'));
        },
        steer: async () => {},
        close: async () => {},
      };
    };
    peer.provider.factory = () => {
      secondStarted.resolve();
      return {
        result: second.promise,
        interrupt: async () => {
          second.reject(new Error('provider_interrupted'));
        },
        steer: async () => {},
        close: async () => {},
      };
    };
    try {
      await Promise.all([f.runtime.work(), peer.runtime.work()]);
      expect(f.runtime.active.size + peer.runtime.active.size).toBe(1);
      f.s.sessions.upsert(
        { ...f.key, number: 2 },
        ['ai:enabled'],
        true,
        Date.now(),
        'independent session',
        'writer',
      );
      await Promise.all([f.runtime.work(), peer.runtime.work()]);
      expect(f.runtime.active.size).toBe(1);
      expect(peer.runtime.active.size).toBe(1);
      await Promise.all([firstStarted.promise, secondStarted.promise]);
      const claim = f.provider.requests[0]!.claim;
      f.s.executions.addControl(
        claim.session.id,
        'stop_first_worker',
        { kind: 'stop' },
        Date.now(),
      );
      await f.runtime.heartbeat();
      await f.runtime.settleControls();
      expect(f.runtime.active.size).toBe(0);
      expect(peer.runtime.active.size).toBe(1);
      expect(
        f.s.sqlite.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status='running'").get(),
      ).toEqual({ n: 1 });
    } finally {
      first.resolve({ kind: 'completed', text: 'first' });
      second.resolve({ kind: 'completed', text: 'second' });
      await Promise.all(
        [...f.runtime.active.values(), ...peer.runtime.active.values()].map((a) => a.task),
      );
    }
  });
  it('preserves a late old Worker result without overwriting the recovered generation', async () => {
    const f = await setup(),
      pending = deferred<Result>();
    f.provider.factory = () => ({
      result: pending.promise,
      interrupt: async () => {},
      steer: async () => {},
      close: async () => {},
    });
    await f.runtime.work();
    const old = [...f.runtime.active.values()][0]!;
    f.tick(f.configs.current.runtime.leaseDuration + f.configs.current.runtime.reassignGrace + 1);
    const peer = await f.peer();
    await peer.runtime.work();
    await Promise.all([...peer.runtime.active.values()].map((a) => a.task));
    pending.resolve({ kind: 'completed', text: 'late stale answer' });
    await old.task;
    expect(peer.provider.requests[0]!.claim.turnId).toBe(old.claim.turnId);
    expect(peer.provider.requests[0]!.claim.generation).toBe(2);
    expect(await readdir(join(f.dir, 'rejected-results'))).toContain(old.claim.attemptId + '.json');
    const delivery = f.s.sqlite.prepare('SELECT body FROM deliveries').get() as { body: string };
    expect(delivery.body).not.toContain('late stale answer');
  });

  it('renews delivery ownership independently while a GitHub post is in flight', async () => {
    const f = await setup();
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    const started = deferred<void>(),
      finish = deferred<void>(),
      post = f.github.post.bind(f.github);
    f.github.post = async (d) => {
      started.resolve();
      await finish.promise;
      return post(d);
    };
    const work = f.runtime.work();
    await started.promise;
    try {
      f.tick(f.configs.current.runtime.leaseDuration * 0.7);
      await f.runtime.heartbeat();
      f.tick(f.configs.current.runtime.leaseDuration * 0.4);
      const peer = await f.peer();
      await peer.runtime.work();
      expect(peer.github.attempts).toBe(0);
      expect(peer.provider.requests).toHaveLength(0);
    } finally {
      finish.resolve();
      await work;
    }
    expect(f.github.posted).toHaveLength(1);
  });
  it.each(['shutdown', 'lease_loss'])(
    'cancels an in-flight GitHub command on %s and recovers posting without replaying AI work',
    async (reason) => {
      const f = await setup();
      await f.runtime.work();
      await Promise.all([...f.runtime.active.values()].map((a) => a.task));
      const started = deferred<void>(),
        controller = new AbortController();
      f.github.post = async (_d, signal) => {
        started.resolve();
        return new Promise((_r, reject) =>
          signal!.addEventListener('abort', () => reject(new Error('post_aborted')), {
            once: true,
          }),
        );
      };
      const work = f.runtime.work(controller.signal);
      const failed = expect(work).rejects.toThrow('post_aborted');
      await started.promise;
      if (reason === 'shutdown') controller.abort();
      else {
        f.tick(f.configs.current.runtime.leaseDuration + 1);
        await f.runtime.heartbeat();
      }
      await failed;
      f.tick(f.configs.current.runtime.leaseDuration + 1);
      const peer = await f.peer();
      await peer.runtime.work();
      expect(peer.github.posted).toHaveLength(1);
      expect(peer.provider.requests).toHaveLength(0);
      expect(f.provider.requests).toHaveLength(1);
    },
  );
  it('refuses a new post after the local GitHub account changes until capabilities are refreshed', async () => {
    const f = await setup();
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    f.github.accountId = 999;
    await expect(f.runtime.work()).rejects.toThrow('github_identity_changed');
    expect(f.github.posted).toHaveLength(0);
    await f.runtime.refreshCapabilities();
    await f.runtime.heartbeat();
    f.tick(f.configs.current.runtime.leaseDuration + 1);
    await f.runtime.work();
    expect(f.github.posted[0]!.user.id).toBe(999);
    expect(f.provider.requests).toHaveLength(1);
  });

  it('continues the other enabled engine after one engine reaches its usage limit', async () => {
    const f = await setup({ secondEngine: true });
    f.provider.factory = () => ({
      result: Promise.reject(new Error('codex_rate_limited')),
      interrupt: async () => {},
      steer: async () => {},
      close: async () => {},
    });
    f.s.sessions.upsert(
      { ...f.key, number: 2 },
      ['ai:enabled', 'ai:model:opus'],
      true,
      Date.now(),
      'Claude request',
      'writer',
    );
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    expect(f.provider.requests).toHaveLength(1);
    expect(f.secondProvider.requests).toHaveLength(1);
    expect(f.secondProvider.requests[0]!.claim.runConfig.engine).toBe('claude');
  });

  it('cancels GitHub preparation at the drain deadline before starting any Provider', async () => {
    const f = await setup(),
      started = deferred<void>();
    f.github.context = async (_claim, signal) => {
      started.resolve();
      return new Promise((_r, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('context_aborted')), {
          once: true,
        }),
      );
    };
    await f.runtime.work();
    await started.promise;
    await f.runtime.drain(0);
    expect(f.provider.requests).toHaveLength(0);
    expect(f.runtime.active.size).toBe(0);
    expect(f.s.sqlite.prepare('SELECT status FROM turns').get()).toEqual({ status: 'recovering' });
  });
  it('preserves a request through a GitHub read outage instead of consuming it as an AI failure', async () => {
    const f = await setup();
    f.github.context = async () => {
      throw new Error('github_request_failed');
    };
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    await f.runtime.work();
    expect(f.provider.requests).toHaveLength(0);
    expect(f.github.posted).toHaveLength(0);
    expect(f.s.sqlite.prepare('SELECT status FROM turns').get()).toEqual({ status: 'recovering' });
  });

  it('logs execution identifiers and applied revisions without logging prompt or token values', async () => {
    const f = await setup();
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    const claim = f.provider.requests[0]!.claim;
    expect(f.logs.find((r) => r.event === 'attempt_started')).toMatchObject({
      workerId: f.local.id,
      attemptId: claim.attemptId,
      sessionId: f.id,
      turnId: claim.turnId,
      configRevision: claim.runConfig.configRevision,
      model: claim.runConfig.model,
    });
    expect(JSON.stringify(f.logs)).not.toContain(f.local.token);
    expect(JSON.stringify(f.logs)).not.toContain(claim.runConfig.payload.agent.instructions);
    const status = await f.runtime.client.request<{ worker: { configRevision: string } }>(
      '/v1/status',
      undefined,
      { method: 'GET' },
    );
    expect(status.worker.configRevision).toBe(claim.runConfig.configRevision);
  });

  it('reports an observable PR attribution warning after durably accepting the completed answer', async () => {
    const f = await setup();
    f.github.verifyOutput = async () => [99];
    await f.runtime.work();
    await Promise.all([...f.runtime.active.values()].map((a) => a.task));
    expect(f.s.sqlite.prepare('SELECT status FROM turns').get()).toEqual({ status: 'completed' });
    expect(
      f.logs.some((r) => r.event === 'output_attribution_missing' && r.pullNumber === 99),
    ).toBe(true);
    expect(f.s.sqlite.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 1 });
  });

  it.each(['download', 'heartbeat'])(
    'keeps the newest requested revision when an older %s response finishes later',
    async (mode) => {
      const f = await setup(),
        entered = deferred<void>(),
        release = deferred<void>();
      f.configs.reload(
        configSource.replace(
          '응답은 현재 대화의 언어로',
          'revision one. 응답은 현재 대화의 언어로',
        ),
      );
      const first = f.configs.current;
      let held = false;
      f.transport[mode === 'download' ? 'config' : 'heartbeat'] = async (url, response) => {
        if ((mode === 'download' && url.endsWith(hash(first))) || (mode === 'heartbeat' && !held)) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return response;
      };
      const older = f.runtime.heartbeat();
      await entered.promise;
      f.configs.reload(
        configSource.replace(
          '응답은 현재 대화의 언어로',
          'revision two. 응답은 현재 대화의 언어로',
        ),
      );
      try {
        await f.runtime.heartbeat();
      } finally {
        release.resolve();
        await older;
      }
      expect(
        JSON.parse(await readFile(join(f.dir, 'cache', 'config', '1', 'current.json'), 'utf8'))
          .revision,
      ).toBe(hash(f.configs.current));
    },
  );
  it('continues an issued Attempt lease through interrupted config download and retries synchronization', async () => {
    const f = await setup(),
      started = deferred<void>(),
      pending = deferred<Result>();
    f.provider.factory = () => {
      started.resolve();
      return {
        result: pending.promise,
        interrupt: async () => {},
        steer: async () => {},
        close: async () => {},
      };
    };
    await f.runtime.work();
    await started.promise;
    const active = [...f.runtime.active.values()][0]!;
    const before = f.s.sqlite
      .prepare('SELECT lease_until FROM attempts WHERE id=?')
      .get(active.claim.attemptId) as { lease_until: number };
    f.configs.reload(
      configSource.replace('응답은 현재 대화의 언어로', 'new revision. 응답은 현재 대화의 언어로'),
    );
    f.transport.config = async () => {
      throw new Error('config_transfer_interrupted');
    };
    f.tick(1000);
    try {
      await expect(f.runtime.heartbeat()).rejects.toThrow('config_transfer_interrupted');
      expect(
        (
          f.s.sqlite
            .prepare('SELECT lease_until FROM attempts WHERE id=?')
            .get(active.claim.attemptId) as { lease_until: number }
        ).lease_until,
      ).toBeGreaterThan(before.lease_until);
      expect(
        JSON.parse(await readFile(join(f.dir, 'cache', 'config', '1', 'current.json'), 'utf8'))
          .revision,
      ).toBe(active.claim.runConfig.configRevision);
      delete f.transport.config;
      await f.runtime.heartbeat();
      expect(
        JSON.parse(await readFile(join(f.dir, 'cache', 'config', '1', 'current.json'), 'utf8'))
          .revision,
      ).toBe(hash(f.configs.current));
      expect(active.claim.runConfig.payload.agent.instructions).not.toContain('new revision.');
    } finally {
      pending.resolve({ kind: 'completed', text: 'original snapshot answer' });
      await active.task;
    }
  });
});
