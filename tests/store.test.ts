import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../packages/dispatcher/src/store.ts';
import { config, worker } from './helpers.ts';
import type { WorkerCapabilities } from '../packages/shared/src/types.ts';
import { hash } from '../packages/shared/src/hash.ts';
import { ConfigManager } from '../packages/shared/src/config.ts';
import { createApp } from '../packages/dispatcher/src/api.ts';
import { configSource } from './helpers.ts';

const stores: Store[]=[];afterEach(() => stores.splice(0).forEach(s => s.close()));
function setup() {
  let now=1000000;const s=new Store(':memory:',() => now);stores.push(s);const c=config();s.saveConfig(c);const w=worker(now);
  const token='a'.repeat(48);s.register(w,token);
  const id=s.upsertSession({host:c.github.hostname,repository:'team/project-a',kind:'issue',number:1},['ai:enabled'],true,now,'implement request','author');
  return {s,c,w,token,id,tick:(ms:number) => {now+=ms;},refresh:(worker:WorkerCapabilities=w) => {worker.models.forEach(m => m.observedAt=now);s.heartbeat(worker.id,worker);}};
}
describe('SQLite ownership, FIFO and recovery',() => {
  it('issues one execution for a session and respects worker capacity',() => {
    const {s,c,w}=setup();expect(s.claim(w.id,c)).not.toBeNull();expect(s.claim(w.id,c)).toBeNull();
  });
  it('edits queued input but does not rerun a consumed source',() => {
    const {s,c,w,id}=setup();const first=s.claim(w.id,c)!;s.complete(first.attemptId,w.id,first.generation,{kind:'completed',text:'done'});
    s.enqueue(id,'comment','42','original','author',1000001);s.enqueue(id,'comment','42','edited','author',1000001,1000002);
    const row=s.sqlite.prepare("SELECT body FROM inputs WHERE source_id='42'").get() as {body:string};expect(row.body).toBe('edited');
    expect(s.enqueue(id,'initial',id,'again','author',1000000,1000002)).toBe(false);expect(s.claim(w.id,c)).toBeNull();
  });
  it('preserves queued inputs through deactivate/reactivate without replaying initial body',() => {
    const {s,c,id}=setup();const k={host:c.github.hostname,repository:'team/project-a',kind:'issue' as const,number:1};
    s.upsertSession(k,[],false,1000001,'body','author');expect(s.enqueue(id,'comment','43','inactive','author',1000002)).toBe(false);
    s.upsertSession(k,['ai:enabled'],true,1000003,'body','author');expect(s.sqlite.prepare('SELECT COUNT(*) as n FROM inputs').get()).toEqual({n:1});
  });
  it('rejects stale generation and expired lease results',() => {
    const {s,c,w,tick}=setup();const a=s.claim(w.id,c)!;
    expect(() => s.renew(a.attemptId,w.id,a.generation+1)).toThrow('stale_attempt');tick(c.runtime.leaseDuration);
    expect(() => s.renew(a.attemptId,w.id,a.generation)).toThrow('lease_expired');
    expect(() => s.complete(a.attemptId,w.id,a.generation,{kind:'completed',text:'late'})).toThrow('lease_expired');
  });
  it('waits for reassignment grace and pins the original run config during recovery',() => {
    const {s,c,w,tick,refresh}=setup();const a=s.claim(w.id,c)!;tick(c.runtime.leaseDuration+1);refresh();expect(s.claim(w.id,c)).toBeNull();
    tick(c.runtime.reassignGrace);refresh();const changed=structuredClone(c);changed.agent.instructions='new instructions';
    const b=s.claim(w.id,changed)!;expect(b.turnId).toBe(a.turnId);expect(b.generation).toBe(2);expect(b.runConfig).toEqual(a.runConfig);
    expect(() => s.complete(a.attemptId,w.id,a.generation,{kind:'completed',text:'old'})).toThrow('lease_expired');
  });
  it('keeps the original lease contract when central timings change',() => {
    const {s,c,w,tick}=setup();const a=s.claim(w.id,c)!;const changed=structuredClone(c);changed.runtime.leaseDuration=300000;tick(1000);
    expect(s.renew(a.attemptId,w.id,a.generation).leaseDuration).toBe(c.runtime.leaseDuration);
  });
  it('keeps old and new lease policies distinct while their Attempts coexist',()=>{
    const {s,c,w,id,tick,refresh}=setup();w.maxConcurrentSessions=2;refresh();const old=s.claim(w.id,c)!;
    const changed=structuredClone(c);changed.runtime.leaseDuration=180000;changed.runtime.interruptGrace=20000;changed.runtime.reassignGrace=25000;
    s.upsertSession({host:c.github.hostname,repository:'team/project-a',kind:'issue',number:2},['ai:enabled'],true,1000000,'new policy','author');
    const next=s.claim(w.id,changed)!;expect(next.session.id).not.toBe(id);expect(next.leaseDuration).toBe(180000);
    tick(1000);expect(s.renew(old.attemptId,w.id,old.generation)).toEqual({leaseDuration:90000,interruptGrace:10000});expect(s.renew(next.attemptId,w.id,next.generation)).toEqual({leaseDuration:180000,interruptGrace:20000});
    tick(90000+c.runtime.reassignGrace);s.expire();expect(()=>s.complete(old.attemptId,w.id,old.generation,{kind:'completed',text:'expired'})).toThrow('lease_expired');
    expect(()=>s.complete(next.attemptId,w.id,next.generation,{kind:'completed',text:'valid newer policy'})).not.toThrow();
  });
  it('returns a slot after a question and accepts completion idempotently after ACK loss',() => {
    const {s,c,w,tick}=setup();const a=s.claim(w.id,c)!;const r={kind:'needs_reply' as const,text:'which authentication?'};
    const ids=s.complete(a.attemptId,w.id,a.generation,r);tick(c.runtime.leaseDuration+10000);
    expect(s.complete(a.attemptId,w.id,a.generation,r)).toEqual(ids);expect(() => s.complete(a.attemptId,w.id,a.generation,{...r,text:'changed'})).toThrow('result_conflict');
  });
  it('freezes delivery body across configuration changes and resumes only posting',() => {
    const {s,c,w}=setup();const a=s.claim(w.id,c)!;s.complete(a.attemptId,w.id,a.generation,{kind:'completed',text:'result'});
    const d=s.claimDelivery(w.id,c.runtime.leaseDuration)!;expect(d.body).toContain('AI-generated');s.beginPost(w.id,d.id);
    expect(s.isAutomatic(d.session_id,'789',w.githubId,d.body)).toBe(true);
    s.deliveryReceipt(w.id,d.id,'789');expect(s.claimDelivery(w.id,c.runtime.leaseDuration)).toBeNull();expect(s.isAutomatic(d.session_id,'789',w.githubId,'edited by human')).toBe(true);
  });
  it('renews an ongoing delivery using its issued lease and rejects expired ownership',()=>{
    const {s,c,w,tick}=setup();const a=s.claim(w.id,c)!;s.complete(a.attemptId,w.id,a.generation,{kind:'completed',text:'answer'});
    const d=s.claimDelivery(w.id,c.runtime.leaseDuration)!;s.beginPost(w.id,d.id);tick(c.runtime.leaseDuration/2);
    expect(s.renewDelivery(w.id,d.id).leaseDuration).toBe(c.runtime.leaseDuration);tick(c.runtime.leaseDuration/2+1);
    expect(s.claimDelivery(w.id,c.runtime.leaseDuration)).toBeNull();tick(c.runtime.leaseDuration/2);
    expect(()=>s.renewDelivery(w.id,d.id)).toThrow('delivery_lease_expired');
  });
  it('accepts an identical receipt after ACK loss but never overwrites it with another comment',()=>{
    const {s,c,w,tick}=setup();const a=s.claim(w.id,c)!;s.complete(a.attemptId,w.id,a.generation,{kind:'completed',text:'answer'});
    const d=s.claimDelivery(w.id,c.runtime.leaseDuration)!;s.beginPost(w.id,d.id);s.deliveryReceipt(w.id,d.id,'1234');tick(c.runtime.leaseDuration+1);
    expect(()=>s.deliveryReceipt(w.id,d.id,'1234')).not.toThrow();expect(()=>s.deliveryReceipt(w.id,d.id,'5678')).toThrow('receipt_conflict');
  });
  it('does not trust a marker copied by another account, or different body',() => {
    const {s,c,w}=setup();const a=s.claim(w.id,c)!;s.complete(a.attemptId,w.id,a.generation,{kind:'completed',text:'result'});
    const d=s.claimDelivery(w.id,c.runtime.leaseDuration)!;s.beginPost(w.id,d.id);
    expect(s.isAutomatic(d.session_id,'789','999',d.body)).toBe(false);expect(s.isAutomatic(d.session_id,'790',w.githubId,'forged '+d.body)).toBe(false);
  });
  it('keeps a late control attached to its original attempt',() => {
    const {s,c,w,id,tick}=setup();const a=s.claim(w.id,c)!;tick(1000);s.cancel(a.attemptId,w.id,a.generation);
    s.addControl(id,'42',{kind:'stop'},1000500);expect(s.controls(w.id)).toEqual([]);
    s.enqueue(id,'comment','43','next','author',1001000);const b=s.claim(w.id,c)!;expect(b.turnId).not.toBe(a.turnId);expect(s.controls(w.id)).toEqual([]);
  });
  it('never resurrects a stopped attempt after its lease expires',() => {
    const {s,c,w,id,tick,refresh}=setup();const a=s.claim(w.id,c)!;s.addControl(id,'42',{kind:'stop'},1000000);
    tick(c.runtime.leaseDuration+c.runtime.reassignGrace+1);refresh();expect(s.claim(w.id,c)).toBeNull();
  });
  it('prevents re-registering an existing Worker ID with a different secret',() => {
    const {s,w}=setup();expect(() => s.register(w,'b'.repeat(48))).toThrow('worker_identity_conflict');expect(s.authenticate(w.id,'b'.repeat(48))).toBe(false);
  });
  it('refreshes a changed queued source before execution without creating another logical Turn',()=>{
    const {s,c,w}=setup();const a=s.claim(w.id,c)!;
    expect(s.preflight(a.attemptId,w.id,a.generation,{status:'ready',body:'edited before execution'})).toBe(false);
    const b=s.claim(w.id,c)!;expect(b.turnId).toBe(a.turnId);expect(b.input.body).toBe('edited before execution');expect(b.generation).toBe(2);
  });
  it('cancels a deleted input before a Worker can execute it',()=>{
    const {s,c,w}=setup();const a=s.claim(w.id,c)!;
    expect(s.preflight(a.attemptId,w.id,a.generation,{status:'cancel',reason:'input_deleted'})).toBe(false);expect(s.claim(w.id,c)).toBeNull();
  });
  it('attributes pure runtime failures as automation',()=>{
    const {s,c,w}=setup();const a=s.claim(w.id,c)!;s.complete(a.attemptId,w.id,a.generation,{kind:'failed',origin:'runtime',text:'connection unavailable'});
    const d=s.claimDelivery(w.id,c.runtime.leaseDuration)!;expect(d.body).toContain('Automated');expect(d.body).not.toContain('AI-generated');
  });
});

