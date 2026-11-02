import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkClaim } from '../../../shared/src/protocol.ts';
import type { ProviderState } from '../providers/types.ts';
import { atomicWrite } from '../local.ts';

export class LocalSessions {
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  begin(claim: WorkClaim) {
    return atomicWrite(join(this.directory, 'attempts', claim.attemptId + '.json'), {
      claim,
      state: 'starting',
    });
  }
  async resume(claim: WorkClaim, workspace: string): Promise<ProviderState | undefined> {
    const state = await readFile(this.path(claim), 'utf8').then(
      (text) => JSON.parse(text) as ProviderState,
      () => undefined,
    );
    return state?.engine === claim.runConfig.engine && state.workspace === workspace
      ? state
      : undefined;
  }
  save(claim: WorkClaim, state: ProviderState) {
    return atomicWrite(this.path(claim), state);
  }
  private path(claim: WorkClaim) {
    return join(
      this.directory,
      'sessions',
      claim.session.id + '-' + claim.runConfig.engine + '.json',
    );
  }
}
