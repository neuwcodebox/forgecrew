import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,writeFile,rm,chmod,rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { parse,stringify } from 'yaml';

const exec=promisify(execFile),image=process.env.FORGECREW_TEST_IMAGE??'forgecrew-dispatcher:test';
const id=randomUUID(),name='forgecrew-smoke-'+id,restored=name+'-restored',volume=name+'-data',backup=name+'-backup';
const directory=await mkdtemp(join(tmpdir(),'forgecrew-docker-')),configPath=join(directory,'config.yaml');
async function docker(args){return (await exec('docker',args,{timeout:120000,maxBuffer:2*1024*1024})).stdout.trim();}
const token='w'.repeat(48),registration='r'.repeat(48);
const capabilities={id,githubLogin:'fixture',githubId:'1',version:'0.1.0',schemaVersions:[1],maxConcurrentSessions:1,repositories:[],models:[],draining:false};
async function request(container,path,body,register=false){
  const script=`const r=await fetch('http://127.0.0.1:8080'+${JSON.stringify(path)},{method:${JSON.stringify(body?'POST':'GET')},headers:{Authorization:'Bearer '+${JSON.stringify(register?registration:token)},'X-ForgeCrew-Worker':${JSON.stringify(id)},'Content-Type':'application/json'},${body?'body:'+JSON.stringify(JSON.stringify(body))+',':''}});console.log(JSON.stringify({status:r.status,body:await r.json()}));`;
  return JSON.parse(await docker(['exec',container,'node','--input-type=module','-e',script]));
}
async function ready(container,predicate=()=>true){
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){try{const r=await request(container,'/health/ready');if(r.status===200&&predicate(r.body))return r.body;}catch{}await new Promise(r=>setTimeout(r,100));}
  throw new Error('container_readiness_timeout');
}
async function start(container,data){
  await docker(['run','-d','--name',container,'--network','none','--read-only','--tmpfs','/tmp','--mount',`type=volume,source=${data},target=/data`,'--mount',`type=bind,source=${directory},target=/config,readonly`,'--env','FORGECREW_GITHUB_PAT=smoke-only','--env','FORGECREW_REGISTRATION_TOKEN='+registration,image]);await ready(container);
}
try{
  const c=parse(await readFile(new URL('../config.example.yaml',import.meta.url),'utf8'));
  c.server={...c.server,listen:'0.0.0.0',port:8080,dataDir:'/data',configReloadInterval:'50ms'};
  c.github.hostname='github.invalid';c.github.apiBaseUrl='https://github.invalid/api/v3';c.github.polling.interval='50ms';
  await chmod(directory,0o755);await writeFile(configPath,stringify(c),{mode:0o644});
  await docker(['volume','create',volume]);await docker(['volume','create',backup]);await start(name,volume);
  assert.equal((await request(name,'/v1/register',{token,capabilities},true)).status,200);
  const previous=await ready(name);
  await writeFile(configPath+'.next','invalid: [');await rename(configPath+'.next',configPath);
  const invalid=await ready(name,r=>r.configError);assert.equal(invalid.configRevision,previous.configRevision);
  c.agent.instructions+='\nDocker atomic replacement smoke.';await writeFile(configPath+'.next',stringify(c));await rename(configPath+'.next',configPath);
  await ready(name,r=>!r.configError&&r.configRevision!==previous.configRevision);
  await docker(['restart','--time','45',name]);await ready(name);
  assert.equal((await request(name,'/v1/heartbeat',capabilities)).status,200,'SQLite state did not survive restart');
  await docker(['stop','--time','45',name]);
  assert.equal(await docker(['inspect','--format','{{.State.ExitCode}}',name]),'0');
  // Copy a stopped SQLite directory, including WAL/SHM when present, into a separate volume.
  await docker(['run','--rm','--network','none','--read-only','--user','node','--mount',`type=volume,source=${volume},target=/backup,readonly`,'--mount',`type=volume,source=${backup},target=/data`,'--entrypoint','node',image,'-e',"require('node:fs').cpSync('/backup','/data',{recursive:true})"]);
  await start(restored,backup);
  assert.equal((await request(restored,'/v1/heartbeat',capabilities)).status,200,'SQLite backup did not restore Worker identity');
  console.log('Docker non-root/read-only startup, native SQLite, atomic YAML reload, restart and stopped-volume backup/restore passed without external network.');
}finally{
  for(const container of [name,restored])await docker(['rm','--force',container]).catch(()=>{});
  for(const data of [volume,backup])await docker(['volume','rm',data]).catch(()=>{});
  await rm(directory,{recursive:true,force:true});
}
