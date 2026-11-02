import type { StorageContext } from './database.ts';
import { hash, sessionId } from '../../../shared/src/hash.ts';
import type { SessionKey } from '../../../shared/src/types.ts';
import type { Session, Input, ActivationWindow } from './types.ts';

export class SessionRepository {
  private readonly database: StorageContext;
  constructor(database: StorageContext) {
    this.database = database;
  }

  upsert(
    key: SessionKey,
    labels: string[],
    active: boolean,
    activationAt: number,
    body: string,
    author: string,
    windows?: ActivationWindow[],
  ): string {
    const id = sessionId(key);
    this.database.sqlite
      .transaction(() => {
        const previous = this.get(id);
        this.database.sqlite
          .prepare(
            `INSERT INTO sessions(id,host,repository,kind,number,active,activation_at,labels) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,activation_at=excluded.activation_at,labels=excluded.labels`,
          )
          .run(
            id,
            key.host.toLowerCase(),
            key.repository.toLowerCase(),
            key.kind,
            key.number,
            Number(active),
            activationAt,
            JSON.stringify(labels),
          );
        if (windows) {
          this.database.sqlite.prepare('DELETE FROM activation_windows WHERE session_id=?').run(id);
          for (const w of windows)
            this.database.sqlite
              .prepare(
                'INSERT INTO activation_windows VALUES (?,?,?) ON CONFLICT(session_id,opened_at) DO UPDATE SET closed_at=excluded.closed_at',
              )
              .run(id, w.openedAt, w.closedAt);
        }
        if (
          windows?.length &&
          !this.database.sqlite
            .prepare("SELECT 1 FROM inputs WHERE session_id=? AND source_kind='initial'")
            .get(id)
        )
          this.enqueue(id, 'initial', id, body, author, windows[0]!.openedAt, windows[0]!.openedAt);
        else if (!previous && active)
          this.enqueue(id, 'initial', id, body, author, activationAt, activationAt);
        else if (
          previous &&
          active &&
          !this.database.sqlite
            .prepare("SELECT 1 FROM inputs WHERE session_id=? AND source_kind='initial'")
            .get(id)
        )
          this.enqueue(id, 'initial', id, body, author, activationAt, activationAt);
      })
      .immediate();
    return id;
  }

  get(id: string): Session | undefined {
    return this.database.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get(id) as
      Session | undefined;
  }

  list(repository: string): Session[] {
    return this.database.sqlite
      .prepare('SELECT * FROM sessions WHERE repository=? ORDER BY number')
      .all(repository.toLowerCase()) as Session[];
  }

  enqueue(
    session: string,
    kind: string,
    source: string,
    body: string,
    author: string,
    createdAt: number,
    updatedAt = createdAt,
  ): boolean {
    const s = this.get(session);
    if (!s || !body.trim()) return false;
    const id = hash([s.host, kind, source]);
    const old = this.database.sqlite.prepare('SELECT * FROM inputs WHERE id=?').get(id) as
      Input | undefined;
    if (old) {
      if (old.status === 'queued')
        this.database.sqlite
          .prepare('UPDATE inputs SET body=?,updated_at=? WHERE id=? AND updated_at<=?')
          .run(body, updatedAt, id, updatedAt);
      return false;
    }
    const hasWindows = this.database.sqlite
      .prepare('SELECT 1 FROM activation_windows WHERE session_id=? LIMIT 1')
      .get(session);
    const eligible = hasWindows
      ? this.database.sqlite
          .prepare(
            'SELECT 1 FROM activation_windows WHERE session_id=? AND opened_at<=? AND (closed_at IS NULL OR closed_at>?) LIMIT 1',
          )
          .get(session, createdAt, createdAt)
      : s.active && createdAt >= s.activation_at;
    if (!eligible) return false;
    this.database.sqlite
      .prepare('INSERT INTO inputs VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, session, kind, source, body, author, createdAt, updatedAt, 'queued');
    return true;
  }
}
