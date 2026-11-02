import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';

const directory=await mkdtemp(join(tmpdir(),'forgecrew-smoke-'));
const github=createServer((_req,res) => {res.setHeader('Content-Type','application/json');res.end('[]');});
github.listen(0,'127.0.0.1');await once(github,'listening');
const apiPort=github.address().port;
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
const port=reservation.address().port;await new Promise(r => reservation.close(r));
const config=parse(await readFile(new URL('../config.example.yaml',import.meta.url),'utf8'));
config.server={...config.server,listen:'127.0.0.1',port,dataDir:join(directory,'data'),configReloadInterval:'50ms'};
config.github={...config.github,hostname:`127.0.0.1:${apiPort}`,apiBaseUrl:`http://127.0.0.1:${apiPort}`};
config.github.polling.interval='50ms';
const path=join(directory,'config.yaml');await writeFile(path,stringify(config));
let output='';let child;
const waitFor=async fn => {
  const until=Date.now()+10000;
  while(Date.now()<until) {
    if(child?.exitCode!==null)throw new Error('compiled Dispatcher exited: '+output);
    try {const result=await fn();if(result)return result;}catch(error) {if(error.message.startsWith('compiled Dispatcher'))throw error;}
    await new Promise(r => setTimeout(r,25));
  }
  throw new Error('smoke test timed out: '+output);
};
try {
  const cli=spawn(process.execPath,['packages/worker/dist/cli.js','--help'],{stdio:['ignore','pipe','pipe']});let text='';cli.stdout.on('data',c=>text+=c);cli.stderr.on('data',c=>text+=c);
  assert.equal((await once(cli,'close'))[0],0,text);assert.match(text,/doctor/);
  child=spawn(process.execPath,['packages/dispatcher/dist/main.js'],{
    env:{...process.env,FORGECREW_CONFIG:path,FORGECREW_GITHUB_PAT:'smoke-only',FORGECREW_REGISTRATION_TOKEN:'r'.repeat(48)},
    stdio:['ignore','pipe','pipe'],
  });child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  const base=`http://127.0.0.1:${port}`;
  const ready=await waitFor(async () => {const r=await fetch(base+'/health/ready');return r.ok&&await r.json();});assert.equal(ready.ready,true);
  await writeFile(path,'invalid: [');await waitFor(async () => {const r=await(await fetch(base+'/health/ready')).json();return r.configError&&r;});
  const unchanged=await(await fetch(base+'/health/ready')).json();assert.equal(unchanged.configRevision,ready.configRevision);
  config.agent.instructions+='\nNew central instructions.';await writeFile(path,stringify(config));
  const changed=await waitFor(async () => {const r=await(await fetch(base+'/health/ready')).json();return r.configRevision!==ready.configRevision&&!r.configError&&r;});
  const id=randomUUID(),token='w'.repeat(48);
  const registration=await fetch(base+'/v1/register',{method:'POST',headers:{Authorization:'Bearer '+'r'.repeat(48),'Content-Type':'application/json'},body:JSON.stringify({token,capabilities:{id,githubLogin:'fixture',githubId:'1',version:'0.1.0',schemaVersions:[1],maxConcurrentSessions:1,repositories:[],models:[],draining:false}})});
  assert.equal(registration.status,200);
  const p=await(await fetch(base+'/v1/config/'+changed.configRevision,{headers:{Authorization:'Bearer '+token,'X-ForgeCrew-Worker':id}})).json();
  assert.match(p.payload.agent.instructions,/New central instructions/);assert.equal(p.payload.github.tokenEnv,undefined);
  console.log('Compiled CLI + Dispatcher startup, SQLite, authentication and config reload smoke checks passed.');
} finally {
  if(child&&child.exitCode===null) {
    const exited=once(child,'close');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    await exited;clearTimeout(timer);
  }
  await new Promise(r=>github.close(r));await rm(directory,{recursive:true,force:true});
}
