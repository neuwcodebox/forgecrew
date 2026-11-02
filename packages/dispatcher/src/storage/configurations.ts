import type { StorageContext } from './database.ts';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { configSnapshots } from './schema.ts';
import { configRevision } from '../../../shared/src/config.ts';
import type { Config } from '../../../shared/src/config.ts';
import { ContractError } from '../../../shared/src/types.ts';

export class ConfigSnapshots {
  private readonly now: () => number;
  private readonly orm: ReturnType<typeof drizzle>;
  constructor(database: StorageContext) {
    this.orm = drizzle(database.sqlite);
    this.now = database.now;
  }

  save(config: Config) {
    this.orm
      .insert(configSnapshots)
      .values({ revision: configRevision(config), payload: config, createdAt: this.now() })
      .onConflictDoNothing()
      .run();
  }

  get(revision: string): Config {
    const row = this.orm
      .select()
      .from(configSnapshots)
      .where(eq(configSnapshots.revision, revision))
      .get();
    if (!row) throw new ContractError('config_not_found', 404);
    return row.payload;
  }
}
