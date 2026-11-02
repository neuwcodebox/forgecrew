#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LocalConfigSchema } from './local.ts';
import { doctor } from './doctor.ts';

async function main() {
  const args=process.argv.slice(2);
  if(args[0]==='--help'||args.length===0) {
    console.log('ForgeCrew 0.1.0\n\n  forgecrew doctor [--config <worker.json>]\n\nWorker 진단과 Dispatcher 기반이 구현된 개발 버전입니다.\nAI 실행·설치·자동 업데이트 명령은 구현 중입니다.');return;
  }
  if(args[0]!=='doctor')throw new Error('unsupported_command');
  const index=args.indexOf('--config');
  if(index>=0&&!args[index+1])throw new Error('missing_config_path');
  const directory=process.env.FORGECREW_DATA_DIR??(process.platform==='win32'?join(process.env.LOCALAPPDATA??homedir(),'ForgeCrew'):join(process.env.XDG_DATA_HOME??join(homedir(),'.local','share'),'forgecrew'));
  const configPath=index<0?join(directory,'config.json'):args[index+1]!;
  const config=LocalConfigSchema.parse(JSON.parse(await readFile(configPath,'utf8')));
  const diagnostics=await doctor(config);console.log(JSON.stringify(diagnostics,null,2));
  if(diagnostics.some(c => c.status==='blocked'))process.exitCode=1;
}
main().catch(() => {console.error('Worker command failed. Check the command and local worker configuration.');process.exitCode=1;});
