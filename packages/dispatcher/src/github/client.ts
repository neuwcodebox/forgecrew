import { Octokit } from '@octokit/rest';
import type { Config } from '../../../shared/src/config/index.ts';
import { canWrite } from '../../../shared/src/input.ts';
import type { WorkClaim } from '../../../shared/src/protocol.ts';
import type { Preflight } from '../storage/index.ts';
import type { GitHubSource, Issue, LabelEvent, Comment, Review } from './contracts.ts';

export class GitHubClient implements GitHubSource {
  readonly api: Octokit;
  constructor(config: Config, token: string) {
    this.api = new Octokit({
      auth: token,
      baseUrl: config.github.apiBaseUrl,
      request: { timeout: config.runtime.requestTimeout },
      userAgent: 'forgecrew/0.1.0',
    });
  }
  private repo(name: string) {
    const [owner, repo] = name.split('/');
    return { owner: owner!, repo: repo! };
  }
  async issues(repository: string, since: string) {
    return this.api.paginate(this.api.issues.listForRepo, {
      ...this.repo(repository),
      state: 'all',
      sort: 'updated',
      direction: 'asc',
      since,
      per_page: 100,
    }) as Promise<Issue[]>;
  }
  async events(repository: string, number: number) {
    return this.api.paginate(this.api.issues.listEvents, {
      ...this.repo(repository),
      issue_number: number,
      per_page: 100,
    }) as Promise<LabelEvent[]>;
  }
  async comments(repository: string, since: string, review: boolean) {
    const params = {
      ...this.repo(repository),
      since,
      sort: 'updated' as const,
      direction: 'asc' as const,
      per_page: 100,
    };
    return (
      review
        ? this.api.paginate(this.api.pulls.listReviewCommentsForRepo, params)
        : this.api.paginate(this.api.issues.listCommentsForRepo, params)
    ) as Promise<Comment[]>;
  }
  async permission(repository: string, login: string) {
    const { data } = await this.api.repos.getCollaboratorPermissionLevel({
      ...this.repo(repository),
      username: login,
    });
    return canWrite({ permission: data.permission });
  }
  async reviews(repository: string, number: number) {
    return this.api.paginate(this.api.pulls.listReviews, {
      ...this.repo(repository),
      pull_number: number,
      per_page: 100,
    }) as Promise<Review[]>;
  }
  async syncLabels(repository: string, number: number, desired: string[], prefixes: string[]) {
    const repo = this.repo(repository);
    const { data } = await this.api.issues.get({ ...repo, issue_number: number });
    const current = data.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
    for (const name of desired.filter((n) => !current.includes(n))) {
      try {
        await this.api.issues.getLabel({ ...repo, name });
      } catch (error) {
        if ((error as { status: number }).status !== 404) throw error;
        try {
          await this.api.issues.createLabel({ ...repo, name, color: '6f42c1' });
        } catch (e) {
          if ((e as { status: number }).status !== 422) throw e;
        }
      }
      await this.api.issues.addLabels({ ...repo, issue_number: number, labels: [name] });
    }
    for (const name of current.filter(
      (n) => prefixes.some((p) => n.startsWith(p)) && !desired.includes(n),
    )) {
      try {
        await this.api.issues.removeLabel({ ...repo, issue_number: number, name });
      } catch (error) {
        if ((error as { status: number }).status !== 404) throw error;
      }
    }
  }
  async preflight(claim: WorkClaim): Promise<Preflight> {
    const { repository, number } = claim.session;
    const repo = this.repo(repository);
    if (!(await this.permission(repository, claim.input.author)))
      return { status: 'cancel', reason: 'requester_lost_write_permission' };
    try {
      const issue = (await this.api.issues.get({ ...repo, issue_number: number })).data;
      if (
        !issue.labels.some(
          (l) => (typeof l === 'string' ? l : l.name) === claim.runConfig.payload.labels.enabled,
        )
      )
        return { status: 'hold', reason: 'session_disabled' };
      if (claim.input.source_kind === 'initial')
        return issue.body?.trim()
          ? { status: 'ready', body: issue.body }
          : { status: 'cancel', reason: 'empty_input' };
      const id = Number(claim.input.source_id);
      if (!Number.isSafeInteger(id)) return { status: 'cancel', reason: 'invalid_input_source' };
      const source =
        claim.input.source_kind === 'comment'
          ? (await this.api.issues.getComment({ ...repo, comment_id: id })).data
          : claim.input.source_kind === 'review_comment'
            ? (await this.api.pulls.getReviewComment({ ...repo, comment_id: id })).data
            : (await this.api.pulls.getReview({ ...repo, pull_number: number, review_id: id }))
                .data;
      return source.body?.trim()
        ? { status: 'ready', body: source.body }
        : { status: 'cancel', reason: 'empty_input' };
    } catch (error) {
      if ((error as { status: number }).status === 404)
        return { status: 'cancel', reason: 'input_deleted' };
      throw error;
    }
  }
}
