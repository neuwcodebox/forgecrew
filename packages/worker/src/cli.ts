#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join,dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes,randomUUID } from 'node:crypto';
import { LocalConfigSchema,atomicWrite } from './local.ts';
import { DispatcherClient } from './client.ts';
import { doctor } from './doctor.ts';
import { workerVersion } from './version.ts';
import { WorkerRuntime } from './runtime.ts';
import { acquireLock } from './lock.ts';
import { prepareLauncher } from './launcher/install.ts';
import { startLauncher,stopLauncher,launcherStatus } from './launcher/control.ts';
import { setAutostart } from './launcher/autostart.ts';
import { UpdateManager } from './launcher/update.ts';

async function main() {
  const args=process.argv.slice(2);
  const value=(name:string)=>{const i=args.indexOf('--'+name);if(i<0)return undefined;const result=args[i+1];if(!result||result.startsWith('--'))throw new Error('missing_option_value');return result;};
  if(args[0]==='--help'||args.length===0) {
    console.log('ForgeCrew '+workerVersion+'\n\n  forgecrew setup --dispatcher <https://...> --hostname <github-host> --engine <codex|claude|both> [--config <worker.json>]\n  forgecrew start | stop | status\n  forgecrew run [--config <worker.json>]\n  forgecrew autostart enable | disable\n  forgecrew doctor [--config <worker.json>]\n\n최초 등록에는 FORGECREW_REGISTRATION_TOKEN 환경변수를 지정합니다.\nsetup --autostart로 로그인 자동 시작을 등록할 수 있습니다.');return;
  }
  if(!['setup','run','doctor','start','stop','status','autostart'].includes(args[0]!))throw new Error('unsupported_command');
  const directory=resolve(process.env.FORGECREW_DATA_DIR??(process.platform==='win32'?join(process.env.LOCALAPPDATA??homedir(),'ForgeCrew'):join(process.env.XDG_DATA_HOME??join(homedir(),'.local','share'),'forgecrew')));
  const configPath=resolve(value('config')??join(directory,'config.json'));
  if(args[0]==='start'){await startLauncher(directory);console.log(JSON.stringify(await launcherStatus(directory),null,2));return;}
  if(args[0]==='stop'){await stopLauncher(directory);console.log('Worker stopped.');return;}
  if(args[0]==='status'){
    const launch=await readFile(join(directory,'launch.json'),'utf8').then(s=>JSON.parse(s) as {configPath:string}).catch(()=>undefined);
    const local=await readFile(value('config')??launch?.configPath??configPath,'utf8').then(s=>LocalConfigSchema.parse(JSON.parse(s))).catch(()=>undefined);
    let dispatcher:unknown={available:false,reason:'local_configuration_unavailable'};
    if(local)try{dispatcher=await new DispatcherClient(local).request('/v1/status',undefined,{method:'GET',timeout:5000});}catch{dispatcher={available:false,reason:'dispatcher_status_unavailable'};}
    console.log(JSON.stringify({launcher:await launcherStatus(directory),dispatcher},null,2));return;
  }
  if(args[0]==='autostart'){if(!['enable','disable'].includes(args[1]??''))throw new Error('autostart_mode_required');await setAutostart(directory,args[1]==='enable');console.log('Login autostart '+args[1]+'d.');return;}
  if(args[0]==='setup') {
    if((await launcherStatus(directory)).running)throw new Error('stop_launcher_before_setup');
    const existing=await readFile(configPath,'utf8').then(s=>LocalConfigSchema.parse(JSON.parse(s)),error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
    const engine=value('engine');
    if(engine!==undefined&&!['codex','claude','both'].includes(engine))throw new Error('invalid_engine');
    if(!existing&&!['codex','claude','both'].includes(engine??''))throw new Error('engine_required');
    const config=existing??LocalConfigSchema.parse({schemaVersion:1,id:randomUUID(),token:randomBytes(32).toString('base64url'),dispatcher:value('dispatcher'),hostname:value('hostname'),maxConcurrentSessions:Number(value('sessions')??2),engines:{...(engine==='codex'||engine==='both'?{codex:value('codex')??'codex'}:{}),...(engine==='claude'||engine==='both'?{claude:value('claude')??'claude'}:{})}});
    if(existing) {
      config.dispatcher=value('dispatcher')??config.dispatcher;config.hostname=value('hostname')??config.hostname;
      if(value('sessions')!==undefined)config.maxConcurrentSessions=Number(value('sessions'));
      if(engine)config.engines={...(engine==='codex'||engine==='both'?{codex:value('codex')??existing.engines.codex??'codex'}:{}),...(engine==='claude'||engine==='both'?{claude:value('claude')??existing.engines.claude??'claude'}:{})};
      LocalConfigSchema.parse(config);
    }
    await atomicWrite(configPath,config);
    await prepareLauncher(directory,dirname(dirname(fileURLToPath(import.meta.url))),configPath);
    const runtime=new WorkerRuntime(config,join(directory,'workers',config.id));
    await runtime.initialize(process.env.FORGECREW_REGISTRATION_TOKEN);
    if(args.includes('--autostart'))await setAutostart(directory,true);
    console.log('Worker setup complete. Run forgecrew start.');return;
  }
  const config=LocalConfigSchema.parse(JSON.parse(await readFile(configPath,'utf8')));
  if(args[0]==='run') {
    const runtimeDirectory=join(directory,'workers',config.id);const release=await acquireLock(join(runtimeDirectory,'worker.lock'));
    const controller=new AbortController();const stop=()=>controller.abort();
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    const runtime=new WorkerRuntime(config,runtimeDirectory),updater=new UpdateManager(directory);
    runtime.setUpdateHandler((p,signal)=>updater.check(p,timeout=>runtime.drain(timeout,signal),signal));
    const message=(m:unknown)=>{const v=m as {type?:string;protocolVersion?:number;id?:string};if(v?.protocolVersion!==1)return;if(v.type==='STOP')stop();if(v.type==='HEALTH'&&process.connected)process.send?.({type:'HEALTH',protocolVersion:1});if(v.type==='ACTIVATE')runtime.activate();if(v.type==='STAGE_ACCEPTED'&&v.id)updater.acknowledge(v.id);};
    process.on('message',message);process.once('disconnect',stop);
    try{await runtime.run(controller.signal,process.env.FORGECREW_REGISTRATION_TOKEN);}
    finally{process.removeListener('message',message);process.removeListener('disconnect',stop);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await release();}return;
  }
  const diagnostics=await doctor(config);console.log(JSON.stringify(diagnostics,null,2));
  if(diagnostics.some(c => c.status==='blocked'))process.exitCode=1;
}
main().catch(error => {const reason=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'invalid_configuration_or_operation';console.error('Worker command failed: '+reason);process.exitCode=1;});
