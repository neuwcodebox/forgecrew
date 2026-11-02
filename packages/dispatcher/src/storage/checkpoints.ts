import type { StorageContext } from './database.ts';

export class Checkpoints {
  private readonly database: StorageContext;
  constructor(database: StorageContext) {
    this.database = database;
  }

  get(scope: string): number {
    return (
      (
        this.database.sqlite
          .prepare('SELECT completed_at FROM cursors WHERE scope=?')
          .get(scope) as { completed_at: number } | undefined
      )?.completed_at ?? 0
    );
  }

  advance(scope: string, at: number) {
    this.database.sqlite
      .prepare(
        'INSERT INTO cursors VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET completed_at=MAX(completed_at,excluded.completed_at)',
      )
      .run(scope, at);
  }
}
