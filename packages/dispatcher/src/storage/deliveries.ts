import type { StorageContext } from './database.ts';
import { randomUUID } from 'node:crypto';
import { hash } from '../../../shared/src/hash.ts';
import { splitOutput } from '../../../shared/src/output.ts';
import { ContractError } from '../../../shared/src/types.ts';
import type { Result } from '../../../shared/src/types.ts';
import type { RunConfig } from '../../../shared/src/protocol.ts';
import type { WorkerRegistry } from './workers.ts';
import type { SessionRepository } from './sessions.ts';
import type { Delivery, Attempt } from './types.ts';

// Only the first unfinished part of a session may be reconciled or posted.
const claimable = `d.status!='posted' AND (d.claim_until IS NULL OR d.claim_until<=?)
  AND NOT EXISTS (
    SELECT 1 FROM deliveries earlier
    WHERE earlier.session_id=d.session_id AND earlier.rowid<d.rowid AND earlier.status!='posted'
  )`;

export class DeliveryRepository {
  private readonly database: StorageContext;
  private readonly workers: Pick<WorkerRegistry, 'find'>;
  private readonly sessions: Pick<SessionRepository, 'get'>;
  constructor(
    database: StorageContext,
    workers: Pick<WorkerRegistry, 'find'>,
    sessions: Pick<SessionRepository, 'get'>,
  ) {
    this.database = database;
    this.workers = workers;
    this.sessions = sessions;
  }

  hasPending(worker: string): boolean {
    const row = this.workers.find(worker);
    if (!row) return false;
    const repositories = row.capabilities.repositories.map((r) => r.toLowerCase());
    const pending = this.database.sqlite
      .prepare(
        `SELECT s.repository FROM deliveries d JOIN sessions s ON s.id=d.session_id WHERE ${claimable}`,
      )
      .all(this.database.now()) as { repository: string }[];
    return pending.some((d) => repositories.includes(d.repository.toLowerCase()));
  }

  claim(worker: string, ttl: number) {
    return this.database.sqlite
      .transaction(() => {
        const c = this.workers.find(worker);
        if (!c) throw new ContractError('unknown_worker', 403);
        const capabilities = c.capabilities;
        const pending = this.database.sqlite
          .prepare(`SELECT d.* FROM deliveries d WHERE ${claimable} ORDER BY d.rowid`)
          .all(this.database.now()) as Delivery[];
        const d = pending.find((d) =>
          capabilities.repositories.some(
            (r) => r.toLowerCase() === this.sessions.get(d.session_id)!.repository.toLowerCase(),
          ),
        );
        if (!d) return null;
        // expected_author is intentionally retained after an uncertain earlier post.
        const authors = [
          ...new Set([
            ...(
              this.database.sqlite
                .prepare('SELECT author_id FROM delivery_authors WHERE delivery_id=?')
                .all(d.id) as { author_id: string }[]
            ).map((r) => r.author_id),
            capabilities.githubId,
          ]),
        ];
        this.database.sqlite
          .prepare(
            "UPDATE deliveries SET status='claimed',worker_id=?,claim_until=?,lease_duration=? WHERE id=?",
          )
          .run(worker, this.database.now() + ttl, ttl, d.id);
        return { ...d, session: this.sessions.get(d.session_id)!, authors, leaseDuration: ttl };
      })
      .immediate();
  }

  renew(worker: string, id: string) {
    return this.database.sqlite
      .transaction(() => {
        const d = this.database.sqlite.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as
          Delivery | undefined;
        if (
          !d ||
          d.worker_id !== worker ||
          !d.claim_until ||
          d.claim_until <= this.database.now() ||
          !d.lease_duration ||
          d.status === 'posted'
        )
          throw new ContractError('delivery_lease_expired');
        this.database.sqlite
          .prepare('UPDATE deliveries SET claim_until=? WHERE id=?')
          .run(this.database.now() + d.lease_duration, id);
        return { leaseDuration: d.lease_duration };
      })
      .immediate();
  }

