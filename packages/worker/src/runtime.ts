import { readFile, readdir, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LocalConfig } from './local.ts';
import { atomicWrite, cacheProjection, LeaseClock, writeResult } from './local.ts';
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

type Active={claim:WorkClaim;clock:LeaseClock;controller:AbortController;run?:ProviderRun;task:Promise<void>;reason?:'stop'|'shutdown'|'lease_lost'|'steer'|'refresh';};
type Heartbeat={configRevision:string;controls:{id:string;attemptId:string;control:Control}[]};
type Dependencies={client?:DispatcherClient;github?:GhClient;providers?:Partial<Record<Engine,Provider>>};
const code=(error:unknown)=>error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'worker_operation_failed';

export class WorkerRuntime {
  readonly config:LocalConfig;
  readonly directory:string;
  readonly client:DispatcherClient;
  readonly github:GhClient;
  readonly providers:Partial<Record<Engine,Provider>>;
  readonly active=new Map<string,Active>();
  private controlTasks=new Map<string,Promise<void>>();
  private capabilities:WorkerCapabilities|undefined;
  private projection:Projection|undefined;
  private catalogAt=0;
  private draining=false;
  private flushing:Promise<void>|undefined;
  constructor(config:LocalConfig,directory:string,dependencies:Dependencies={}) {
    this.config=config;this.directory=directory;this.client=dependencies.client??new DispatcherClient(config);
    this.github=dependencies.github??new GhClient(config.hostname);
    this.providers=dependencies.providers??{
      ...(config.engines.codex?{codex:new CodexProvider(config.engines.codex)}:{}),
      ...(config.engines.claude?{claude:new ClaudeProvider(config.engines.claude)}:{}),
    };
  }
  private log(event:string,reason?:string) {console.log(JSON.stringify({event,workerId:this.config.id,...(reason?{reason}:{})}));}
  async initialize(registrationToken?:string) {
    const account=await this.github.account();
    this.capabilities={id:this.config.id,githubLogin:account.login,githubId:String(account.id),version:'0.1.0',schemaVersions:[1],maxConcurrentSessions:this.config.maxConcurrentSessions,repositories:[],models:[],draining:false};
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
    await cacheProjection(this.directory,p);this.projection=p;
  }
  async refreshCapabilities() {
    if(!this.projection||!this.capabilities)return;
    this.capabilities.repositories=await this.github.repositories(this.projection.payload.github.repositories);
    const models:Model[]=[];
    for(const [engine,provider] of Object.entries(this.providers)) {
      try {models.push(...await provider.probe());}
      catch(error){this.log('provider_blocked',engine+':'+code(error));}
    }
    this.capabilities.models=models;this.catalogAt=Date.now();
  }
  async heartbeat() {
    if(!this.capabilities)throw new Error('worker_not_initialized');
    this.capabilities.draining=this.draining;
    const response=await this.client.request<Heartbeat>('/v1/heartbeat',this.capabilities);
    // Lease renewal remains independent of model discovery, Git operations and new-config downloads.
    await Promise.all([...this.active.values()].map(async active=>{
      const wall=Date.now(),mono=performance.now();
      try {
        const lease=await this.client.request<{leaseDuration:number;interruptGrace:number}>('/v1/renew',{attemptId:active.claim.attemptId,generation:active.claim.generation});
        active.clock.renew(wall,mono,{duration:lease.leaseDuration,interruptGrace:lease.interruptGrace});
      }catch(error){if(error instanceof DispatcherError&&error.status===409)void this.interrupt(active,'lease_lost').catch(e=>this.log('interrupt_failed',code(e)));}
    }));
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
    const active:Active={claim,clock,controller:new AbortController(),task:Promise.resolve()};
    this.active.set(claim.attemptId,active);
    active.task=this.execute(active).catch(error=>this.log('attempt_failed',code(error))).finally(()=>this.active.delete(claim.attemptId));
    return active.task;
  }
  private async execute(active:Active) {
    const {claim}=active;let result:Result|undefined;
    await atomicWrite(join(this.directory,'attempts',claim.attemptId+'.json'),{claim,state:'starting'});
    try {
      const context=await this.github.context(claim);
      const workspace=await this.github.workspace(this.directory,claim.session);
      if(!active.clock.canRun()||active.controller.signal.aborted)throw new Error('lease_expired_before_start');
      const sessionPath=join(this.directory,'sessions',claim.session.id+'-'+claim.runConfig.engine+'.json');
      const previous=await readFile(sessionPath,'utf8').then(s=>JSON.parse(s) as ProviderState,()=>undefined);
      const resume=previous?.engine===claim.runConfig.engine&&previous.workspace===workspace?previous:undefined;
      active.run=this.providers[claim.runConfig.engine]!.run({claim,context,workspace,...(resume?{resume}:{}),signal:active.controller.signal,onSession:state=>atomicWrite(sessionPath,state)});
      result=await active.run.result;
    }catch(error) {
      if(!active.reason) {
        if(['input_changed_before_start','input_deleted','requester_no_longer_has_write_access'].includes(code(error)))active.reason='refresh';
        else result={kind:'failed',text:'Worker 실행 실패: '+code(error),origin:'runtime'};
      }
    }finally {
      await active.run?.close();
    }
    const identity={attemptId:claim.attemptId,generation:claim.generation};
    if(active.reason==='steer')return;
    if(active.reason==='stop') {await this.client.request('/v1/cancel',identity);return;}
    if(active.reason==='shutdown'||active.reason==='lease_lost'||active.reason==='refresh') {
      await this.client.request('/v1/release',identity).catch(()=>{});return;
    }
    if(result) {
      await writeResult(this.directory,claim.attemptId,{generation:claim.generation,result});
      await this.flushResults();
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
  async work() {
    if(!this.projection||this.draining)return;
    await this.flushResults();
    const delivery=await this.client.request<{delivery:DeliveryClaim|null}>('/v1/deliveries/claim');
    if(delivery.delivery) {
      const d=delivery.delivery;
      await publishDelivery(this.directory,this.github,d,()=>this.client.request('/v1/deliveries/'+d.id+'/begin'),id=>this.client.request('/v1/deliveries/'+d.id+'/receipt',{githubId:id}));
    }
    while(this.active.size<this.config.maxConcurrentSessions&&!this.draining) {
      const wall=Date.now(),mono=performance.now();const {claim}=await this.client.request<{claim:WorkClaim|null}>('/v1/claim');
      if(!claim)break;
      this.start(claim,wall,mono);
    }
  }
  checkLeases() {for(const active of this.active.values())if(!active.clock.canRun())void this.interrupt(active,'lease_lost').catch(e=>this.log('interrupt_failed',code(e)));}
  async settleControls() {await Promise.all([...this.controlTasks.values()]);}
  async run(signal:AbortSignal,registrationToken?:string) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    process.send?.({type:'READY',protocolVersion:1});
    let backoff=1000;
    while(!signal.aborted) {
      try{await this.initialize(registrationToken);break;}catch(error){this.log('worker_reconnecting',code(error));await delay(backoff,undefined,{signal}).catch(()=>{});backoff=Math.min(backoff*2,30000);}
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
      loop(()=>this.heartbeat(),()=>this.projection?.payload.runtime.heartbeatInterval??15000),
      loop(()=>this.work(),()=>this.projection?.payload.runtime.reconnect.initialDelay??1000),
      loop(()=>this.checkLeases(),()=>250),
      loop(async()=>{if(this.projection&&Date.now()-this.catalogAt>=this.projection.payload.runtime.modelCatalogRefreshInterval)await this.refreshCapabilities();},()=>this.projection?.payload.runtime.configCheckInterval??30000),
    ]);
    this.draining=true;
    await this.settleControls();
    await Promise.all([...this.active.values()].map(a=>this.interrupt(a,'shutdown')));
    await this.flushResults().catch(()=>{});
  }
}
