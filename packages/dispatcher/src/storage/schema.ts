import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { Config } from '../../../shared/src/config.ts';

export const configSnapshots = sqliteTable('config_snapshots', {
  revision: text('revision').primaryKey(),
  payload: text('payload', { mode: 'json' }).$type<Config>().notNull(),
  createdAt: integer('created_at').notNull(),
});
