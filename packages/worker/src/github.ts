import { mkdir, realpath, rename, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command } from './process.ts';
import { atomicWrite } from './local.ts';
import { canWrite } from '../../shared/src/input.ts';
import { hash } from '../../shared/src/hash.ts';
import type { DeliveryClaim, WorkClaim, WorkSession } from '../../shared/src/protocol.ts';

export type GitHubComment={id:number;body:string;user:{id:number;login:string}};
export class GhClient {
  readonly hostname:string;
  constructor(hostname:string) {this.hostname=hostname;}
  async api<T>(endpoint:string,method='GET',payload?:unknown):Promise<T> {
    const result=await command('gh',['api','--hostname',this.hostname,endpoint,'--method',method,...(payload===undefined?[]:['--input','-'])],{...(payload===undefined?{}:{input:JSON.stringify(payload)}),timeout:30000,maxBytes:20*1024*1024});
    if(result.code!==0)throw new Error('github_request_failed');return JSON.parse(result.stdout) as T;
  }
  async pages<T>(endpoint:string):Promise<T[]> {
    const result=await command('gh',['api','--hostname',this.hostname,endpoint,'--paginate','--slurp'],{timeout:60000,maxBytes:20*1024*1024});
    if(result.code!==0)throw new Error('github_pagination_failed');return (JSON.parse(result.stdout) as T[][]).flat();
  }
  account() {return this.api<{id:number;login:string}>('user');}
  async repositories(names:string[]):Promise<string[]> {
    const accessible:string[]=[];
    for(const name of names) {
      try {const repo=await this.api<{permissions?:{push?:boolean;admin?:boolean}}>('repos/'+name);if(repo.permissions?.push||repo.permissions?.admin)accessible.push(name);}catch{/* One inaccessible repository does not disable the Worker. */}
    }
    return accessible;
  }
  comments(session:WorkSession) {return this.pages<GitHubComment>(`repos/${session.repository}/issues/${session.number}/comments?per_page=100`);}
  async context(claim:WorkClaim):Promise<string> {
    if(claim.session.host!==this.hostname)throw new Error('github_host_mismatch');
    const permission=await this.api<{permission:string}>(`repos/${claim.session.repository}/collaborators/${encodeURIComponent(claim.input.author)}/permission`);
    if(!canWrite(permission))throw new Error('requester_no_longer_has_write_access');
    const issue=await this.api<{title:string;body:string;html_url:string}>(`repos/${claim.session.repository}/issues/${claim.session.number}`);
    const comments=await this.comments(claim.session);
    if(claim.input.source_kind==='comment') {
      const source=comments.find(c=>String(c.id)===claim.input.source_id);
      if(!source)throw new Error('input_deleted');
      if(source.body!==claim.input.body)throw new Error('input_changed_before_start');
    }
    let pull:unknown;
    if(claim.session.kind==='pull') {
      const details=await this.api(`repos/${claim.session.repository}/pulls/${claim.session.number}`);
      const reviews=await this.pages(`repos/${claim.session.repository}/pulls/${claim.session.number}/reviews?per_page=100`);
      const reviewComments=await this.pages(`repos/${claim.session.repository}/pulls/${claim.session.number}/comments?per_page=100`);
      pull={details,reviews,reviewComments};
    }
    return JSON.stringify({issue,comments,pull});
  }
  async workspace(directory:string,session:WorkSession):Promise<string> {
    if(!/^[a-f0-9]{64}$/.test(session.id)||session.host!==this.hostname)throw new Error('invalid_workspace_identity');
    const root=resolve(directory,'workspaces');await mkdir(root,{recursive:true,mode:0o700});
    const destination=join(root,session.id);
    if(await stat(destination).then(()=>true,()=>false)) {
      const actual=await realpath(destination);if(!actual.startsWith((await realpath(root))+sep))throw new Error('workspace_outside_managed_root');
      const result=await command('git',['rev-parse','--show-toplevel'],{cwd:destination});
      if(result.code!==0||resolve(result.stdout.trim())!==actual)throw new Error('workspace_requires_repair');return destination;
    }
    const staging=join(root,'.clone-'+session.id+'-'+randomUUID());
    // A failed partial clone is preserved for diagnosis; an existing checkout is never reset.
    const clone=await command('gh',['repo','clone',`https://${this.hostname}/${session.repository}.git`,staging],{timeout:120000});
    if(clone.code!==0)throw new Error('workspace_clone_failed');
    if(session.kind==='pull') {
      const checkout=await command('gh',['pr','checkout',String(session.number),'--repo',`https://${this.hostname}/${session.repository}`],{cwd:staging,timeout:60000});
      if(checkout.code!==0)throw new Error('pull_checkout_failed');
    }
    await rename(staging,destination);return destination;
  }
  async findDelivery(delivery:DeliveryClaim):Promise<GitHubComment|undefined> {
    return (await this.comments(delivery.session)).find(comment=>delivery.authors.includes(String(comment.user.id))&&hash(comment.body)===delivery.body_hash&&comment.body.includes(`<!-- forgecrew:delivery=${delivery.id} -->`));
  }
  post(delivery:DeliveryClaim) {return this.api<{id:number;html_url:string}>(`repos/${delivery.session.repository}/issues/${delivery.session.number}/comments`,'POST',{body:delivery.body});}
}
export async function publishDelivery(directory:string,github:GhClient,delivery:DeliveryClaim,begin:()=>Promise<unknown>,receipt:(id:string)=>Promise<unknown>) {
  const existing=await github.findDelivery(delivery);
  if(existing){await receipt(String(existing.id));return;}
  await begin();
  const posted=await github.post(delivery);
  await atomicWrite(join(directory,'receipts',delivery.id+'.json'),{schemaVersion:1,id:delivery.id,githubId:String(posted.id)});
  await receipt(String(posted.id));
}
