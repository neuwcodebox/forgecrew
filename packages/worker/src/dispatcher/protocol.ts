import type { Projection } from '../../../shared/src/config.ts';
import type { Control, Result, WorkerCapabilities } from '../../../shared/src/types.ts';
import type { DeliveryClaim, WorkClaim } from '../../../shared/src/protocol.ts';

export type AttemptIdentity = { attemptId: string; generation: number };
export type AttemptLease = { leaseDuration: number; interruptGrace: number };
export type ControlMessage = { id: string; attemptId: string; control: Control };
export type HeartbeatResponse = { configRevision: string; controls: ControlMessage[] };
export type WorkerStatus = {
  configRevision: string;
  worker: WorkerCapabilities & { seenAt: number };
  sessions: unknown[];
};

export interface Dispatcher {
  requestTimeout: number;
  register(
    capabilities: WorkerCapabilities,
    token: string,
    registrationToken: string,
  ): Promise<{ configRevision: string }>;
  heartbeat(capabilities: WorkerCapabilities): Promise<HeartbeatResponse>;
  configuration(revision: string): Promise<Projection>;
  claim(wait: boolean, signal?: AbortSignal): Promise<{ claim: WorkClaim | null }>;
  renewAttempt(attempt: AttemptIdentity): Promise<AttemptLease>;
  cancelAttempt(attempt: AttemptIdentity): Promise<unknown>;
  releaseAttempt(attempt: AttemptIdentity): Promise<unknown>;
  restartSteer(attempt: AttemptIdentity, controlId: string): Promise<{ claim: WorkClaim }>;
  acknowledgeControl(controlId: string): Promise<unknown>;
  complete(attempt: AttemptIdentity, result: Result): Promise<unknown>;
  claimDelivery(): Promise<{ delivery: DeliveryClaim | null }>;
  renewDelivery(id: string): Promise<{ leaseDuration: number }>;
  beginDelivery(id: string): Promise<unknown>;
  receipt(id: string, githubId: string): Promise<unknown>;
  status(timeout?: number): Promise<WorkerStatus>;
}

export class DispatcherError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('dispatcher_http_' + status);
    this.status = status;
  }
}
