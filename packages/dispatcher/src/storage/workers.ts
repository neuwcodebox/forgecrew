import type { StorageContext } from './database.ts';
import { hash, secretEqual } from '../../../shared/src/hash.ts';
import { ContractError } from '../../../shared/src/types.ts';
import type { WorkerCapabilities } from '../../../shared/src/types.ts';

export class WorkerRegistry {
  private readonly database: StorageContext;
  constructor(database: StorageContext) {
    this.database = database;
  }

  register(capabilities: WorkerCapabilities, token: string) {
    if (token.length < 32) throw new ContractError('worker_token_too_short', 400);
    const old = this.database.sqlite
      .prepare('SELECT token_hash FROM workers WHERE id=?')
      .get(capabilities.id) as { token_hash: string } | undefined;
    if (old && !secretEqual(old.token_hash, hash(token)))
      throw new ContractError('worker_identity_conflict', 403);
    this.database.sqlite
      .prepare(
        'INSERT INTO workers VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET capabilities=excluded.capabilities,seen_at=excluded.seen_at',
      )
      .run(capabilities.id, hash(token), JSON.stringify(capabilities), this.database.now());
  }

  authenticate(id: string, token: string): boolean {
    const row = this.database.sqlite
      .prepare('SELECT token_hash FROM workers WHERE id=?')
      .get(id) as { token_hash: string } | undefined;
    return !!row && secretEqual(row.token_hash, hash(token));
  }

  heartbeat(id: string, capabilities: WorkerCapabilities) {
    if (id !== capabilities.id) throw new ContractError('worker_identity_mismatch', 403);
    this.database.sqlite
      .prepare('UPDATE workers SET capabilities=?,seen_at=? WHERE id=?')
      .run(JSON.stringify(capabilities), this.database.now(), id);
  }

  find(id: string) {
    const row = this.database.sqlite
      .prepare('SELECT capabilities,seen_at FROM workers WHERE id=?')
      .get(id) as { capabilities: string; seen_at: number } | undefined;
    return row
      ? { capabilities: JSON.parse(row.capabilities) as WorkerCapabilities, seen_at: row.seen_at }
      : undefined;
  }
  candidates() {
    return this.database.sqlite
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM attempts a WHERE a.worker_id=w.id AND a.status IN ('running','stopping')) AS active FROM workers w`,
      )
      .all()
      .map((row) => {
        const w = row as { capabilities: string; active: number; seen_at: number };
        return {
          worker: JSON.parse(w.capabilities) as WorkerCapabilities,
          active: w.active,
          seenAt: w.seen_at,
        };
      });
  }
}
