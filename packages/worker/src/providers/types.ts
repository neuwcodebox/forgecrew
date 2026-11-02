import type { Model, Result } from '../../../shared/src/types.ts';
import type { WorkClaim } from '../../../shared/src/protocol.ts';

export type ProviderState = { id: string; engine: 'codex' | 'claude'; workspace: string };
export type RunRequest = {
  claim: WorkClaim;
  workspace: string;
  context: string;
  resume?: ProviderState;
  signal: AbortSignal;
  onSession: (state: ProviderState) => Promise<void>;
};
export interface ProviderRun {
  result: Promise<Result>;
  interrupt(): Promise<void>;
  steer(text: string, controlId: string): Promise<void>;
  close(): Promise<void>;
}
export interface Provider {
  probe(): Promise<Model[]>;
  run(request: RunRequest): ProviderRun;
}
export function instructions(request: RunRequest): string {
  return (
    request.claim.runConfig.payload.agent.instructions +
    '\n\nAI attribution for direct GitHub writes:\n' +
    request.claim.runConfig.payload.output.attribution
  );
}
export function userInput(request: RunRequest): string {
  return JSON.stringify({
    session: request.claim.session,
    requester: request.claim.input.author,
    request: request.claim.input.body,
    steering: request.claim.steering ?? [],
    conversation: request.context,
    recovery: {
      attempt: request.claim.attemptId,
      generation: request.claim.generation,
      note: 'Check existing remote changes before repeating work.',
    },
  });
}
