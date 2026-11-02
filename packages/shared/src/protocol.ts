import type { Projection } from './config.ts';
import { validateProjection } from './config.ts';
import { hash } from './hash.ts';
import type { Effort, Engine, Family } from './types.ts';

export type RunConfig = Projection & {
  sessionConfigRevision:string; model:string; engine:Engine; effort:Effort|null; family:Family; runConfigRevision:string;
};
export type WorkSession = {id:string;host:string;repository:string;kind:'issue'|'pull';number:number};
export type WorkInput = {id:string;body:string;author:string;created_at:number;source_kind:string;source_id:string};
export type WorkClaim = {
  attemptId:string;turnId:string;session:WorkSession;input:WorkInput;generation:number;
  leaseDuration:number;interruptGrace:number;runConfig:RunConfig;
  steering?:{id:string;text:string}[];
};
export type DeliveryClaim = {id:string;session:WorkSession;body:string;body_hash:string;authors:string[];leaseDuration:number};
export function validateRunConfig(config:RunConfig) {
  const {sessionConfigRevision,model,engine,effort,family,runConfigRevision,...projection}=config;
  validateProjection(projection);
  if(hash({...projection,sessionConfigRevision,model,engine,effort,family})!==runConfigRevision)throw new Error('invalid_run_config');
}
