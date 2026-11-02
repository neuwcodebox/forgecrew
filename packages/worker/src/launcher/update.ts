import type { Projection } from '../../../shared/src/config.ts';
import { installedVersion } from './state.ts';
import { stageUpdate } from './install.ts';

export class UpdateManager {
  readonly directory:string;
  private busy=false;
  private accepted:string|undefined;
  constructor(directory:string){this.directory=directory;}
  acknowledge(id:string){this.accepted=id;}
  async check(projection:Projection,drain:(timeout:number)=>Promise<void>,signal?:AbortSignal) {
    if(this.busy||!process.send||!process.env.FORGECREW_VERSION_ID)return;
    this.busy=true;
    try {
      const current=await installedVersion(this.directory,process.env.FORGECREW_VERSION_ID);
      const next=await stageUpdate(this.directory,projection.payload.updates,current,undefined,signal);if(!next||signal?.aborted)return;
      process.send({type:'STAGE_READY',protocolVersion:1,id:next.id,policy:projection.payload.updates});
      // Handoff starts only after the Launcher has durably recorded the candidate.
      const deadline=Date.now()+10000;
      const {setTimeout:delay}=await import('node:timers/promises');
      while(this.accepted!==next.id&&Date.now()<deadline&&!signal?.aborted)await delay(50);
      if(signal?.aborted)return;
      if(this.accepted!==next.id)throw new Error('launcher_stage_not_acknowledged');
      await drain(projection.payload.updates.drainTimeout);
      if(signal?.aborted)return;
      process.send({type:'SWITCH',protocolVersion:1,id:next.id});
    }finally{this.busy=false;}
  }
}
