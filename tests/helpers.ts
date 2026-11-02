import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseConfig } from '../packages/shared/src/config.ts';
import type { WorkerCapabilities } from '../packages/shared/src/types.ts';

export const configSource = readFileSync(new URL('../config.example.yaml',import.meta.url),'utf8');
export function config() { return parseConfig(configSource); }
export function worker(now = 1000000, patch: Partial<WorkerCapabilities> = {}): WorkerCapabilities {
  return {
    id:randomUUID(),githubLogin:'coworker',githubId:'123',version:'0.1.0',schemaVersions:[1],maxConcurrentSessions:1,
    repositories:['team/project-a'],draining:false,
    models:[{ family:'sol',id:'gpt-6.10-sol',version:[6,10],efforts:['low','medium','high','xhigh'],defaultEffort:'medium',engine:'codex',autoReview:true,availability:'ready',observedAt:now,runtimeVersion:'fixture' }],
    ...patch,
  };
}
