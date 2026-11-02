import { Octokit } from '@octokit/rest';
import type { Config } from '../../shared/src/config.ts';
import { canWrite, parseControl } from '../../shared/src/input.ts';
import { sessionId } from '../../shared/src/hash.ts';
import type { Store,ActivationWindow,Preflight } from './store.ts';
import type { WorkClaim } from '../../shared/src/protocol.ts';

type Issue = { number: number; body: string | null; pull_request?: unknown; labels: (string | { name?: string })[]; user: { login: string } | null };
type LabelEvent = { id: number; event: string; created_at: string; actor: { login: string } | null; label?: { name: string } };
type Comment = { id: number; body?: string; created_at: string; updated_at: string; user: { login: string; id: number } | null; issue_url?: string; pull_request_url?: string };
type Review={id:number;body:string|null;submitted_at:string|null;state:string;user:{login:string;id:number}|null};
export interface GitHubSource {
  issues(repository: string, since: string): Promise<Issue[]>;
  events(repository: string, number: number): Promise<LabelEvent[]>;
  comments(repository: string, since: string, review: boolean): Promise<Comment[]>;
  permission(repository: string, login: string): Promise<boolean>;
  reviews?(repository:string,number:number):Promise<Review[]>;
  syncLabels?(repository:string,number:number,desired:string[],prefixes:string[]):Promise<void>;
}
export class GitHubClient implements GitHubSource {
  readonly api: Octokit;
  constructor(config: Config, token: string) {
    this.api = new Octokit({ auth: token, baseUrl: config.github.apiBaseUrl, request: { timeout: config.runtime.requestTimeout }, userAgent: 'forgecrew/0.1.0' });
  }
  private repo(name: string) { const [owner, repo] = name.split('/'); return { owner: owner!, repo: repo! }; }
  async issues(repository: string, since: string) {
    return this.api.paginate(this.api.issues.listForRepo,{ ...this.repo(repository), state:'all',sort:'updated',direction:'asc',since,per_page:100 }) as Promise<Issue[]>;
  }
  async events(repository: string, number: number) {
    return this.api.paginate(this.api.issues.listEvents,{ ...this.repo(repository),issue_number:number,per_page:100 }) as Promise<LabelEvent[]>;
  }
  async comments(repository: string, since: string, review: boolean) {
    const params = { ...this.repo(repository),since,sort:'updated' as const,direction:'asc' as const,per_page:100 };
    return (review ? this.api.paginate(this.api.pulls.listReviewCommentsForRepo,params) : this.api.paginate(this.api.issues.listCommentsForRepo,params)) as Promise<Comment[]>;
  }
  async permission(repository: string, login: string) {
    const { data } = await this.api.repos.getCollaboratorPermissionLevel({ ...this.repo(repository),username:login });
    return canWrite({ permission:data.permission });
  }
  async reviews(repository:string,number:number) {
    return this.api.paginate(this.api.pulls.listReviews,{...this.repo(repository),pull_number:number,per_page:100}) as Promise<Review[]>;
  }
  async syncLabels(repository:string,number:number,desired:string[],prefixes:string[]) {
    const repo=this.repo(repository);
    const {data}=await this.api.issues.get({...repo,issue_number:number});
    const current=data.labels.map(l=>typeof l==='string'?l:l.name??'');
    for(const name of desired.filter(n=>!current.includes(n))) {
      try{await this.api.issues.getLabel({...repo,name});}
      catch(error){if((error as {status:number}).status!==404)throw error;try{await this.api.issues.createLabel({...repo,name,color:'6f42c1'});}catch(e){if((e as {status:number}).status!==422)throw e;}}
      await this.api.issues.addLabels({...repo,issue_number:number,labels:[name]});
    }
    for(const name of current.filter(n=>prefixes.some(p=>n.startsWith(p))&&!desired.includes(n))) {
      try{await this.api.issues.removeLabel({...repo,issue_number:number,name});}catch(error){if((error as {status:number}).status!==404)throw error;}
    }
  }
  async preflight(claim:WorkClaim):Promise<Preflight> {
    const {repository,number}=claim.session;const repo=this.repo(repository);
    if(!await this.permission(repository,claim.input.author))return {status:'cancel',reason:'requester_lost_write_permission'};
    try {
      const issue=(await this.api.issues.get({...repo,issue_number:number})).data;
      if(!issue.labels.some(l=>(typeof l==='string'?l:l.name)===claim.runConfig.payload.labels.enabled))return {status:'hold',reason:'session_disabled'};
      if(claim.input.source_kind==='initial')return issue.body?.trim()?{status:'ready',body:issue.body}:{status:'cancel',reason:'empty_input'};
      const id=Number(claim.input.source_id);
      if(!Number.isSafeInteger(id))return {status:'cancel',reason:'invalid_input_source'};
      const source=claim.input.source_kind==='comment'?(await this.api.issues.getComment({...repo,comment_id:id})).data:
        claim.input.source_kind==='review_comment'?(await this.api.pulls.getReviewComment({...repo,comment_id:id})).data:
        (await this.api.pulls.getReview({...repo,pull_number:number,review_id:id})).data;
      return source.body?.trim()?{status:'ready',body:source.body}:{status:'cancel',reason:'empty_input'};
    }catch(error){if((error as {status:number}).status===404)return {status:'cancel',reason:'input_deleted'};throw error;}
  }
}

