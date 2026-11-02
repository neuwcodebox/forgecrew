import { join } from 'node:path';
import type { DeliveryClaim } from '../../../shared/src/protocol.ts';
import type { Dispatcher } from '../dispatcher/protocol.ts';
import { DispatcherError } from '../dispatcher/protocol.ts';
import type { DeliveryGateway } from '../github/contracts.ts';
import { atomicWrite, LeaseClock } from '../local.ts';

type DeliveryDispatcher = Pick<
  Dispatcher,
  'claimDelivery' | 'renewDelivery' | 'beginDelivery' | 'receipt'
>;
type ActiveDelivery = {
  claim: DeliveryClaim;
  clock: LeaseClock;
  controller: AbortController;
  interruptGrace: number;
};
export class DeliveryPump {
  private readonly directory: string;
  private readonly dispatcher: DeliveryDispatcher;
  private readonly github: DeliveryGateway;
  private active: ActiveDelivery | undefined;
  constructor(directory: string, dispatcher: DeliveryDispatcher, github: DeliveryGateway) {
    this.directory = directory;
    this.dispatcher = dispatcher;
    this.github = github;
  }
  async publish(configuredGrace: number, signal?: AbortSignal) {
    const wall = Date.now(),
      mono = performance.now(),
      response = await this.dispatcher.claimDelivery();
    if (!response.delivery) return;
    const claim = response.delivery,
      clock = new LeaseClock(),
      controller = new AbortController(),
      interruptGrace = Math.min(configuredGrace, claim.leaseDuration / 3);
    clock.renew(wall, mono, { duration: claim.leaseDuration, interruptGrace });
    this.active = { claim, clock, controller, interruptGrace };
    if (!clock.canRun()) controller.abort();
    try {
      await this.deliver(
        claim,
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      );
    } finally {
      this.active = undefined;
    }
  }
  async renew() {
    const active = this.active;
    if (!active || active.controller.signal.aborted) return;
    const wall = Date.now(),
      mono = performance.now();
    try {
      const lease = await this.dispatcher.renewDelivery(active.claim.id);
      active.clock.renew(wall, mono, {
        duration: lease.leaseDuration,
        interruptGrace: active.interruptGrace,
      });
    } catch (error) {
      if (error instanceof DispatcherError && error.status === 409) active.controller.abort();
    }
  }
  checkLease() {
    if (this.active && !this.active.clock.canRun()) this.active.controller.abort();
  }
  private async deliver(delivery: DeliveryClaim, signal: AbortSignal) {
    signal.throwIfAborted();
    const existing = await this.github.findDelivery(delivery, signal);
    signal.throwIfAborted();
    if (existing) {
      await this.dispatcher.receipt(delivery.id, String(existing.id));
      return;
    }
    const account = await this.github.account(signal);
    if (!delivery.authors.includes(String(account.id))) throw new Error('github_identity_changed');
    signal.throwIfAborted();
    await this.dispatcher.beginDelivery(delivery.id);
    signal.throwIfAborted();
    const posted = await this.github.post(delivery, signal);
    await atomicWrite(join(this.directory, 'receipts', delivery.id + '.json'), {
      schemaVersion: 1,
      id: delivery.id,
      githubId: String(posted.id),
    });
    signal.throwIfAborted();
    await this.dispatcher.receipt(delivery.id, String(posted.id));
  }
}
