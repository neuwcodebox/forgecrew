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
});
