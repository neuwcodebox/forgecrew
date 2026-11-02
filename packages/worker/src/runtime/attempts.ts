import type { Result, Engine } from '../../../shared/src/types.ts';
import type { WorkClaim } from '../../../shared/src/protocol.ts';
import { validateRunConfig } from '../../../shared/src/protocol.ts';
import { LeaseClock } from '../local.ts';
import { DispatcherError } from '../dispatcher/protocol.ts';
import type { Dispatcher } from '../dispatcher/protocol.ts';
import type { ConversationSource, Workspaces } from '../github/contracts.ts';
import type { Provider, ProviderRun } from '../providers/types.ts';
import type { LocalSessions } from '../state/sessions.ts';
import type { WorkerInventory } from './inventory.ts';
import type { ResultReporter } from './results.ts';
import { errorCode, recoveryReason } from './errors.ts';
import type { RuntimeLog, InterruptReason } from './errors.ts';

type ActiveAttempt = {
  claim: WorkClaim;
  clock: LeaseClock;
  controller: AbortController;
  startedAt: number;
  run?: ProviderRun;
  task: Promise<void>;
  reason?: InterruptReason;
  cleanupFailed?: boolean;
};
type AttemptServices = {
  hostname: string;
  maxConcurrentSessions: number;
  dispatcher: Pick<Dispatcher, 'renewAttempt' | 'releaseAttempt' | 'cancelAttempt'>;
  github: ConversationSource;
  workspaces: Workspaces;
  providers: Partial<Record<Engine, Provider>>;
  state: Pick<LocalSessions, 'begin' | 'resume' | 'save'>;
  results: Pick<ResultReporter, 'record' | 'flush'>;
  inventory: Pick<WorkerInventory, 'blockRepository' | 'blockProvider'>;
  onBlocked: () => Promise<void>;
  log: RuntimeLog;
};