  beginPost(worker: string, id: string): Delivery {
    const d = this.database.sqlite.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as
      Delivery | undefined;
    if (
      !d ||
      d.worker_id !== worker ||
      !d.claim_until ||
      d.claim_until <= this.database.now() ||
      d.status === 'posted'
    )
      throw new ContractError('delivery_lease_expired');
    const w = this.workers.find(worker)!;
    const author = w.capabilities.githubId;
    this.database.sqlite
      .transaction(() => {
        this.database.sqlite
          .prepare('INSERT OR IGNORE INTO delivery_authors VALUES (?,?)')
          .run(id, author);
        this.database.sqlite
          .prepare("UPDATE deliveries SET expected_author=?,status='unknown' WHERE id=?")
          .run(author, id);
      })
      .immediate();
    return d;
  }

  receipt(worker: string, id: string, githubId: string) {
    const d = this.database.sqlite.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as
      Delivery | undefined;
    if (!d || d.worker_id !== worker) throw new ContractError('delivery_lease_expired');
    if (d.status === 'posted') {
      if (d.github_id !== githubId) throw new ContractError('receipt_conflict');
      return;
    }
    if (!d.claim_until || d.claim_until <= this.database.now())
      throw new ContractError('delivery_lease_expired');
    this.database.sqlite
      .transaction(() => {
        this.database.sqlite
          .prepare("UPDATE deliveries SET status='posted',github_id=? WHERE id=?")
          .run(githubId, id);
        this.database.sqlite
          .prepare('INSERT OR IGNORE INTO automatic_sources VALUES (?,?)')
          .run(d.session_id, githubId);
      })
      .immediate();
  }

  isAutomatic(session: string, githubId: string, authorId: string, body: string): boolean {
    if (
      this.database.sqlite
        .prepare('SELECT 1 FROM automatic_sources WHERE session_id=? AND github_id=?')
        .get(session, githubId)
    )
      return true;
    const marker = /<!-- forgecrew:delivery=([a-zA-Z0-9_-]+) -->\s*$/.exec(body)?.[1];
    if (!marker) return false;
    const d = this.database.sqlite
      .prepare('SELECT * FROM deliveries WHERE id=? AND session_id=?')
      .get(marker, session) as Delivery | undefined;
    if (
      !d ||
      !this.database.sqlite
        .prepare('SELECT 1 FROM delivery_authors WHERE delivery_id=? AND author_id=?')
        .get(d.id, authorId) ||
      d.body_hash !== hash(body)
    )
      return false;
    this.database.sqlite
      .prepare('INSERT OR IGNORE INTO automatic_sources VALUES (?,?)')
      .run(session, githubId);
    return true;
  }

  notice(sessionId: string, key: string, text: string, output: RunConfig['payload']['output']) {
    const turnId = 'notice:' + key;
    if (this.idsForTurn(turnId).length) return;
    this.create(
      { session_id: sessionId, turn_id: turnId },
      { kind: 'completed', text, origin: 'runtime' },
      output,
    );
  }

  idsForTurn(turnId: string): string[] {
    return (
      this.database.sqlite
        .prepare('SELECT id FROM deliveries WHERE turn_id=? ORDER BY rowid')
        .all(turnId) as { id: string }[]
    ).map((delivery) => delivery.id);
  }
  create(
    attempt: Pick<Attempt, 'session_id' | 'turn_id'>,
    result: Result,
    output: RunConfig['payload']['output'],
  ): string[] {
    const attribution =
      result.origin === 'runtime' ? output.automationAttribution : output.attribution;
    const deliveries = splitOutput(result.text, attribution, randomUUID());
    for (const delivery of deliveries) {
      this.database.sqlite
        .prepare(
          "INSERT INTO deliveries(id,session_id,turn_id,body,body_hash,expected_author,status,worker_id,claim_until,github_id) VALUES (?,?,?,?,?,NULL,'pending',NULL,NULL,NULL)",
        )
        .run(delivery.id, attempt.session_id, attempt.turn_id, delivery.body, delivery.bodyHash);
    }
    return deliveries.map((delivery) => delivery.id);
  }
}
