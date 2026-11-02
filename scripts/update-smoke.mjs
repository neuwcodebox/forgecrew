import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp,mkdir,readFile,writeFile,cp,rm } from 'node:fs/promises';
import { join,resolve,delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID,createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseConfig,workerProjection } from '../packages/shared/src/config.ts';
import { command } from '../packages/worker/src/process.ts';
import { prepareLauncher } from '../packages/worker/src/launcher/install.ts';
import { startLauncher,stopLauncher,launcherStatus } from '../packages/worker/src/launcher/control.ts';
import { atomicWrite,cacheProjection,writeResult } from '../packages/worker/src/local.ts';

const dir=await mkdtemp(join(tmpdir(),'forgecrew-update-')),data=join(dir,'data'),pkg=resolve('packages/worker');
const releases=new Map(),downloads=[],requests=[];let latest='0.1.1',registry;
const server=createServer((request,response)=>{
  const path=decodeURIComponent(new URL(request.url,'http://localhost').pathname);requests.push(path);
  const release=[...releases.values()].find(r=>path===r.path);
  if(release){downloads.push(release.manifest.version);response.setHeader('Content-Type','application/octet-stream');response.end(release.bytes);return;}
  if(path==='/@forgecrew/worker'){
    response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');
    response.end(JSON.stringify({name:'@forgecrew/worker','dist-tags':{latest},versions:Object.fromEntries([...releases].map(([v,r])=>[v,{...r.manifest,dist:{integrity:r.integrity,tarball:registry+r.path}}]))}));return;
  }
  response.writeHead(404);response.end();
});
const envKeys=['npm_config_userconfig','npm_config_cache'];const oldEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
async function release(version,broken=false){
  const root=join(dir,'release-'+version);await cp(pkg,root,{recursive:true});
  const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));manifest.version=version;await atomicWrite(join(root,'package.json'),manifest);
  if(broken)await writeFile(join(root,'dist','cli.js'),'#!/usr/bin/env node\nprocess.exit(42);\n');
  const pack=await command('npm',['pack',root,'--pack-destination',dir,'--json','--ignore-scripts'],{timeout:60000});assert.equal(pack.code,0,'fixture release pack failed');
  const bytes=await readFile(join(dir,JSON.parse(pack.stdout)[0].filename));
  releases.set(version,{manifest,bytes,path:'/worker-'+version+'.tgz',integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')});
}
async function pointer(){return JSON.parse(await readFile(join(data,'current.json'),'utf8'));}
async function until(read,predicate){
  const deadline=Date.now()+90000;
  while(true){const result=await read();if(predicate(result))return result;assert.ok(Date.now()<deadline,'update condition timed out: '+JSON.stringify(result));await new Promise(r=>setTimeout(r,100));}
}
try{
  await release('0.1.1');await release('0.1.2',true);
  server.listen(0,'127.0.0.1');await once(server,'listening');registry='http://127.0.0.1:'+server.address().port;
  const id=randomUUID(),configPath=join(data,'config.json'),runtime=join(data,'workers',id);
  const config={schemaVersion:1,id,token:'u'.repeat(48),dispatcher:'http://127.0.0.1:1',hostname:'github.invalid',maxConcurrentSessions:2,engines:{codex:'unused-smoke-provider'}};
  await atomicWrite(configPath,config);await prepareLauncher(data,pkg,configPath);
  const c=parseConfig(await readFile(new URL('../config.example.yaml',import.meta.url),'utf8'));
  c.github.hostname=config.hostname;c.github.apiBaseUrl='https://github.invalid/api/v3';
  Object.assign(c.updates,{registry,package:'@forgecrew/worker',channel:'latest',checkInterval:1000,drainTimeout:1000,stabilizationWindow:100,failedVersionCooldown:30000});
  await cacheProjection(runtime,workerProjection(c));
  await mkdir(join(runtime,'workspaces'),{recursive:true});const dirty=join(runtime,'workspaces','preserved.txt');await writeFile(dirty,'local changes');
  await writeResult(runtime,'unacknowledged',{generation:1,result:{kind:'completed',text:'preserved result'}});
  const journal=join(runtime,'journal','unacknowledged.json'),before=await readFile(journal,'utf8');
  const bin=join(dir,'bin');await mkdir(bin);
  if(process.platform==='win32')await writeFile(join(bin,'gh.cmd'),'@exit /b 1\r\n');
  else await writeFile(join(bin,'gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
  const launch=JSON.parse(await readFile(join(data,'launch.json'),'utf8'));launch.path=bin+delimiter+launch.path;await atomicWrite(join(data,'launch.json'),launch);
  // A pre-existing scope registry must not override the centrally selected update source.
  const npmrc=join(dir,'npmrc');await writeFile(npmrc,'@forgecrew:registry=http://127.0.0.1:1/\n');
  process.env.npm_config_userconfig=npmrc;process.env.npm_config_cache=join(dir,'npm-cache');
  await startLauncher(data);
  const good=await until(pointer,p=>p.active.startsWith('0.1.1-')&&p.pending===null);
  assert.equal(good.lastKnownGood,good.active);assert.ok(downloads.includes('0.1.1'),'exact package tarball was not downloaded');
  latest='0.1.2';
  const rolledBack=await until(pointer,p=>Object.keys(p.failed).some(id=>id.startsWith('0.1.2-'))&&p.pending===null);
  assert.equal(rolledBack.active,good.active);assert.ok(downloads.includes('0.1.2'));
  await until(()=>launcherStatus(data),s=>s.event==='running');
  assert.equal(await readFile(dirty,'utf8'),'local changes');assert.equal(await readFile(journal,'utf8'),before);
  assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),config);assert.ok(requests.includes('/@forgecrew/worker'));
  await stopLauncher(data);
  console.log('Actual npm registry/tarball staging, automatic Worker handoff, failed-version rollback and persistent identity/journal/workspace passed on loopback only.');
}catch(error){
  for(const name of ['current.json','status.json','launcher-error.json','logs/launcher.log','logs/worker.log']){const text=await readFile(join(data,name),'utf8').catch(()=>undefined);if(text)console.error(name+': '+text.slice(-6000));}
  throw error;
}finally{
  await stopLauncher(data).catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));
  for(const key of envKeys)if(oldEnv[key]===undefined)delete process.env[key];else process.env[key]=oldEnv[key];
  await rm(dir,{recursive:true,force:true});
}
