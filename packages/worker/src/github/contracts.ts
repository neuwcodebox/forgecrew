import type { Result } from '../../../shared/src/types.ts';
import type { DeliveryClaim, WorkClaim, WorkSession } from '../../../shared/src/protocol.ts';

export type GitHubAccount = { id: number; login: string };
export type GitHubComment = { id: number; body: string; user: GitHubAccount };

export interface GitHubAccess {
  account(signal?: AbortSignal): Promise<GitHubAccount>;
  repositories(names: string[]): Promise<string[]>;
}
export interface ConversationSource {
  context(claim: WorkClaim, signal?: AbortSignal): Promise<string>;
  verifyOutput(
    claim: WorkClaim,
    result: Result,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<number[]>;
}
export interface DeliveryGateway {
  account(signal?: AbortSignal): Promise<GitHubAccount>;
  findDelivery(delivery: DeliveryClaim, signal?: AbortSignal): Promise<GitHubComment | undefined>;
  post(delivery: DeliveryClaim, signal?: AbortSignal): Promise<{ id: number; html_url: string }>;
}
export type GitHubGateway = GitHubAccess & ConversationSource & DeliveryGateway;

export interface Workspaces {
  prepare(session: WorkSession, signal?: AbortSignal): Promise<string>;
}
