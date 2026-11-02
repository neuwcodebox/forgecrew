import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../packages/dispatcher/src/store.ts';
import { Poller,GitHubClient } from '../packages/dispatcher/src/github.ts';
import type { GitHubSource } from '../packages/dispatcher/src/github.ts';
import { config, worker } from './helpers.ts';
import { sessionId } from '../packages/shared/src/hash.ts';

const stores:Store[]=[];afterEach(() => stores.splice(0).forEach(s => s.close()));
function setup() {
  const now=1000000;const s=new Store(':memory:',() => now);stores.push(s);const c=config();
  const source={
    issues:async () => [{number:1,body:'request',labels:['ai:enabled'],user:{login:'reader'}}],
    events:async () => [{id:1,event:'labeled',created_at:new Date(900000).toISOString(),actor:{login:'writer'},label:{name:'ai:enabled'}}],
    comments:async () => [],permission:async (_repo:string,user:string) => user==='writer',
  } satisfies GitHubSource;
  const id=sessionId({host:c.github.hostname,repository:'team/project-a',kind:'issue',number:1});
  return {s,c,source,id,now};
}
describe('GitHub polling normalization and checkpoints',() => {
  it('validates the activating actor instead of the body author',async () => {
    const {s,c,source,id}=setup();const p=new Poller(s,source,() => 1000000);await p.pollRepository('team/project-a',c);
    expect(s.getSession(id)?.active).toBe(1);expect(s.sqlite.prepare('SELECT author FROM inputs').get()).toEqual({author:'writer'});
    await p.pollRepository('team/project-a',c);expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM inputs').get()).toEqual({n:1});
  });
  it('does not run labels without authorized event evidence',async () => {
    const {s,c,source,id}=setup();source.permission=async () => false;
    await new Poller(s,source).pollRepository('team/project-a',c);expect(s.getSession(id)?.active).toBe(0);expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM inputs').get()).toEqual({n:0});
  });
  it('holds unauthorized model-label changes instead of trusting a current snapshot',async () => {
    const {s,c,source,id}=setup();source.issues=async () => [{number:1,body:'request',labels:['ai:enabled','ai:model:opus'],user:{login:'reader'}}];
    await new Poller(s,source).pollRepository('team/project-a',c);expect(s.getSession(id)?.active).toBe(0);
  });
  it('does not advance an objects checkpoint on a failed events page',async () => {
    const {s,c,source}=setup();source.events=async () => {throw new Error('page_failed');};
    await expect(new Poller(s,source).pollRepository('team/project-a',c)).rejects.toThrow();expect(s.cursor(c.github.hostname+':team/project-a:objects')).toBe(0);
  });
  it('normalizes PRs from the Issues API into one independent session',async () => {
    const {s,c,source}=setup();const prSource:GitHubSource={...source,issues:async () => [{number:1,body:'pr',pull_request:{url:'x'},labels:['ai:enabled'],user:{login:'writer'}}]};
    await new Poller(s,prSource).pollRepository('team/project-a',c);
    expect(s.sqlite.prepare('SELECT kind,number FROM sessions').all()).toEqual([{kind:'pull',number:1}]);
  });
  it('accepts the coworker’s human comments while excluding only known automated output',async () => {
    const {s,c,source,id,now}=setup();const p=new Poller(s,source,() => now);await p.pollRepository('team/project-a',c);
    const w=worker(now,{githubLogin:'writer',githubId:'123'});s.register(w,'a'.repeat(48));const a=s.claim(w.id,c)!;
    s.complete(a.attemptId,w.id,a.generation,{kind:'completed',text:'AI reply'});const d=s.claimDelivery(w.id,c.runtime.leaseDuration)!;s.beginPost(w.id,d.id);
    const next:GitHubSource={...source,comments:async (_repo,_since,review) => review?[]:[
      {id:10,body:d.body,created_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString(),user:{login:'writer',id:123},issue_url:'https://api.example/repos/team/project-a/issues/1'},
      {id:11,body:'human follow-up',created_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString(),user:{login:'writer',id:123},issue_url:'https://api.example/repos/team/project-a/issues/1'},
    ]};
    await new Poller(s,next,() => now).pollRepository('team/project-a',c);
    expect(s.sqlite.prepare("SELECT body FROM inputs WHERE source_kind='comment' AND session_id=?").all(id)).toEqual([{body:'human follow-up'}]);
  });
  it('recovers comments from earlier active windows while excluding the inactive gap',async()=>{
    const {s,c,source,id}=setup();
    const events=[
      {id:1,event:'labeled',created_at:new Date(900000).toISOString(),actor:{login:'writer'},label:{name:'ai:enabled'}},
      {id:2,event:'unlabeled',created_at:new Date(930000).toISOString(),actor:{login:'writer'},label:{name:'ai:enabled'}},
      {id:3,event:'labeled',created_at:new Date(960000).toISOString(),actor:{login:'writer'},label:{name:'ai:enabled'}},
    ];
    const feed:GitHubSource={...source,events:async()=>events,comments:async(_r,_s,review)=>review?[]:[910000,940000,970000].map((at,i)=>({id:i+10,body:'comment '+at,created_at:new Date(at).toISOString(),updated_at:new Date(at).toISOString(),user:{login:'writer',id:123},issue_url:'https://api.example/repos/team/project-a/issues/1'}))};
    await new Poller(s,feed,()=>1000000).pollRepository('team/project-a',c);
    expect(s.sqlite.prepare("SELECT body FROM inputs WHERE session_id=? ORDER BY created_at").all(id)).toEqual([{body:'request'},{body:'comment 910000'},{body:'comment 970000'}]);
  });
  it('collects submitted PR review bodies and ignores drafts',async()=>{
    const {s,c,source}=setup();
    const feed:GitHubSource={...source,issues:async()=>[{number:1,body:'request',pull_request:{},labels:['ai:enabled'],user:{login:'writer'}}],reviews:async()=>[
      {id:1,state:'PENDING',body:'draft',submitted_at:null,user:{login:'writer',id:123}},
      {id:2,state:'COMMENTED',body:'review request',submitted_at:new Date(950000).toISOString(),user:{login:'writer',id:123}},
    ]};
    const poller=new Poller(s,feed,()=>1000000);await poller.pollRepository('team/project-a',c);await poller.pollRepository('team/project-a',c);
    expect(s.sqlite.prepare("SELECT body FROM inputs WHERE source_kind='review'").all()).toEqual([{body:'review request'}]);
  });
  it('performs periodic full reconciliation independently of incremental checkpoints',async()=>{
    const {s,c,source}=setup();let clock=1000000;const seen:string[]=[];
    const feed:GitHubSource={...source,issues:async(_repo,since)=>{seen.push(since);return await source.issues();}};
    const p=new Poller(s,feed,()=>clock);await p.pollRepository('team/project-a',c);clock+=1000;await p.pollRepository('team/project-a',c);clock+=c.github.polling.reconcileInterval;await p.pollRepository('team/project-a',c);
    expect(seen[0]).toBe(new Date(0).toISOString());expect(seen[1]).not.toBe(new Date(0).toISOString());expect(seen[2]).toBe(new Date(0).toISOString());
  });
  it('only changes labels owned by the status and worker prefixes',async()=>{
    const client=new GitHubClient(config(),'fixture');const removed:string[]=[],added:string[]=[];
    Object.assign(client.api.issues,{
      get:async()=>({data:{labels:['bug','ai:model:sol','ai:status:idle']}}),getLabel:async()=>({}),
      addLabels:async(p:{labels:string[]})=>{added.push(...p.labels);},removeLabel:async(p:{name:string})=>{removed.push(p.name);},
    });
    await client.syncLabels('team/project-a',1,['ai:status:running'],['ai:status:','ai:worker:']);
    expect(removed).toEqual(['ai:status:idle']);expect(added).toEqual(['ai:status:running']);
  });
});
