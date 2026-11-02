import { canWrite } from '../../../shared/src/input.ts';
import { hash } from '../../../shared/src/hash.ts';
import type { Result } from '../../../shared/src/types.ts';
import type { DeliveryClaim, WorkClaim, WorkSession } from '../../../shared/src/protocol.ts';

import { command } from '../process.ts';
import type { GitHubComment, GitHubGateway } from './contracts.ts';
export class GhClient implements GitHubGateway {
  readonly hostname: string;
  private readonly execute: typeof command;
  constructor(hostname: string, execute: typeof command = command) {
    this.hostname = hostname;
    this.execute = execute;
  }
  async api<T>(
    endpoint: string,
    method = 'GET',
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await this.execute(
      'gh',
      [
        'api',
        '--hostname',
        this.hostname,
        endpoint,
        '--method',
        method,
        ...(payload === undefined ? [] : ['--input', '-']),
      ],
      {
        ...(payload === undefined ? {} : { input: JSON.stringify(payload) }),
        timeout: 30000,
        maxBytes: 20 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.code !== 0) throw new Error('github_request_failed');
    return JSON.parse(result.stdout) as T;
  }
  async pages<T>(endpoint: string, signal?: AbortSignal): Promise<T[]> {
    const result = await this.execute(
      'gh',
      ['api', '--hostname', this.hostname, endpoint, '--paginate', '--slurp'],
      { timeout: 60000, maxBytes: 20 * 1024 * 1024, ...(signal ? { signal } : {}) },
    );
    if (result.code !== 0) throw new Error('github_pagination_failed');
    return (JSON.parse(result.stdout) as T[][]).flat();
  }
  account(signal?: AbortSignal) {
    return this.api<{ id: number; login: string }>('user', 'GET', undefined, signal);
  }
  async repositories(names: string[]): Promise<string[]> {
    const accessible: string[] = [];
    for (const name of names) {
      try {
        const repo = await this.api<{ permissions?: { push?: boolean; admin?: boolean } }>(
          'repos/' + name,
        );
        if (repo.permissions?.push || repo.permissions?.admin) accessible.push(name);
      } catch {
        /* One inaccessible repository does not disable the Worker. */
      }
    }
    return accessible;
  }
  comments(session: WorkSession, signal?: AbortSignal) {
    return this.pages<GitHubComment>(
      `repos/${session.repository}/issues/${session.number}/comments?per_page=100`,
      signal,
    );
  }
  async context(claim: WorkClaim, signal?: AbortSignal): Promise<string> {
    if (claim.session.host !== this.hostname) throw new Error('github_host_mismatch');
    const permission = await this.api<{ permission: string }>(
      `repos/${claim.session.repository}/collaborators/${encodeURIComponent(claim.input.author)}/permission`,
      'GET',
      undefined,
      signal,
    );
    if (!canWrite(permission)) throw new Error('requester_no_longer_has_write_access');
    const issue = await this.api<{ title: string; body: string; html_url: string }>(
      `repos/${claim.session.repository}/issues/${claim.session.number}`,
      'GET',
      undefined,
      signal,
    );
    const comments = await this.comments(claim.session, signal);
    if (claim.input.source_kind === 'comment') {
      const source = comments.find((c) => String(c.id) === claim.input.source_id);
      if (!source) throw new Error('input_deleted');
      if (source.body !== claim.input.body) throw new Error('input_changed_before_start');
    }
    let pull: unknown;
    if (claim.session.kind === 'pull') {
      const details = await this.api(
        `repos/${claim.session.repository}/pulls/${claim.session.number}`,
        'GET',
        undefined,
        signal,
      );
      const reviews = await this.pages(
        `repos/${claim.session.repository}/pulls/${claim.session.number}/reviews?per_page=100`,
        signal,
      );
      const reviewComments = await this.pages(
        `repos/${claim.session.repository}/pulls/${claim.session.number}/comments?per_page=100`,
        signal,
      );
      pull = { details, reviews, reviewComments };
    }
    return JSON.stringify({ issue, comments, pull });
  }
  async verifyOutput(
    claim: WorkClaim,
    result: Result,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const links = [...(result.links ?? []), ...(result.text.match(/https:\/\/[^\s<>()]+/g) ?? [])];
    const numbers = new Set<number>(),
      prefix = '/' + claim.session.repository.toLowerCase() + '/pull/';
    for (const link of links.slice(0, 20)) {
      try {
        const url = new URL(link.replace(/[.,;:!?]+$/, ''));
        if (
          url.protocol !== 'https:' ||
          url.host.toLowerCase() !== this.hostname.toLowerCase() ||
          url.username ||
          url.password ||
          !url.pathname.toLowerCase().startsWith(prefix)
        )
          continue;
        const tail = url.pathname.slice(prefix.length);
        if (/^\d+$/.test(tail)) numbers.add(Number(tail));
      } catch {
        /* Non-URL answer text is not an observed write. */
      }
    }
    if (!numbers.size) return [];
    const account = await this.account(signal),
      missing: number[] = [];
    for (const number of numbers) {
      const pull = await this.api<{
        body: string | null;
        created_at: string;
        user: { id: number };
      }>(`repos/${claim.session.repository}/pulls/${number}`, 'GET', undefined, signal);
      if (
        pull.user.id === account.id &&
        Date.parse(pull.created_at) >= Math.floor(startedAt / 1000) * 1000 &&
        !pull.body?.includes(claim.runConfig.payload.output.attribution.trim())
      )
        missing.push(number);
    }
    return missing;
  }
  async findDelivery(
    delivery: DeliveryClaim,
    signal?: AbortSignal,
  ): Promise<GitHubComment | undefined> {
    return (await this.comments(delivery.session, signal)).find(
      (comment) =>
        delivery.authors.includes(String(comment.user.id)) &&
        hash(comment.body) === delivery.body_hash &&
        comment.body.includes(`<!-- forgecrew:delivery=${delivery.id} -->`),
    );
  }
  post(delivery: DeliveryClaim, signal?: AbortSignal) {
    return this.api<{ id: number; html_url: string }>(
      `repos/${delivery.session.repository}/issues/${delivery.session.number}/comments`,
      'POST',
      { body: delivery.body },
      signal,
    );
  }
}
