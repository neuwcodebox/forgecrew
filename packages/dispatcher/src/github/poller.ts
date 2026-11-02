import type { Config } from '../../../shared/src/config/index.ts';
import { parseControl } from '../../../shared/src/input.ts';
import { sessionId } from '../../../shared/src/hash.ts';
import type { Store, ActivationWindow } from '../storage/index.ts';
import type { GitHubSource } from './contracts.ts';

type PollingStorage = Pick<
  Store,
  'sessions' | 'executions' | 'deliveries' | 'diagnostics' | 'checkpoints'
>;

export class Poller {
  private permissions = new Map<string, { writable: boolean; expires: number }>();
  private labelStates = new Map<string, { value: string; at: number }>();
  readonly store: PollingStorage;
  readonly source: GitHubSource;
  readonly now: () => number;
  constructor(store: PollingStorage, source: GitHubSource, now: () => number = Date.now) {
    this.store = store;
    this.source = source;
    this.now = now;
  }
  async writable(repository: string, user: string, config: Config) {
    const key = repository + ':' + user;
    const cached = this.permissions.get(key);
    if (cached && cached.expires > this.now()) return cached.writable;
    const writable = await this.source.permission(repository, user);
    this.permissions.set(key, { writable, expires: this.now() + config.github.permissionCacheTtl });
    return writable;
  }
  async pollRepository(repository: string, config: Config) {
    const startedAt = this.now();
    await this.synchronizeSessions(repository, config, startedAt);
    await this.collectComments(repository, config);
    await this.collectReviews(repository, config);
    await this.synchronizeLabels(repository, config, startedAt);
  }
  private async synchronizeSessions(repository: string, config: Config, start: number) {
    const scope = config.github.hostname + ':' + repository + ':objects';
    const reconcile =
      this.store.checkpoints.get(scope + ':reconcile') + config.github.polling.reconcileInterval <=
      start;
    const since = new Date(
      reconcile
        ? 0
        : Math.max(0, this.store.checkpoints.get(scope) - config.github.polling.overlap),
    ).toISOString();
    const issues = await this.source.issues(repository, since);
    for (const issue of issues) {
      const key = {
        host: config.github.hostname,
        repository,
        kind: issue.pull_request ? ('pull' as const) : ('issue' as const),
        number: issue.number,
      };
      const events = await this.source.events(repository, issue.number);
      const labels = new Set<string>();
      let activation = 0;
      let active = false;
      let actor = issue.user?.login ?? '';
      const windows: ActivationWindow[] = [];
      let initialActor: string | undefined;
      for (const event of events.sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id,
      )) {
        const label = event.label?.name;
        if (!label || !event.actor || !['labeled', 'unlabeled'].includes(event.event)) continue;
        const relevant =
          label === config.labels.enabled ||
          label.startsWith(config.labels.modelPrefix) ||
          label.startsWith(config.labels.effortPrefix);
        if (!relevant || !(await this.writable(repository, event.actor.login, config))) continue;
        if (event.event === 'labeled') labels.add(label);
        else labels.delete(label);
        if (label === config.labels.enabled) {
          const next = event.event === 'labeled';
          activation = Date.parse(event.created_at);
          actor = event.actor.login;
          if (next && !active) {
            windows.push({ openedAt: activation, closedAt: null });
            initialActor ??= actor;
          }
          if (!next && active && windows.length) windows.at(-1)!.closedAt = activation;
          active = next;
        }
      }
      const actual = issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
      // Missing actor evidence and unauthorized current-label changes never authorize execution.
      const relevantActual = actual.filter(
        (l) =>
          l === config.labels.enabled ||
          l.startsWith(config.labels.modelPrefix) ||
          l.startsWith(config.labels.effortPrefix),
      );
      const consistent = [...labels].sort().join('\0') === relevantActual.sort().join('\0');
      this.store.sessions.upsert(
        key,
        [...labels],
        active && consistent,
        activation,
        issue.body ?? '',
        initialActor ?? actor,
        windows,
      );
    }
    this.store.checkpoints.advance(scope, start);
    if (reconcile) this.store.checkpoints.advance(scope + ':reconcile', start);
  }
  private async collectComments(repository: string, config: Config) {
    // Independent cursors: a failed comment page cannot advance another stream's checkpoint.
    for (const review of [false, true]) {
      const commentScope =
        config.github.hostname + ':' + repository + ':' + (review ? 'review_comments' : 'comments');
      const collectedAt = this.now();
      const reconcileComments =
        this.store.checkpoints.get(commentScope + ':reconcile') +
          config.github.polling.reconcileInterval <=
        collectedAt;
      const commentSince = new Date(
        reconcileComments
          ? 0
          : Math.max(0, this.store.checkpoints.get(commentScope) - config.github.polling.overlap),
      ).toISOString();
      const comments = await this.source.comments(repository, commentSince, review);
      for (const comment of comments.sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id,
      )) {
        if (!comment.user || !comment.body) continue;
        const number = Number((comment.issue_url ?? comment.pull_request_url)?.split('/').at(-1));
        const keys = review ? ['pull' as const] : ['issue' as const, 'pull' as const];
        const session = keys
          .map((kind) =>
            this.store.sessions.get(
              sessionId({ host: config.github.hostname, repository, kind, number }),
            ),
          )
          .find(Boolean);
        if (
          !session ||
          this.store.deliveries.isAutomatic(
            session.id,
            String(comment.id),
            String(comment.user.id),
            comment.body,
          )
        )
          continue;
        if (!(await this.writable(repository, comment.user.login, config))) continue;
        const created = Date.parse(comment.created_at);
        const updated = Date.parse(comment.updated_at);
        const control = parseControl(comment.body);
        if (control) {
          if (created === updated)
            this.store.executions.addControl(
              session.id,
              (review ? 'review_comment:' : 'comment:') + comment.id,
              control,
              created,
            );
        } else
          this.store.sessions.enqueue(
            session.id,
            review ? 'review_comment' : 'comment',
            String(comment.id),
            comment.body,
            comment.user.login,
            created,
            updated,
          );
      }
      this.store.checkpoints.advance(commentScope, collectedAt);
      if (reconcileComments)
        this.store.checkpoints.advance(commentScope + ':reconcile', collectedAt);
    }
  }
  private async collectReviews(repository: string, config: Config) {
    if (this.source.reviews)
      for (const session of this.store.sessions.list(repository).filter((s) => s.kind === 'pull')) {
        const reviews = await this.source.reviews(repository, session.number);
        for (const review of reviews) {
          if (
            !review.user ||
            !review.body?.trim() ||
            !review.submitted_at ||
            review.state === 'PENDING' ||
            !(await this.writable(repository, review.user.login, config))
          )
            continue;
          this.store.sessions.enqueue(
            session.id,
            'review',
            String(review.id),
            review.body,
            review.user.login,
            Date.parse(review.submitted_at),
          );
        }
      }
  }
  private async synchronizeLabels(repository: string, config: Config, start: number) {
    if (this.source.syncLabels)
      for (const session of this.store.sessions.list(repository)) {
        const state = this.store.diagnostics.sessionStatus(session);
        const desired = [
          config.labels.statusPrefix + state.status,
          ...(state.worker ? [config.labels.workerPrefix + state.worker] : []),
        ];
        const key = repository + ':' + session.id,
          value = desired.join('\0'),
          old = this.labelStates.get(key);
        if (old?.value === value && old.at + config.github.polling.reconcileInterval > start)
          continue;
        await this.source.syncLabels(repository, session.number, desired, [
          config.labels.statusPrefix,
          config.labels.workerPrefix,
        ]);
        this.labelStates.set(key, { value, at: start });
      }
  }
}