export class Poller {
  private permissions = new Map<string,{ writable: boolean; expires: number }>();
  private labelStates=new Map<string,{value:string;at:number}>();
  readonly store: Store;
  readonly source: GitHubSource;
  readonly now: () => number;
  constructor(store: Store, source: GitHubSource, now: () => number = Date.now) { this.store=store; this.source=source; this.now=now; }
  async writable(repository: string, user: string, config: Config) {
    const key = repository + ':' + user;
    const cached = this.permissions.get(key);
    if (cached && cached.expires > this.now()) return cached.writable;
    const writable = await this.source.permission(repository,user);
    this.permissions.set(key,{ writable, expires:this.now()+config.github.permissionCacheTtl }); return writable;
  }
  async pollRepository(repository: string, config: Config) {
    const scope = config.github.hostname + ':' + repository + ':objects';
    const start = this.now();
    const reconcile=this.store.cursor(scope+':reconcile')+config.github.polling.reconcileInterval<=start;
    const since = new Date(reconcile?0:Math.max(0,this.store.cursor(scope)-config.github.polling.overlap)).toISOString();
    const issues = await this.source.issues(repository,since);
    for (const issue of issues) {
      const key = { host:config.github.hostname,repository,kind:issue.pull_request ? 'pull' as const : 'issue' as const,number:issue.number };
      const events = await this.source.events(repository,issue.number);
      const labels = new Set<string>(); let activation = 0; let active = false; let actor = issue.user?.login ?? '';
      const windows:ActivationWindow[]=[];let initialActor:string|undefined;
      for (const event of events.sort((a,b) => Date.parse(a.created_at)-Date.parse(b.created_at) || a.id-b.id)) {
        const label = event.label?.name;
        if (!label || !event.actor || !['labeled','unlabeled'].includes(event.event)) continue;
        const relevant = label === config.labels.enabled || label.startsWith(config.labels.modelPrefix) || label.startsWith(config.labels.effortPrefix);
        if (!relevant || !await this.writable(repository,event.actor.login,config)) continue;
        if (event.event === 'labeled') labels.add(label); else labels.delete(label);
        if (label === config.labels.enabled) {
          const next=event.event==='labeled';activation=Date.parse(event.created_at);actor=event.actor.login;
          if(next&&!active){windows.push({openedAt:activation,closedAt:null});initialActor??=actor;}
          if(!next&&active&&windows.length)windows.at(-1)!.closedAt=activation;
          active=next;
        }
      }
      const actual = issue.labels.map(l => typeof l === 'string' ? l : l.name ?? '');
      // Missing actor evidence and unauthorized current-label changes never authorize execution.
      const relevantActual = actual.filter(l => l === config.labels.enabled || l.startsWith(config.labels.modelPrefix) || l.startsWith(config.labels.effortPrefix));
      const consistent = [...labels].sort().join('\0') === relevantActual.sort().join('\0');
      this.store.upsertSession(key,[...labels],active && consistent,activation,issue.body ?? '',initialActor??actor,windows);
    }
    this.store.advanceCursor(scope,start);
    if(reconcile)this.store.advanceCursor(scope+':reconcile',start);
    // Independent cursors: a failed comment page cannot advance another stream's checkpoint.
    for (const review of [false,true]) {
      const commentScope = config.github.hostname + ':' + repository + ':' + (review ? 'review_comments' : 'comments');
      const collectedAt = this.now();
      const reconcileComments=this.store.cursor(commentScope+':reconcile')+config.github.polling.reconcileInterval<=collectedAt;
      const commentSince = new Date(reconcileComments?0:Math.max(0,this.store.cursor(commentScope)-config.github.polling.overlap)).toISOString();
      const comments = await this.source.comments(repository,commentSince,review);
      for (const comment of comments.sort((a,b) => Date.parse(a.created_at)-Date.parse(b.created_at) || a.id-b.id)) {
        if (!comment.user || !comment.body) continue;
        const number = Number((comment.issue_url ?? comment.pull_request_url)?.split('/').at(-1));
        const keys = review ? ['pull' as const] : ['issue' as const,'pull' as const];
        const session = keys.map(kind => this.store.getSession(sessionId({ host:config.github.hostname,repository,kind,number }))).find(Boolean);
        if (!session || this.store.isAutomatic(session.id,String(comment.id),String(comment.user.id),comment.body)) continue;
        if (!await this.writable(repository,comment.user.login,config)) continue;
        const created = Date.parse(comment.created_at); const updated = Date.parse(comment.updated_at);
        const control = parseControl(comment.body);
        if (control) {
          if (created === updated) this.store.addControl(session.id,(review?'review_comment:':'comment:')+comment.id,control,created);
        } else this.store.enqueue(session.id,review?'review_comment':'comment',String(comment.id),comment.body,comment.user.login,created,updated);
      }
      this.store.advanceCursor(commentScope,collectedAt);
      if(reconcileComments)this.store.advanceCursor(commentScope+':reconcile',collectedAt);
    }
    if(this.source.reviews)for(const session of this.store.sessions(repository).filter(s=>s.kind==='pull')) {
      const reviews=await this.source.reviews(repository,session.number);
      for(const review of reviews) {
        if(!review.user||!review.body?.trim()||!review.submitted_at||review.state==='PENDING'||!await this.writable(repository,review.user.login,config))continue;
        this.store.enqueue(session.id,'review',String(review.id),review.body,review.user.login,Date.parse(review.submitted_at));
      }
    }
    if(this.source.syncLabels)for(const session of this.store.sessions(repository)) {
      const state=this.store.sessionStatus(session);
      const desired=[config.labels.statusPrefix+state.status,...(state.worker?[config.labels.workerPrefix+state.worker]:[])];
      const key=repository+':'+session.id,value=desired.join('\0'),old=this.labelStates.get(key);
      if(old?.value===value&&old.at+config.github.polling.reconcileInterval>start)continue;
      await this.source.syncLabels(repository,session.number,desired,[config.labels.statusPrefix,config.labels.workerPrefix]);
      this.labelStates.set(key,{value,at:start});
    }
  }
}
