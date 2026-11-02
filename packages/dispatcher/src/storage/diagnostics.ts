import type { StorageContext } from './database.ts';
import { ContractError } from '../../../shared/src/types.ts';
import type { RunConfig } from '../../../shared/src/protocol.ts';
import type { Session, Turn } from './types.ts';
import type { WorkerRegistry } from './workers.ts';

export class Diagnostics {
  private readonly database: StorageContext;
  private readonly workers: Pick<WorkerRegistry, 'find'>;
  constructor(database: StorageContext, workers: Pick<WorkerRegistry, 'find'>) {
    this.database = database;
    this.workers = workers;
  }

  sessionStatus(session: Session) {
    const active = this.database.sqlite
      .prepare(
        "SELECT worker_id FROM attempts WHERE session_id=? AND status IN ('running','stopping')",
      )
      .get(session.id) as { worker_id: string } | undefined;
    const reason = (
      this.database.sqlite
        .prepare('SELECT blocked_reason FROM sessions WHERE id=?')
        .get(session.id) as {
        blocked_reason: string | null;
      }
    ).blocked_reason;
    const queued =
      this.database.sqlite
        .prepare("SELECT 1 FROM inputs WHERE session_id=? AND status='queued'")
        .get(session.id) ||
      this.database.sqlite
        .prepare("SELECT 1 FROM turns WHERE session_id=? AND status='recovering'")
        .get(session.id);
    const latest = this.database.sqlite
      .prepare('SELECT status FROM turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1')
      .get(session.id) as { status: string } | undefined;
    return {
      worker: active?.worker_id ?? session.previous_worker,
      status: active
        ? 'running'
        : !session.active
          ? 'idle'
          : reason
            ? 'blocked'
            : queued
              ? 'queued'
              : latest?.status === 'failed'
                ? 'error'
                : 'idle',
    };
  }

  status(worker: string) {
    const row = this.workers.find(worker);
    if (!row) throw new ContractError('unknown_worker', 403);
    const capabilities = row.capabilities;
    const repositories = capabilities.repositories.map((r) => r.toLowerCase());
    const sessions = (
      this.database.sqlite
        .prepare('SELECT * FROM sessions ORDER BY repository,number')
        .all() as Session[]
    )
      .filter(
        (s) => repositories.includes(s.repository.toLowerCase()) || s.previous_worker === worker,
      )
      .map((session) => {
        const turn = this.database.sqlite
          .prepare('SELECT * FROM turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1')
          .get(session.id) as Turn | undefined;
        const run = turn?.run_config ? (JSON.parse(turn.run_config) as RunConfig) : undefined;
        const attempt = turn
          ? this.database.sqlite
              .prepare(
                'SELECT id,worker_id,generation,status,lease_until FROM attempts WHERE turn_id=? ORDER BY generation DESC LIMIT 1',
              )
              .get(turn.id)
          : undefined;
        const deliveries = this.database.sqlite
          .prepare(
            "SELECT id,status,worker_id,github_id,claim_until FROM deliveries WHERE session_id=? AND status!='posted' ORDER BY rowid",
          )
          .all(session.id);
        return {
          id: session.id,
          repository: session.repository,
          kind: session.kind,
          number: session.number,
          ...this.sessionStatus(session),
          blockedReason: session.blocked_reason,
          turn: turn
            ? {
                id: turn.id,
                status: turn.status,
                generation: turn.generation,
                model: run?.model,
                effort: run?.effort,
                configRevision: run?.configRevision,
                runConfigRevision: run?.runConfigRevision,
              }
            : null,
          attempt: attempt ?? null,
          deliveries,
        };
      });
    return { protocolVersion: 1, worker: { ...capabilities, seenAt: row.seen_at }, sessions };
  }
}