export class AttemptRunner {
  readonly active = new Map<string, ActiveAttempt>();
  private readonly services: AttemptServices;
  constructor(services: AttemptServices) {
    this.services = services;
  }
  start(claim: WorkClaim, sentWall = Date.now(), sentMono = performance.now()) {
    validateRunConfig(claim.runConfig);
    const { hostname, maxConcurrentSessions, providers, log } = this.services;
    if (
      claim.session.host !== hostname ||
      !claim.runConfig.payload.github.repositories.some(
        (repository) => repository.toLowerCase() === claim.session.repository.toLowerCase(),
      )
    )
      throw new Error('claim_repository_not_allowed');
    if (this.active.size >= maxConcurrentSessions || this.active.has(claim.attemptId))
      throw new Error('worker_capacity_exceeded');
    if (!providers[claim.runConfig.engine]) throw new Error('provider_disabled');
    const clock = new LeaseClock();
    clock.renew(sentWall, sentMono, {
      duration: claim.leaseDuration,
      interruptGrace: claim.interruptGrace,
    });
    const active: ActiveAttempt = {
      claim,
      clock,
      startedAt: Date.now(),
      controller: new AbortController(),
      task: Promise.resolve(),
    };
    const trace = {
      attemptId: claim.attemptId,
      turnId: claim.turnId,
      sessionId: claim.session.id,
      generation: claim.generation,
      model: claim.runConfig.model,
      effort: claim.runConfig.effort,
      configRevision: claim.runConfig.configRevision,
      runConfigRevision: claim.runConfig.runConfigRevision,
    };
    this.active.set(claim.attemptId, active);
    log('attempt_started', undefined, trace);
    active.task = this.execute(active)
      .catch((error) => log('attempt_failed', errorCode(error), trace))
      .finally(() => {
        this.active.delete(claim.attemptId);
        log('attempt_closed', active.reason, trace);
      });
    return active.task;
  }
  async interrupt(active: ActiveAttempt, reason: InterruptReason) {
    if (active.reason) return this.waitForExit(active);
    active.reason = reason;
    active.controller.abort();
    const forced = setTimeout(
      () => {
        void active.run?.close().catch(() => {});
      },
      Math.max(1, active.claim.interruptGrace / 2),
    );
    void active.run?.interrupt().catch(() => {});
    try {
      await this.waitForExit(active);
    } finally {
      clearTimeout(forced);
    }
  }
  private async waitForExit(active: ActiveAttempt) {
    await active.task;
    if (active.cleanupFailed) throw new Error('provider_cleanup_unconfirmed');
  }
  async renew() {
    await Promise.all(
      [...this.active.values()].map(async (active) => {
        if (active.reason) return;
        const wall = Date.now(),
          mono = performance.now();
        try {
          const lease = await this.services.dispatcher.renewAttempt(this.identity(active.claim));
          active.clock.renew(wall, mono, {
            duration: lease.leaseDuration,
            interruptGrace: lease.interruptGrace,
          });
        } catch (error) {
          if (error instanceof DispatcherError && error.status === 409)
            void this.interrupt(active, 'lease_lost').catch((error) =>
              this.services.log('interrupt_failed', errorCode(error)),
            );
        }
      }),
    );
  }
  checkLeases() {
    for (const active of this.active.values())
      if (!active.clock.canRun())
        void this.interrupt(active, 'lease_lost').catch((error) =>
          this.services.log('interrupt_failed', errorCode(error)),
        );
  }
  stopAll() {
    return Promise.all(
      [...this.active.values()].map((active) => this.interrupt(active, 'shutdown')),
    );
  }
  private identity(claim: WorkClaim) {
    return { attemptId: claim.attemptId, generation: claim.generation };
  }
  private async execute(active: ActiveAttempt) {
    const { claim } = active,
      { github, workspaces, state, providers, results, dispatcher, inventory, log, onBlocked } =
        this.services;
    let result: Result | undefined;
    await state.begin(claim);
    try {
      const context = await github.context(claim, active.controller.signal),
        workspace = await workspaces.prepare(claim.session, active.controller.signal);
      if (!active.clock.canRun() || active.controller.signal.aborted)
        throw new Error('lease_expired_before_start');
      const resume = await state.resume(claim, workspace);
      active.run = providers[claim.runConfig.engine]!.run({
        claim,
        context,
        workspace,
        ...(resume ? { resume } : {}),
        signal: active.controller.signal,
        onSession: (session) => state.save(claim, session),
      });
      result = await active.run.result;
    } catch (error) {
      if (!active.reason) {
        const reason = errorCode(error),
          recovery = recoveryReason(reason);
        if (recovery) {
          active.reason = recovery;
          if (recovery === 'github_blocked') {
            inventory.blockRepository(claim.session.repository);
            log('github_blocked', reason);
          }
          if (recovery === 'provider_blocked') {
            inventory.blockProvider(claim.runConfig.engine, reason);
            log('provider_blocked', claim.runConfig.engine + ':' + reason);
          }
        } else result = { kind: 'failed', text: 'Worker 실행 실패: ' + reason, origin: 'runtime' };
      }
    } finally {
      try {
        await active.run?.close();
      } catch (error) {
        active.cleanupFailed = true;
        log('provider_cleanup_failed', errorCode(error), { attemptId: claim.attemptId });
      }
    }
    // An unconfirmed shutdown must not authorize an immediate replacement execution.
    if (active.reason && active.cleanupFailed) return;
    const identity = this.identity(claim);
    if (active.reason === 'steer') return;
    if (active.reason === 'stop') {
      await dispatcher.cancelAttempt(identity);
      return;
    }
    if (active.reason) {
      await dispatcher.releaseAttempt(identity).catch(() => {});
      if (active.reason === 'provider_blocked' || active.reason === 'github_blocked')
        await onBlocked().catch(() => {});
      return;
    }
    if (!result) return;
    await results.record(claim.attemptId, claim.generation, result);
    await results.flush();
    if (result.kind === 'failed') return;
    try {
      for (const pullNumber of await github.verifyOutput(
        claim,
        result,
        active.startedAt,
        active.controller.signal,
      ))
        log('output_attribution_missing', undefined, {
          attemptId: claim.attemptId,
          sessionId: claim.session.id,
          pullNumber,
        });
    } catch (error) {
      log('output_verification_unavailable', errorCode(error), {
        attemptId: claim.attemptId,
        sessionId: claim.session.id,
      });
    }
  }
}
