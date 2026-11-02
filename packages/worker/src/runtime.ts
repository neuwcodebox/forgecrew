import { readFile, readdir, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { workerVersion } from './version.ts';
import type { LocalConfig } from './local.ts';
import { atomicWrite, cacheProjection, LeaseClock, writeResult, readLatestProjection } from './local.ts';
import { DispatcherClient, DispatcherError } from './client.ts';
import { GhClient, publishDelivery } from './github.ts';
import { CodexProvider } from './providers/codex.ts';
import { ClaudeProvider } from './providers/claude.ts';
import type { Provider, ProviderRun, ProviderState } from './providers/types.ts';
import type { Control, Engine, Model, Result, WorkerCapabilities } from '../../shared/src/types.ts';
import { hash } from '../../shared/src/hash.ts';
import type { DeliveryClaim, WorkClaim } from '../../shared/src/protocol.ts';
import { validateRunConfig } from '../../shared/src/protocol.ts';
import { validateProjection } from '../../shared/src/config.ts';
import type { Projection } from '../../shared/src/config.ts';

type Active={claim:WorkClaim;clock:LeaseClock;controller:AbortController;startedAt:number;run?:ProviderRun;task:Promise<void>;reason?:'stop'|'shutdown'|'lease_lost'|'steer'|'refresh'|'provider_blocked'|'github_blocked';};
type Heartbeat={configRevision:string;controls:{id:string;attemptId:string;control:Control}[]};
type Dependencies={client?:DispatcherClient;github?:GhClient;providers?:Partial<Record<Engine,Provider>>;logger?:(record:Record<string,unknown>)=>void};
const code=(error:unknown)=>error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'worker_operation_failed';

export class WorkerRuntime {
  readonly config:LocalConfig;
  readonly directory:string;
  readonly client:DispatcherClient;
  readonly github:GhClient;
  readonly providers:Partial<Record<Engine,Provider>>;
  readonly active=new Map<string,Active>();
  private readonly writeLog:(record:Record<string,unknown>)=>void;
  private controlTasks=new Map<string,Promise<void>>();
  private capabilities:WorkerCapabilities|undefined;
  private projection:Projection|undefined;
  private catalogAt=0;
  private draining=false;
  private stabilizing=process.env.FORGECREW_STABILIZING==='1';
  private updateCheck:((p:Projection,signal:AbortSignal)=>Promise<void>)|undefined;
  private flushing:Promise<void>|undefined;
  private delivery:{claim:DeliveryClaim;clock:LeaseClock;controller:AbortController;interruptGrace:number}|undefined;
  constructor(config:LocalConfig,directory:string,dependencies:Dependencies={}) {
    this.writeLog=dependencies.logger??(record=>console.log(JSON.stringify(record)));
    this.config=config;this.directory=directory;this.client=dependencies.client??new DispatcherClient(config);
    this.github=dependencies.github??new GhClient(config.hostname);
    this.providers=dependencies.providers??{
      ...(config.engines.codex?{codex:new CodexProvider(config.engines.codex)}:{}),
      ...(config.engines.claude?{claude:new ClaudeProvider(config.engines.claude)}:{}),
    };
  }
  private log(event:string,reason?:string,details:Record<string,unknown>={}) {this.writeLog({event,workerId:this.config.id,...(reason?{reason}:{}),...details});}
  async initialize(registrationToken?:string) {
    const account=await this.github.account();
    this.capabilities={id:this.config.id,githubLogin:account.login,githubId:String(account.id),version:workerVersion,schemaVersions:[1],maxConcurrentSessions:this.config.maxConcurrentSessions,repositories:[],models:[],draining:false};
    let connected:Heartbeat;
    try {connected=await this.client.request<Heartbeat>('/v1/heartbeat',this.capabilities);}
    catch(error) {
      if(!(error instanceof DispatcherError)||error.status!==401||!registrationToken)throw error;
      const registered=await this.client.request<{configRevision:string}>('/v1/register',{capabilities:this.capabilities,token:this.config.token},{registrationToken});
      connected={...registered,controls:[]};
    }
    await this.sync(connected.configRevision);
    await this.refreshCapabilities();
    await this.heartbeat();
    await this.flushResults();
  }
  private async sync(revision:string) {
    if(this.projection?.configRevision===revision)return;
    const p=await this.client.request<Projection>('/v1/config/'+revision,undefined,{method:'GET'});validateProjection(p);
    if(p.configRevision!==revision||p.payload.github.hostname!==this.config.hostname)throw new Error('worker_config_host_mismatch');
    await cacheProjection(this.directory,p);this.projection=p;this.client.requestTimeout=p.payload.runtime.requestTimeout;
  }
  async refreshCapabilities() {
    if(!this.projection||!this.capabilities)return;
    const account=await this.github.account();this.capabilities.githubLogin=account.login;this.capabilities.githubId=String(account.id);
    this.capabilities.repositories=await this.github.repositories(this.projection.payload.github.repositories);
    const models:Model[]=[];
    for(const [engine,provider] of Object.entries(this.providers)) {
      try {models.push(...await provider.probe());}
      catch(error){
        const reason=code(error),availability=/auth|subscription|login/.test(reason)?'auth_required':/rate_limit|usage_limit/.test(reason)?'rate_limited':'unavailable';
        models.push(...this.capabilities.models.filter(m=>m.engine===engine).map(m=>({...m,availability} as Model)));
        this.log('provider_blocked',engine+':'+reason);
      }
    }
    this.capabilities.models=models;this.catalogAt=Date.now();
  }
  async heartbeat() {
    if(!this.capabilities)throw new Error('worker_not_initialized');
    this.capabilities.draining=this.draining||this.stabilizing;
    if(this.projection)this.capabilities.configRevision=this.projection.configRevision;
    const response=await this.client.request<Heartbeat>('/v1/heartbeat',this.capabilities);
    // Lease renewal remains independent of model discovery, Git operations and new-config downloads.
    await Promise.all([...this.active.values()].map(async active=>{
      if(active.reason)return;
      const wall=Date.now(),mono=performance.now();
      try {
        const lease=await this.client.request<{leaseDuration:number;interruptGrace:number}>('/v1/renew',{attemptId:active.claim.attemptId,generation:active.claim.generation});
        active.clock.renew(wall,mono,{duration:lease.leaseDuration,interruptGrace:lease.interruptGrace});
      }catch(error){if(error instanceof DispatcherError&&error.status===409)void this.interrupt(active,'lease_lost').catch(e=>this.log('interrupt_failed',code(e)));}
    }));
    const delivery=this.delivery;
    if(delivery&&!delivery.controller.signal.aborted){
      const wall=Date.now(),mono=performance.now();
      try{const lease=await this.client.request<{leaseDuration:number}>('/v1/deliveries/'+delivery.claim.id+'/renew');delivery.clock.renew(wall,mono,{duration:lease.leaseDuration,interruptGrace:delivery.interruptGrace});}
      catch(error){if(error instanceof DispatcherError&&error.status===409)delivery.controller.abort();}
    }
    for(const control of response.controls) {
      if(this.controlTasks.has(control.id))continue;
      const task=this.applyControl(control).catch(error=>this.log('control_failed',code(error))).finally(()=>this.controlTasks.delete(control.id));
      this.controlTasks.set(control.id,task);
    }
    // Only one synchronization is needed; failed downloads leave the current snapshot intact.
    await this.sync(response.configRevision);
  }
  private async interrupt(active:Active,reason:NonNullable<Active['reason']>) {
    if(active.reason)return;active.reason=reason;active.controller.abort();
    const forced=setTimeout(()=>{void active.run?.close().catch(()=>{});},Math.max(1,active.claim.interruptGrace/2));
    void active.run?.interrupt().catch(()=>{});
    try {await active.task;}finally{clearTimeout(forced);}
  }
  private async applyControl(message:Heartbeat['controls'][number]) {
    const active=this.active.get(message.attemptId);if(!active)return;
    const path=join(this.directory,'controls',message.id+'.json');
    const applied=await readFile(path,'utf8').then(()=>true,()=>false);
    if(!applied) {
      if(message.control.kind==='stop')await this.interrupt(active,'stop');
      else if(active.claim.runConfig.engine==='claude') {
        await this.interrupt(active,'steer');
        const wall=Date.now(),mono=performance.now();
        const next=await this.client.request<{claim:WorkClaim}>('/v1/steer-restart',{attemptId:active.claim.attemptId,generation:active.claim.generation,controlId:message.id});
        this.start(next.claim,wall,mono);
      } else {
        if(!active.run)throw new Error('provider_not_started');
        await active.run.steer(message.control.text,message.id);
      }
      await atomicWrite(path,{applied:true});
    }
    await this.client.request('/v1/controls/'+message.id+'/ack');
  }
  start(claim:WorkClaim,sentWall=Date.now(),sentMono=performance.now()) {
    validateRunConfig(claim.runConfig);
    if(claim.session.host!==this.config.hostname||!claim.runConfig.payload.github.repositories.some(r=>r.toLowerCase()===claim.session.repository.toLowerCase()))throw new Error('claim_repository_not_allowed');
    if(this.active.size>=this.config.maxConcurrentSessions||this.active.has(claim.attemptId))throw new Error('worker_capacity_exceeded');
    if(!this.providers[claim.runConfig.engine])throw new Error('provider_disabled');
    const clock=new LeaseClock();clock.renew(sentWall,sentMono,{duration:claim.leaseDuration,interruptGrace:claim.interruptGrace});
    const active:Active={claim,clock,startedAt:Date.now(),controller:new AbortController(),task:Promise.resolve()};
    this.active.set(claim.attemptId,active);
    const trace={attemptId:claim.attemptId,turnId:claim.turnId,sessionId:claim.session.id,generation:claim.generation,model:claim.runConfig.model,effort:claim.runConfig.effort,configRevision:claim.runConfig.configRevision,runConfigRevision:claim.runConfig.runConfigRevision};
    this.log('attempt_started',undefined,trace);
    active.task=this.execute(active).catch(error=>this.log('attempt_failed',code(error),trace)).finally(()=>{this.active.delete(claim.attemptId);this.log('attempt_closed',active.reason,trace);});
    return active.task;
  }
  private async execute(active:Active) {
    const {claim}=active;let result:Result|undefined;
    await atomicWrite(join(this.directory,'attempts',claim.attemptId+'.json'),{claim,state:'starting'});
    try {
      const context=await this.github.context(claim,active.controller.signal);
      const workspace=await this.github.workspace(this.directory,claim.session,active.controller.signal);
      if(!active.clock.canRun()||active.controller.signal.aborted)throw new Error('lease_expired_before_start');
      const sessionPath=join(this.directory,'sessions',claim.session.id+'-'+claim.runConfig.engine+'.json');
      const previous=await readFile(sessionPath,'utf8').then(s=>JSON.parse(s) as ProviderState,()=>undefined);
      const resume=previous?.engine===claim.runConfig.engine&&previous.workspace===workspace?previous:undefined;
      active.run=this.providers[claim.runConfig.engine]!.run({claim,context,workspace,...(resume?{resume}:{}),signal:active.controller.signal,onSession:state=>atomicWrite(sessionPath,state)});
      result=await active.run.result;
    }catch(error) {
      if(!active.reason) {
        if(['input_changed_before_start','input_deleted','requester_no_longer_has_write_access'].includes(code(error)))active.reason='refresh';
        else if(['github_request_failed','github_pagination_failed','workspace_clone_failed','pull_checkout_failed'].includes(code(error))){active.reason='github_blocked';if(this.capabilities)this.capabilities.repositories=this.capabilities.repositories.filter(r=>r.toLowerCase()!==claim.session.repository.toLowerCase());this.log('github_blocked',code(error));}
        else if(/rate_limit|usage_limit|auth_required|subscription_login_required|runtime_exited|exited_before_result|rpc_timeout/.test(code(error))){
          active.reason='provider_blocked';
          const availability=/rate_limit|usage_limit/.test(code(error))?'rate_limited':/auth|subscription/.test(code(error))?'auth_required':'unavailable';
          if(this.capabilities)this.capabilities.models=this.capabilities.models.map(m=>m.engine===claim.runConfig.engine?{...m,availability}:m);
          this.catalogAt=Date.now();this.log('provider_blocked',claim.runConfig.engine+':'+code(error));
        }
        else result={kind:'failed',text:'Worker 실행 실패: '+code(error),origin:'runtime'};
      }
    }finally {
      await active.run?.close();
    }
    const identity={attemptId:claim.attemptId,generation:claim.generation};
    if(active.reason==='steer')return;
    if(active.reason==='stop') {await this.client.request('/v1/cancel',identity);return;}
    if(active.reason==='shutdown'||active.reason==='lease_lost'||active.reason==='refresh'||active.reason==='provider_blocked'||active.reason==='github_blocked') {
      await this.client.request('/v1/release',identity).catch(()=>{});
      if(active.reason==='provider_blocked'||active.reason==='github_blocked')await this.heartbeat().catch(()=>{});return;
    }
    if(result) {
      await writeResult(this.directory,claim.attemptId,{generation:claim.generation,result});
      await this.flushResults();
      if(result.kind!=='failed')try{
        for(const pullNumber of await this.github.verifyOutput(claim,result,active.startedAt,active.controller.signal))this.log('output_attribution_missing',undefined,{attemptId:claim.attemptId,sessionId:claim.session.id,pullNumber});
      }catch(error){this.log('output_verification_unavailable',code(error),{attemptId:claim.attemptId,sessionId:claim.session.id});}
    }
  }
  flushResults():Promise<void> {
    if(!this.flushing)this.flushing=this.flushJournal().finally(()=>{this.flushing=undefined;});
    return this.flushing;
  }
  private async flushJournal() {
    const root=join(this.directory,'journal');const names=await readdir(root).catch(()=>[]);
    for(const name of names.filter(n=>/^[a-zA-Z0-9_-]+\.json$/.test(n))) {
      const path=join(root,name);
      const record=JSON.parse(await readFile(path,'utf8')) as {attemptId:string;result:{generation:number;result:Result};resultHash:string};
      if(hash(record.result)!==record.resultHash)throw new Error('result_journal_corrupt');
      try {
        await this.client.request('/v1/complete',{attemptId:record.attemptId,...record.result});await unlink(path).catch(()=>{});
      }catch(error) {
        if(error instanceof DispatcherError&&error.status===409) {
          await mkdir(join(this.directory,'rejected-results'),{recursive:true});await rename(path,join(this.directory,'rejected-results',name)).catch(()=>{});
        }else throw error;
      }
    }
  }
  async work(signal?:AbortSignal,longPoll=false) {
    if(!this.projection||this.stabilizing||signal?.aborted)return;
    await this.flushResults();
    const sentWall=Date.now(),sentMono=performance.now();
    const delivery=await this.client.request<{delivery:DeliveryClaim|null}>('/v1/deliveries/claim');
    if(delivery.delivery) {
      const d=delivery.delivery,controller=new AbortController(),clock=new LeaseClock(),interruptGrace=Math.min(this.projection.payload.runtime.interruptGrace,d.leaseDuration/3);
      clock.renew(sentWall,sentMono,{duration:d.leaseDuration,interruptGrace});this.delivery={claim:d,clock,controller,interruptGrace};
      if(!clock.canRun())controller.abort();
      try{await publishDelivery(this.directory,this.github,d,()=>this.client.request('/v1/deliveries/'+d.id+'/begin'),id=>this.client.request('/v1/deliveries/'+d.id+'/receipt',{githubId:id}),signal?AbortSignal.any([signal,controller.signal]):controller.signal);}
      finally{this.delivery=undefined;}
    }
    while(this.active.size<this.config.maxConcurrentSessions&&!this.draining&&!this.stabilizing&&!signal?.aborted) {
      const wall=Date.now(),mono=performance.now();const {claim}=await this.client.request<{claim:WorkClaim|null}>('/v1/claim'+(longPoll?'?wait=1':''),undefined,signal?{signal}:{});
      if(!claim)break;
      if(this.draining||this.stabilizing||signal?.aborted){await this.client.request('/v1/release',{attemptId:claim.attemptId,generation:claim.generation});break;}
      this.start(claim,wall,mono);
    }
  }
  checkLeases() {if(this.delivery&&!this.delivery.clock.canRun())this.delivery.controller.abort();for(const active of this.active.values())if(!active.clock.canRun())void this.interrupt(active,'lease_lost').catch(e=>this.log('interrupt_failed',code(e)));}
  activate(){this.stabilizing=false;}
  setUpdateHandler(handler:(p:Projection,signal:AbortSignal)=>Promise<void>){this.updateCheck=handler;}
  async drain(timeout:number,signal?:AbortSignal) {
    this.draining=true;
    const deadline=Date.now()+timeout;
    while(this.active.size&&Date.now()<deadline&&!signal?.aborted)await delay(Math.min(100,Math.max(1,deadline-Date.now())));
    await this.settleControls();
    await Promise.all([...this.active.values()].map(a=>this.interrupt(a,'shutdown')));
    await this.flushResults().catch(()=>{});
  }
  async settleControls() {await Promise.all([...this.controlTasks.values()]);}
  async run(signal:AbortSignal,registrationToken?:string) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    this.projection=await readLatestProjection(this.directory).catch(()=>undefined);
    if(this.projection?.payload.github.hostname!==this.config.hostname)this.projection=undefined;
    for(const name of await readdir(join(this.directory,'journal')).catch(()=>[])){if(!name.endsWith('.json'))continue;const record=JSON.parse(await readFile(join(this.directory,'journal',name),'utf8')) as {result:unknown;resultHash:string};if(hash(record.result)!==record.resultHash)throw new Error('result_journal_corrupt');}
    process.send?.({type:'READY',protocolVersion:1});
    let backoff=1000,offlineUpdateAt=0;
    while(!signal.aborted) {
      try{await this.initialize(registrationToken);break;}catch(error){this.log('worker_reconnecting',code(error));if(this.projection&&!this.stabilizing&&!signal.aborted&&Date.now()>=offlineUpdateAt){offlineUpdateAt=Date.now()+this.projection.payload.updates.checkInterval;await this.updateCheck?.(this.projection,signal).catch(e=>this.log('update_retrying',code(e)));}await delay(backoff,undefined,{signal}).catch(()=>{});backoff=Math.min(backoff*2,30000);}
    }
    const loop=async(task:()=>Promise<void>|void,interval:()=>number)=>{
      let failureDelay=0;
      while(!signal.aborted){
        try{await task();failureDelay=0;}
        catch(error){this.log('worker_retrying',code(error));const policy=this.projection?.payload.runtime.reconnect;failureDelay=Math.min(failureDelay?failureDelay*2:policy?.initialDelay??1000,policy?.maxDelay??30000);}
        await delay(failureDelay||interval(),undefined,{signal}).catch(()=>{});
      }
    };
    await Promise.all([
      loop(async()=>{if(this.projection&&!this.stabilizing&&!this.draining)await this.updateCheck?.(this.projection,signal);},()=>this.projection?.payload.updates.checkInterval??60000),
      loop(()=>this.heartbeat(),()=>this.projection?.payload.runtime.heartbeatInterval??15000),
      loop(()=>this.work(signal,true),()=>this.projection?.payload.runtime.reconnect.initialDelay??1000),
      loop(()=>this.checkLeases(),()=>250),
      loop(async()=>{if(this.projection&&Date.now()-this.catalogAt>=this.projection.payload.runtime.modelCatalogRefreshInterval)await this.refreshCapabilities();},()=>this.projection?.payload.runtime.configCheckInterval??30000),
    ]);
    this.draining=true;
    await this.settleControls();
    await Promise.all([...this.active.values()].map(a=>this.interrupt(a,'shutdown')));
    await this.flushResults().catch(()=>{});
  }
}
