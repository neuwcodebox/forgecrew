import { Octokit } from '@octokit/rest';
import type { Config } from '../../shared/src/config.ts';
import { canWrite, parseControl } from '../../shared/src/input.ts';
import { sessionId } from '../../shared/src/hash.ts';
import type { Store } from './store.ts';

type Issue = { number: number; body: string | null; pull_request?: unknown; labels: (string | { name?: string })[]; user: { login: string } | null };
type LabelEvent = { id: number; event: string; created_at: string; actor: { login: string } | null; label?: { name: string } };
type Comment = { id: number; body?: string; created_at: string; updated_at: string; user: { login: string; id: number } | null; issue_url?: string; pull_request_url?: string };
export interface GitHubSource {
  issues(repository: string, since: string): Promise<Issue[]>;
  events(repository: string, number: number): Promise<LabelEvent[]>;
  comments(repository: string, since: string, review: boolean): Promise<Comment[]>;
  permission(repository: string, login: string): Promise<boolean>;
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
}

export class Poller {
  private permissions = new Map<string,{ writable: boolean; expires: number }>();
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
    const since = new Date(Math.max(0,this.store.cursor(scope)-config.github.polling.overlap)).toISOString();
    const issues = await this.source.issues(repository,since);
    for (const issue of issues) {
      const key = { host:config.github.hostname,repository,kind:issue.pull_request ? 'pull' as const : 'issue' as const,number:issue.number };
      const events = await this.source.events(repository,issue.number);
      const labels = new Set<string>(); let activation = 0; let active = false; let actor = issue.user?.login ?? '';
      for (const event of events.sort((a,b) => Date.parse(a.created_at)-Date.parse(b.created_at) || a.id-b.id)) {
        const label = event.label?.name;
        if (!label || !event.actor || !['labeled','unlabeled'].includes(event.event)) continue;
        const relevant = label === config.labels.enabled || label.startsWith(config.labels.modelPrefix) || label.startsWith(config.labels.effortPrefix);
        if (!relevant || !await this.writable(repository,event.actor.login,config)) continue;
        if (event.event === 'labeled') labels.add(label); else labels.delete(label);
        if (label === config.labels.enabled) { active = event.event === 'labeled'; activation = Date.parse(event.created_at); actor = event.actor.login; }
      }
      const actual = issue.labels.map(l => typeof l === 'string' ? l : l.name ?? '');
      // Missing actor evidence and unauthorized current-label changes never authorize execution.
      const relevantActual = actual.filter(l => l === config.labels.enabled || l.startsWith(config.labels.modelPrefix) || l.startsWith(config.labels.effortPrefix));
      const consistent = [...labels].sort().join('\0') === relevantActual.sort().join('\0');
      this.store.upsertSession(key,[...labels],active && consistent,activation,issue.body ?? '',actor);
    }
    this.store.advanceCursor(scope,start);
    // Independent cursors: a failed comment page cannot advance another stream's checkpoint.
    for (const review of [false,true]) {
      const commentScope = config.github.hostname + ':' + repository + ':' + (review ? 'review_comments' : 'comments');
      const collectedAt = this.now();
      const commentSince = new Date(Math.max(0,this.store.cursor(commentScope)-config.github.polling.overlap)).toISOString();
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
          if (created === updated) this.store.addControl(session.id,String(comment.id),control,created);
        } else this.store.enqueue(session.id,review?'review_comment':'comment',String(comment.id),comment.body,comment.user.login,created,updated);
      }
      this.store.advanceCursor(commentScope,collectedAt);
    }
  }
}
