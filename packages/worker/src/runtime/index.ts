import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Projection } from '../../../shared/src/config.ts';
import type { Engine } from '../../../shared/src/types.ts';
import type { LocalConfig } from '../local.ts';
import type { Dispatcher, HeartbeatResponse } from '../dispatcher/protocol.ts';
import { DispatcherError } from '../dispatcher/protocol.ts';
import type { GitHubGateway, Workspaces } from '../github/contracts.ts';
import type { Provider } from '../providers/types.ts';
import { LocalSessions } from '../state/sessions.ts';
import { ConfigurationSync } from './configuration.ts';
import { WorkerInventory } from './inventory.ts';
import { ResultReporter } from './results.ts';
import { AttemptRunner } from './attempts.ts';
import { ControlProcessor } from './controls.ts';
import { DeliveryPump } from './deliveries.ts';
import { defaultReconnect, runLoop } from './loops.ts';
import { errorCode } from './errors.ts';
import type { RuntimeLog } from './errors.ts';

export type WorkerDependencies = {
  dispatcher: Dispatcher;
  github: GitHubGateway;
  workspaces: Workspaces;
  providers: Partial<Record<Engine, Provider>>;
  version: string;
  logger: (record: Record<string, unknown>) => void;
  ready?: () => void;
  stabilizing?: boolean;
};
export class WorkerRuntime {
  readonly dispatcher: Dispatcher;
  readonly attempts: AttemptRunner;
  readonly results: ResultReporter;
  readonly controls: ControlProcessor;
  readonly configuration: ConfigurationSync;
  readonly inventory: WorkerInventory;
  private readonly deliveries: DeliveryPump;
  private readonly config: LocalConfig;
  private readonly directory: string;
  private readonly log: RuntimeLog;
  private readonly ready: () => void;
  private draining = false;
  private stabilizing: boolean;
  private heartbeatSequence = 0;
  private updateCheck: ((projection: Projection, signal: AbortSignal) => Promise<void>) | undefined;

