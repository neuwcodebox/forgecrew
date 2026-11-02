#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes,randomUUID } from 'node:crypto';
import { LocalConfigSchema,atomicWrite } from './local.ts';
import { doctor } from './doctor.ts';
import { WorkerRuntime } from './runtime.ts';
import { acquireLock } from './lock.ts';

async function main() {
  const args=process.argv.slice(2);
  const value=(name:string)=>{const i=args.indexOf('--'+name);if(i<0)return undefined;const result=args[i+1];if(!result||result.startsWith('--'))throw new Error('missing_option_value');return result;};
  if(args[0]==='--help'||args.length===0) {
    console.log('ForgeCrew 0.1.0\n\n  forgecrew setup --dispatcher <https://...> --hostname <github-host> --engine <codex|claude|both> [--config <worker.json>]\n  forgecrew run [--config <worker.json>]\n  forgecrew doctor [--config <worker.json>]\n\n최초 등록에는 FORGECREW_REGISTRATION_TOKEN 환경변수를 지정합니다.\n백그라운드 Launcher와 무인 업데이트는 개발 중입니다.');return;
  }
  if(!['setup','run','doctor'].includes(args[0]!))throw new Error('unsupported_command');
  const directory=process.env.FORGECREW_DATA_DIR??(process.platform==='win32'?join(process.env.LOCALAPPDATA??homedir(),'ForgeCrew'):join(process.env.XDG_DATA_HOME??join(homedir(),'.local','share'),'forgecrew'));
  const configPath=value('config')??join(directory,'config.json');
  if(args[0]==='setup') {
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
    const runtime=new WorkerRuntime(config,join(directory,'workers',config.id));
    await runtime.initialize(process.env.FORGECREW_REGISTRATION_TOKEN);
    console.log('Worker setup complete. Run forgecrew run using the same configuration.');return;
  }
  const config=LocalConfigSchema.parse(JSON.parse(await readFile(configPath,'utf8')));
  if(args[0]==='run') {
    const runtimeDirectory=join(directory,'workers',config.id);const release=await acquireLock(join(runtimeDirectory,'worker.lock'));
    const controller=new AbortController();const stop=()=>controller.abort();
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{await new WorkerRuntime(config,runtimeDirectory).run(controller.signal,process.env.FORGECREW_REGISTRATION_TOKEN);}
    finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await release();}return;
  }
  const diagnostics=await doctor(config);console.log(JSON.stringify(diagnostics,null,2));
  if(diagnostics.some(c => c.status==='blocked'))process.exitCode=1;
}
main().catch(() => {console.error('Worker command failed. Check the command and local worker configuration.');process.exitCode=1;});
