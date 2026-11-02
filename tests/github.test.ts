import { describe, expect, it } from 'vitest';
import { GhClient } from '../packages/worker/src/github/client.ts';
import { Store } from '../packages/dispatcher/src/storage/index.ts';
import { config, worker } from './helpers.ts';

function claim() {
  const s = new Store(':memory:', () => 1000000),
    c = config(),
    w = worker(1000000);
  s.workers.register(w, 't'.repeat(48));
  s.sessions.upsert(
    { host: c.github.hostname, repository: 'team/project-a', kind: 'issue', number: 1 },
    ['ai:enabled'],
    true,
    1000000,
    'request',
    'writer',
  );
  const result = s.executions.claim(w.id, c);
  s.close();
  return result;
}
describe('observable direct GitHub writes', () => {
  it('checks attribution only on linked new PRs owned by the current local account', async () => {
    const c = claim();
    // Scheduling uses the same test clock as the reported catalogue.
    expect(c).not.toBeNull();
    const github = new GhClient(c!.session.host),
      read: string[] = [];
    github.account = async () => ({ id: 123, login: 'coworker' });
    github.api = async <T>(endpoint: string) => {
      read.push(endpoint);
      const n = Number(endpoint.split('/').at(-1));
      return {
        user: { id: n === 3 ? 999 : 123 },
        created_at: new Date(n === 2 ? 900000 : 1000000).toISOString(),
        body: n === 4 ? c!.runConfig.payload.output.attribution : 'AI PR body',
      } as T;
    };
    const text = [1, 2, 3, 4]
      .map((n) => `https://${c!.session.host}/team/project-a/pull/${n}`)
      .join(' ');
    expect(await github.verifyOutput(c!, { kind: 'completed', text }, 1000000)).toEqual([1]);
    expect(read).toHaveLength(4);
  });
  it('does not follow external hosts, other repositories or credential-bearing URLs from an AI answer', async () => {
    const c = claim()!,
      github = new GhClient(c.session.host);
    let reads = 0;
    github.account = async () => {
      reads++;
      return { id: 123, login: 'coworker' };
    };
    const text = `https://external.example/team/project-a/pull/1 https://${c.session.host}/other/repo/pull/2 https://user:secret@${c.session.host}/team/project-a/pull/3`;
    expect(await github.verifyOutput(c, { kind: 'completed', text }, 1000000)).toEqual([]);
    expect(reads).toBe(0);
  });
});

function conversationFixture(kind: string, body: string | null = 'request') {
  const request = claim()!;
  request.session.kind = 'pull';
  request.input.source_kind = kind;
  request.input.source_id = '42';
  const github = new GhClient(request.session.host);
  github.api = async <T>(endpoint: string) => {
    if (endpoint.endsWith('/permission')) return { permission: 'write' } as T;
    return {
      title: 'request',
      body: kind === 'initial' ? body : 'context',
      html_url: 'https://github.example.internal/team/project-a/pull/1',
    } as T;
  };
  github.pages = async <T>(endpoint: string) => {
    const stream = endpoint.includes('/reviews?')
      ? 'review'
      : endpoint.includes('/pulls/')
        ? 'review_comment'
        : 'comment';
    return (
      stream === kind && body !== null ? [{ id: 42, body, user: { id: 123, login: 'writer' } }] : []
    ) as T[];
  };
  return { request, github };
}
describe('last-moment GitHub input verification', () => {
  it.each(['initial', 'comment', 'review', 'review_comment'])(
    'does not execute a changed %s source',
    async (kind) => {
      const { request, github } = conversationFixture(kind, 'edited after claim');
      await expect(github.context(request)).rejects.toThrow('input_changed_before_start');
    },
  );
  it.each(['initial', 'comment', 'review', 'review_comment'])(
    'does not execute a deleted %s source',
    async (kind) => {
      const { request, github } = conversationFixture(kind, null);
      await expect(github.context(request)).rejects.toThrow('input_deleted');
    },
  );
  it.each(['initial', 'comment', 'review', 'review_comment'])(
    'preserves an unchanged %s source and its conversation context',
    async (kind) => {
      const { request, github } = conversationFixture(kind);
      expect(JSON.parse(await github.context(request)).issue.title).toBe('request');
    },
  );
  it('ignores comments whose GitHub account has been deleted while reconciling a delivery', async () => {
    const request = claim()!,
      github = new GhClient(request.session.host);
    github.comments = async () => [{ id: 42, body: 'prior comment', user: null }];
    await expect(
      github.findDelivery({
        id: 'delivery',
        session: request.session,
        body: 'answer',
        body_hash: 'hash',
        authors: ['123'],
        leaseDuration: 90000,
      }),
    ).resolves.toBeUndefined();
  });
});