  constructor(config: LocalConfig, directory: string, dependencies: WorkerDependencies) {
    this.config = config;
    this.directory = directory;
    this.dispatcher = dependencies.dispatcher;
    this.stabilizing = dependencies.stabilizing ?? false;
    this.ready = dependencies.ready ?? (() => {});
    this.log = (event, reason, details = {}) =>
      dependencies.logger({
        event,
        workerId: config.id,
        ...(reason ? { reason } : {}),
        ...details,
      });
    this.configuration = new ConfigurationSync(directory, config.hostname, this.dispatcher);
    this.results = new ResultReporter(directory, this.dispatcher);
    this.inventory = new WorkerInventory({
      id: config.id,
      version: dependencies.version,
      maxConcurrentSessions: config.maxConcurrentSessions,
      github: dependencies.github,
      providers: dependencies.providers,
      log: this.log,
    });
    this.attempts = new AttemptRunner({
      hostname: config.hostname,
      maxConcurrentSessions: config.maxConcurrentSessions,
      dispatcher: this.dispatcher,
      github: dependencies.github,
      workspaces: dependencies.workspaces,
      providers: dependencies.providers,
      state: new LocalSessions(directory),
      results: this.results,
      inventory: this.inventory,
      onBlocked: () => this.heartbeat(),
      log: this.log,
    });
    this.controls = new ControlProcessor(directory, this.dispatcher, this.attempts, this.log);
    this.deliveries = new DeliveryPump(directory, this.dispatcher, dependencies.github);
  }
  async initialize(registrationToken?: string) {
    await this.inventory.identify();
    let response: HeartbeatResponse;
    try {
      response = await this.dispatcher.heartbeat(this.inventory.current);
    } catch (error) {
      if (!(error instanceof DispatcherError) || error.status !== 401 || !registrationToken)
        throw error;
      const registered = await this.dispatcher.register(
        this.inventory.current,
        this.config.token,
        registrationToken,
      );
      response = { ...registered, controls: [] };
    }
    await this.configuration.sync(response.configRevision);
    await this.refreshCapabilities();
    await this.heartbeat();
    await this.results.flush();
  }
  async refreshCapabilities() {
    const projection = this.configuration.current;
    if (projection) await this.inventory.refresh(projection);
  }
  async heartbeat() {
    const sequence = ++this.heartbeatSequence;
    const capabilities = this.inventory.snapshot(
      this.draining || this.stabilizing,
      this.configuration.current?.configRevision,
    );
    const response = await this.dispatcher.heartbeat(capabilities);
    await this.attempts.renew();
    await this.deliveries.renew();
    this.controls.dispatch(response.controls);
    if (sequence === this.heartbeatSequence) await this.configuration.sync(response.configRevision);
  }
  async work(signal?: AbortSignal, longPoll = false) {
    const projection = this.configuration.current;
    if (!projection || this.stabilizing || signal?.aborted) return;
    await this.results.flush();
    await this.deliveries.publish(projection.payload.runtime.interruptGrace, signal);
    while (
      this.attempts.active.size < this.config.maxConcurrentSessions &&
      !this.draining &&
      !this.stabilizing &&
      !signal?.aborted
    ) {
      const wall = Date.now(),
        mono = performance.now(),
        { claim } = await this.dispatcher.claim(longPoll, signal);
      if (!claim) break;
      if (this.draining || this.stabilizing || signal?.aborted) {
        await this.dispatcher.releaseAttempt({
          attemptId: claim.attemptId,
          generation: claim.generation,
        });
        break;
      }
      this.attempts.start(claim, wall, mono);
    }
  }
  checkLeases() {
    this.deliveries.checkLease();
    this.attempts.checkLeases();
  }
  activate() {
    this.stabilizing = false;
  }
  setUpdateHandler(handler: (projection: Projection, signal: AbortSignal) => Promise<void>) {
    this.updateCheck = handler;
  }
  async drain(timeout: number, signal?: AbortSignal) {
    this.draining = true;
    const deadline = Date.now() + timeout;
    while (this.attempts.active.size && Date.now() < deadline && !signal?.aborted)
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    await this.controls.settle();
    await this.attempts.stopAll();
    await this.results.flush().catch(() => {});
  }
  async run(signal: AbortSignal, registrationToken?: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.configuration.loadCache();
    await this.results.validate();
    this.ready();
    await this.connect(signal, registrationToken);
    const repeat = (task: () => Promise<unknown> | void, interval: () => number) =>
      runLoop(
        task,
        interval,
        () => this.configuration.current?.payload.runtime.reconnect,
        signal,
        (error) => this.log('worker_retrying', errorCode(error)),
      );
    await Promise.all([
      repeat(
        async () => {
          const projection = this.configuration.current;
          if (projection && !this.stabilizing && !this.draining)
            await this.updateCheck?.(projection, signal);
        },
        () => this.configuration.current?.payload.updates.checkInterval ?? 60000,
      ),
      repeat(
        () => this.heartbeat(),
        () => this.configuration.current?.payload.runtime.heartbeatInterval ?? 15000,
      ),
      repeat(
        () => this.work(signal, true),
        () => this.configuration.current?.payload.runtime.reconnect.initialDelay ?? 1000,
      ),
      repeat(
        () => this.checkLeases(),
        () => 250,
      ),
      repeat(
        async () => {
          const projection = this.configuration.current;
          if (
            projection &&
            Date.now() - this.inventory.lastRefresh >=
              projection.payload.runtime.modelCatalogRefreshInterval
          )
            await this.refreshCapabilities();
        },
        () => this.configuration.current?.payload.runtime.configCheckInterval ?? 30000,
      ),
    ]);
    this.draining = true;
    await this.controls.settle();
    await this.attempts.stopAll();
    await this.results.flush().catch(() => {});
  }
  private async connect(signal: AbortSignal, registrationToken?: string) {
    let backoff = defaultReconnect.initialDelay,
      offlineUpdateAt = 0;
    while (!signal.aborted) {
      try {
        await this.initialize(registrationToken);
        break;
      } catch (error) {
        this.log('worker_reconnecting', errorCode(error));
        const projection = this.configuration.current;
        if (projection && !this.stabilizing && !signal.aborted && Date.now() >= offlineUpdateAt) {
          offlineUpdateAt = Date.now() + projection.payload.updates.checkInterval;
          await this.updateCheck?.(projection, signal).catch((error) =>
            this.log('update_retrying', errorCode(error)),
          );
        }
        await delay(backoff, undefined, { signal }).catch(() => {});
        backoff = Math.min(backoff * 2, defaultReconnect.maxDelay);
      }
    }
  }
}
