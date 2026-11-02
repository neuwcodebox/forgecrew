import Sqlite from 'better-sqlite3';

export type StorageContext = { sqlite: Sqlite.Database; now: () => number };

const migration = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS config_snapshots (revision TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, capabilities TEXT NOT NULL, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, host TEXT NOT NULL, repository TEXT NOT NULL, kind TEXT NOT NULL, number INTEGER NOT NULL, active INTEGER NOT NULL, activation_at INTEGER NOT NULL, labels TEXT NOT NULL, previous_worker TEXT, blocked_reason TEXT, UNIQUE(host,repository,kind,number));
CREATE TABLE IF NOT EXISTS activation_windows (session_id TEXT NOT NULL REFERENCES sessions(id), opened_at INTEGER NOT NULL, closed_at INTEGER, PRIMARY KEY(session_id,opened_at));
CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), source_kind TEXT NOT NULL, source_id TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL, UNIQUE(session_id,source_kind,source_id));
CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, input_id TEXT NOT NULL UNIQUE REFERENCES inputs(id), session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL, run_config TEXT, generation INTEGER NOT NULL DEFAULT 0, result TEXT);
CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id), session_id TEXT NOT NULL REFERENCES sessions(id), worker_id TEXT NOT NULL REFERENCES workers(id), generation INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, lease_until INTEGER NOT NULL, lease_duration INTEGER NOT NULL, interrupt_grace INTEGER NOT NULL, reassign_grace INTEGER NOT NULL, result_hash TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_attempt ON attempts(session_id) WHERE status IN ('running','stopping');
CREATE INDEX IF NOT EXISTS attempt_worker ON attempts(worker_id,status);
CREATE TABLE IF NOT EXISTS controls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, attempt_id TEXT, payload TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS steer_restarts (control_id TEXT PRIMARY KEY REFERENCES controls(id), attempt_id TEXT NOT NULL REFERENCES attempts(id));
CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL, expected_author TEXT, status TEXT NOT NULL, worker_id TEXT, claim_until INTEGER, github_id TEXT);
CREATE TABLE IF NOT EXISTS automatic_sources (session_id TEXT NOT NULL, github_id TEXT NOT NULL, PRIMARY KEY(session_id,github_id));
CREATE TABLE IF NOT EXISTS delivery_authors (delivery_id TEXT NOT NULL REFERENCES deliveries(id), author_id TEXT NOT NULL, PRIMARY KEY(delivery_id,author_id));
CREATE TABLE IF NOT EXISTS cursors (scope TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
INSERT OR IGNORE INTO schema_migrations VALUES (1);
`;

export class DatabaseConnection implements StorageContext {
  readonly sqlite: Sqlite.Database;
  readonly now: () => number;
  constructor(path = ':memory:', now: () => number = Date.now) {
    this.now = now;
    this.sqlite = new Sqlite(path);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.sqlite
      .transaction(() => {
        this.sqlite.exec(migration);
        if (
          !(this.sqlite.pragma('table_info(deliveries)') as { name: string }[]).some(
            (column) => column.name === 'lease_duration',
          )
        ) {
          this.sqlite.exec('ALTER TABLE deliveries ADD COLUMN lease_duration INTEGER');
        }
        this.sqlite.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (2)').run();
      })
      .immediate();
  }
  close() {
    this.sqlite.close();
  }
}
