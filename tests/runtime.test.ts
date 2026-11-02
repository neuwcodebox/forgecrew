import { afterEach,describe,expect,it } from 'vitest';
import { mkdtemp,readFile,readdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../packages/dispatcher/src/store.ts';
import { createApp } from '../packages/dispatcher/src/api.ts';
import { ConfigManager } from '../packages/shared/src/config.ts';
import { configSource,worker } from './helpers.ts';
import { DispatcherClient } from '../packages/worker/src/client.ts';
import { WorkerRuntime } from '../packages/worker/src/runtime.ts';
import { GhClient } from '../packages/worker/src/github.ts';
import { acquireLock } from '../packages/worker/src/lock.ts';
import { hash } from '../packages/shared/src/hash.ts';
import type { LocalConfig } from '../packages/worker/src/local.ts';
import type { DeliveryClaim,WorkClaim } from '../packages/shared/src/protocol.ts';
import type { Result } from '../packages/shared/src/types.ts';
import type { Provider,ProviderRun,RunRequest } from '../packages/worker/src/providers/types.ts';

const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();});
function deferred<T>() {let resolve!:(v:T)=>void;let reject!:(e:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
class FakeGithub extends GhClient {
  posted:{id:number;body:string;user:{id:number;login:string}}[]=[];
  attempts=0;losePostResponse=false;
  readonly dir:string;
  constructor(host:string,dir:string){super(host);this.dir=dir;}
  override async account(){return {id:123,login:'coworker'};}
  override async repositories(names:string[]){return names;}
  override async context(_claim:WorkClaim){return 'conversation from GitHub';}
  override async workspace(){return this.dir;}
  override async findDelivery(d:DeliveryClaim){return this.posted.find(p=>hash(p.body)===d.body_hash&&d.authors.includes(String(p.user.id)));}
  override async post(d:DeliveryClaim){this.attempts++;const comment={id:this.attempts,body:d.body,user:{id:123,login:'coworker'}};this.posted.push(comment);if(this.losePostResponse){this.losePostResponse=false;throw new Error('post_response_lost');}return {id:comment.id,html_url:'https://github.example/internal/comment'};}
}
class FakeProvider implements Provider {
  requests:RunRequest[]=[];
  factory:(r:RunRequest)=>ProviderRun;
  constructor(){this.factory=r=>({result:r.onSession({id:'provider_session_1',engine:r.claim.runConfig.engine,workspace:r.workspace}).then(()=>({kind:'completed',text:'answer'})),interrupt:async()=>{},steer:async()=>{},close:async()=>{}});}
  async probe(){return worker(Date.now()).models;}
  run(request:RunRequest){this.requests.push(request);return this.factory(request);}
}
async function setup(options:{loseCompletion?:boolean;engine?:'codex'|'claude'}={}) {
  let offset=0;const s=new Store(':memory:',()=>Date.now()+offset);cleanup.push(async()=>s.close());
  const configs=new ConfigManager(configSource,c=>s.saveConfig(c));const app=createApp(s,configs,'r'.repeat(48));
  const dir=await mkdtemp(join(tmpdir(),'forgecrew-runtime-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const local:LocalConfig={schemaVersion:1,id:randomUUID(),token:'t'.repeat(48),dispatcher:'http://localhost',hostname:configs.current.github.hostname,maxConcurrentSessions:1,engines:options.engine==='claude'?{claude:'fixture'}:{codex:'fixture'}};
  let lose=options.loseCompletion??false;
  const fetcher:typeof fetch=async(input,init)=>{
    const response=await app.request(new Request(input,init));
    if(lose&&String(input).endsWith('/v1/complete')){lose=false;throw new Error('completion_ack_lost');}return response;
  };
  const provider=new FakeProvider();
  if(options.engine==='claude')provider.probe=async()=>[{...worker(Date.now()).models[0]!,engine:'claude',family:'opus',id:'claude-opus-5-5',version:[5,5]}];
  const github=new FakeGithub(local.hostname,dir);
  const runtime=new WorkerRuntime(local,dir,{client:new DispatcherClient(local,fetcher),github,providers:{[options.engine??'codex']:provider}});
  cleanup.push(()=>runtime.settleControls());
  const key={host:local.hostname,repository:'team/project-a',kind:'issue' as const,number:1};
  const id=s.upsertSession(key,options.engine==='claude'?['ai:enabled','ai:model:opus']:['ai:enabled'],true,Date.now(),'request','writer');
  await runtime.initialize('r'.repeat(48));
  return {s,configs,dir,local,runtime,provider,github,id,key,tick:(ms:number)=>{offset+=ms;}};
}
describe('Dispatcher and Worker integration',()=>{
  it('claims, executes, journals and publishes, then resumes with the next central instructions',async()=>{
    const f=await setup();await f.runtime.work();await Promise.all([...f.runtime.active.values()].map(a=>a.task));await f.runtime.work();
    expect(f.provider.requests).toHaveLength(1);expect(f.github.posted).toHaveLength(1);expect(f.github.posted[0]!.body).toContain('AI-generated');
    expect(await readdir(join(f.dir,'journal'))).toEqual([]);
    expect(f.configs.reload(configSource.replace('응답은 현재 대화의 언어로','NEW INSTRUCTIONS. 응답은 현재 대화의 언어로'))).toBe(true);
    f.s.enqueue(f.id,'comment','42','next request','writer',Date.now()+1);await f.runtime.work();await Promise.all([...f.runtime.active.values()].map(a=>a.task));
    expect(f.provider.requests[1]!.resume?.id).toBe('provider_session_1');expect(f.provider.requests[1]!.claim.runConfig.payload.agent.instructions).toContain('NEW INSTRUCTIONS.');
  });
  it('retries lost completion acknowledgement without rerunning the Provider',async()=>{
    const f=await setup({loseCompletion:true});await f.runtime.work();await Promise.all([...f.runtime.active.values()].map(a=>a.task));
    expect(await readdir(join(f.dir,'journal'))).toHaveLength(1);await f.runtime.work();expect(f.provider.requests).toHaveLength(1);expect(f.github.posted).toHaveLength(1);
  });
  it('reconciles a lost GitHub post response and publishes exactly one comment in the fixture',async()=>{
    const f=await setup();f.github.losePostResponse=true;await f.runtime.work();await Promise.all([...f.runtime.active.values()].map(a=>a.task));
    await expect(f.runtime.work()).rejects.toThrow('post_response_lost');f.tick(f.configs.current.runtime.leaseDuration+1);await f.runtime.work();
    expect(f.github.attempts).toBe(1);expect(f.s.sqlite.prepare('SELECT status FROM deliveries').get()).toEqual({status:'posted'});
  });
  it('stops the current turn and retains the queued follow-up',async()=>{
    const f=await setup();const started=deferred<void>(),pending=deferred<Result>();
    f.provider.factory=()=>({result:pending.promise,interrupt:async()=>{pending.reject(new Error('provider_interrupted'));},steer:async()=>{},close:async()=>{}});
    const old=f.provider.run.bind(f.provider);f.provider.run=r=>{const result=old(r);started.resolve();return result;};
    await f.runtime.work();await started.promise;const a=[...f.runtime.active.values()][0]!;
    f.s.enqueue(f.id,'comment','next','follow-up','writer',Date.now()+1);f.s.addControl(f.id,'stop_comment',{kind:'stop'},Date.now());
    await f.runtime.heartbeat();await a.task;await f.runtime.settleControls();
    expect(f.s.sqlite.prepare('SELECT status FROM turns WHERE id=?').get(a.claim.turnId)).toEqual({status:'cancelled'});
    expect(f.s.sqlite.prepare("SELECT status FROM inputs WHERE source_id='next'").get()).toEqual({status:'queued'});
  });
  it('interrupts Claude then resumes the same logical turn with a new Attempt and steering',async()=>{
    const f=await setup({engine:'claude'});const first=deferred<void>(),second=deferred<void>(),pending=deferred<Result>();let count=0;
    f.provider.factory=r=>{
      if(++count===1){first.resolve();return {result:pending.promise,interrupt:async()=>{pending.reject(new Error('provider_interrupted'));},steer:async()=>{},close:async()=>{}};}
      second.resolve();return {result:Promise.resolve({kind:'completed',text:'steered answer'}),interrupt:async()=>{},steer:async()=>{},close:async()=>{}};
    };
    await f.runtime.work();await first.promise;const previous=f.provider.requests[0]!.claim;
    f.s.addControl(f.id,'steer_comment',{kind:'steer',text:'use SSO'},Date.now());await f.runtime.heartbeat();await second.promise;
    await Promise.all([...f.runtime.active.values()].map(a=>a.task));
    await f.runtime.settleControls();
    const next=f.provider.requests[1]!.claim;expect(next.turnId).toBe(previous.turnId);expect(next.generation).toBe(previous.generation+1);expect(next.steering?.[0]?.text).toBe('use SSO');
    expect(f.s.sqlite.prepare('SELECT COUNT(*) AS n FROM turns').get()).toEqual({n:1});
  });
  it('refuses a forged run snapshot before invoking a Provider',async()=>{
    const f=await setup();const claim=f.s.claim(f.local.id,f.configs.current)!;claim.runConfig.payload.agent.instructions='tampered';
    expect(()=>f.runtime.start(claim)).toThrow();expect(f.provider.requests).toHaveLength(0);
  });
  it('keeps a single local process owner per Worker identity',async()=>{
    const f=await setup();const path=join(f.dir,'worker.lock');const release=await acquireLock(path);
    await expect(acquireLock(path)).rejects.toThrow('worker_already_running');await release();const next=await acquireLock(path);await next();
  });
});