describe('authenticated HTTP contract',() => {
  it('authenticates all work and config routes, uses ETag, and excludes server settings',async () => {
    const {s,w,token}=setup();const configs=new ConfigManager(configSource,c => s.saveConfig(c));const app=createApp(s,configs,'r'.repeat(48));
    expect((await app.request('/v1/claim',{method:'POST'})).status).toBe(401);
    const headers={'X-ForgeCrew-Worker':w.id,Authorization:'Bearer '+token};
    const claim=await app.request('/v1/claim',{method:'POST',headers});expect(claim.status).toBe(200);
    const body=await claim.json();const revision=body.claim.runConfig.configRevision;
    const response=await app.request('/v1/config/'+revision,{headers});expect(response.status).toBe(200);const json=await response.json();expect(JSON.stringify(json)).not.toContain('tokenEnv');expect(hash(json.payload)).toBe(json.payloadHash);
    expect((await app.request('/v1/config/'+revision,{headers:{...headers,'If-None-Match':response.headers.get('ETag')!}})).status).toBe(304);
  });
  it('rejects malformed registration without echoing credential payloads',async () => {
    const {s}=setup();const app=createApp(s,new ConfigManager(configSource),'r'.repeat(48));
    const res=await app.request('/v1/register',{method:'POST',headers:{Authorization:'Bearer '+'r'.repeat(48),'Content-Type':'application/json'},body:JSON.stringify({secret:'do-not-echo'})});
    expect(res.status).toBe(400);expect(await res.text()).not.toContain('do-not-echo');
  });
  it('reports correlated session and lease metadata without returning prompts or authentication secrets',async()=>{
    const {s,w,c,token}=setup(),app=createApp(s,new ConfigManager(configSource),'r'.repeat(48));const claim=s.claim(w.id,c)!;
    const response=await app.request('/v1/status',{headers:{'X-ForgeCrew-Worker':w.id,Authorization:'Bearer '+token}}),body=await response.json();
    expect(response.status).toBe(200);expect(body.sessions[0].attempt.id).toBe(claim.attemptId);expect(body.sessions[0].turn.configRevision).toBe(claim.runConfig.configRevision);
    const text=JSON.stringify(body);expect(text).not.toContain(token);expect(text).not.toContain('implement request');expect(text).not.toContain(c.agent.instructions);expect(text).not.toContain('run_config');
  });
  it('holds a work poll while health requests remain available and returns newly queued input',async()=>{
    const {s,w,c,token,id}=setup();const first=s.claim(w.id,c)!;s.cancel(first.attemptId,w.id,first.generation);
    let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;}),claim=s.claim.bind(s);
    s.claim=(...args)=>{const result=claim(...args);entered();return result;};
    const app=createApp(s,new ConfigManager(configSource),'r'.repeat(48)),headers={'X-ForgeCrew-Worker':w.id,Authorization:'Bearer '+token};
    const pending=app.request('/v1/claim?wait=1',{method:'POST',headers});await waiting;
    expect((await app.request('/health/live')).status).toBe(200);s.enqueue(id,'comment','new','queued during poll','author',1000001);
    expect((await(await pending).json()).claim.input.body).toBe('queued during poll');
  });
  it('releases a cancelled work poll without retaining an HTTP waiter',async()=>{
    const {s,w,c,token}=setup();const first=s.claim(w.id,c)!;s.cancel(first.attemptId,w.id,first.generation);
    let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;}),claim=s.claim.bind(s);s.claim=(...args)=>{const result=claim(...args);entered();return result;};
    const controller=new AbortController(),app=createApp(s,new ConfigManager(configSource),'r'.repeat(48));
    const pending=app.request('/v1/claim?wait=1',{method:'POST',headers:{'X-ForgeCrew-Worker':w.id,Authorization:'Bearer '+token},signal:controller.signal});await waiting;controller.abort();
    expect((await(await pending).json()).claim).toBeNull();
  });

});
