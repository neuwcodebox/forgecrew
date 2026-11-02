import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { configSnapshots } from './schema.ts';
import type { Config } from '../../shared/src/config.ts';
import { configRevision, workerProjection } from '../../shared/src/config.ts';
import { hash, sessionId, secretEqual } from '../../shared/src/hash.ts';
import { ContractError } from '../../shared/src/types.ts';
import type { Control, Result, SessionKey, WorkerCapabilities } from '../../shared/src/types.ts';
import { resolveLabels, selectWorker } from '../../shared/src/models.ts';
import { splitOutput } from '../../shared/src/output.ts';
import type { RunConfig } from '../../shared/src/protocol.ts';

type Session = { id: string; host: string; repository: string; kind: 'issue' | 'pull'; number: number; active: number; activation_at: number; labels: string; previous_worker: string | null; blocked_reason:string|null };
type Input = { id: string; session_id: string; source_kind:string;source_id:string; body: string; author: string; created_at: number; status: string };
type Turn = { id: string; input_id: string; session_id: string; status: string; run_config: string | null; generation: number };
export type Attempt = { id: string; turn_id: string; session_id: string; worker_id: string; generation: number; status: string; started_at: number; ended_at: number | null; lease_until: number; lease_duration: number; interrupt_grace: number; reassign_grace: number; result_hash: string | null };
export type Delivery = { id: string; session_id: string; turn_id: string; body: string; body_hash: string; expected_author: string | null; status: string; worker_id: string | null; claim_until: number | null; github_id: string | null; lease_duration:number|null };
export type { RunConfig } from '../../shared/src/protocol.ts';
export type ActivationWindow={openedAt:number;closedAt:number|null};
export type Preflight={status:'ready'|'hold'|'cancel';body?:string;reason?:string};

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

export class Store {
  readonly sqlite: Database.Database;
  readonly orm: ReturnType<typeof drizzle>;
  readonly now: () => number;
  constructor(path = ':memory:', now: () => number = Date.now) {
    this.now = now;
    this.sqlite = new Database(path);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.sqlite.transaction(() => {
      this.sqlite.exec(migration);
      if(!(this.sqlite.pragma('table_info(deliveries)') as {name:string}[]).some(c=>c.name==='lease_duration'))this.sqlite.exec('ALTER TABLE deliveries ADD COLUMN lease_duration INTEGER');
      this.sqlite.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (2)').run();
    }).immediate();
    this.orm = drizzle(this.sqlite);
  }
  close() { this.sqlite.close(); }
  saveConfig(config: Config) {
    this.orm.insert(configSnapshots).values({ revision: configRevision(config), payload: config, createdAt: this.now() }).onConflictDoNothing().run();
  }
  getConfig(revision: string): Config {
    const row = this.orm.select().from(configSnapshots).where(eq(configSnapshots.revision, revision)).get();
    if (!row) throw new ContractError('config_not_found', 404);
    return row.payload;
  }
  register(capabilities: WorkerCapabilities, token: string) {
    if (token.length < 32) throw new ContractError('worker_token_too_short', 400);
    const old = this.sqlite.prepare('SELECT token_hash FROM workers WHERE id=?').get(capabilities.id) as { token_hash: string } | undefined;
    if (old && !secretEqual(old.token_hash, hash(token))) throw new ContractError('worker_identity_conflict', 403);
    this.sqlite.prepare('INSERT INTO workers VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET capabilities=excluded.capabilities,seen_at=excluded.seen_at').run(capabilities.id, hash(token), JSON.stringify(capabilities), this.now());
  }
  authenticate(id: string, token: string): boolean {
    const row = this.sqlite.prepare('SELECT token_hash FROM workers WHERE id=?').get(id) as { token_hash: string } | undefined;
    return !!row && secretEqual(row.token_hash, hash(token));
  }
  heartbeat(id: string, capabilities: WorkerCapabilities) {
    if (id !== capabilities.id) throw new ContractError('worker_identity_mismatch', 403);
    this.sqlite.prepare('UPDATE workers SET capabilities=?,seen_at=? WHERE id=?').run(JSON.stringify(capabilities), this.now(), id);
  }
  upsertSession(key: SessionKey, labels: string[], active: boolean, activationAt: number, body: string, author: string,windows?:ActivationWindow[]): string {
    const id = sessionId(key);
    this.sqlite.transaction(() => {
      const previous = this.getSession(id);
      this.sqlite.prepare(`INSERT INTO sessions(id,host,repository,kind,number,active,activation_at,labels) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,activation_at=excluded.activation_at,labels=excluded.labels`).run(id, key.host.toLowerCase(), key.repository.toLowerCase(), key.kind, key.number, Number(active), activationAt, JSON.stringify(labels));
      if(windows) {
        this.sqlite.prepare('DELETE FROM activation_windows WHERE session_id=?').run(id);
        for(const w of windows)this.sqlite.prepare('INSERT INTO activation_windows VALUES (?,?,?) ON CONFLICT(session_id,opened_at) DO UPDATE SET closed_at=excluded.closed_at').run(id,w.openedAt,w.closedAt);
      }
      if(windows?.length&&!this.sqlite.prepare("SELECT 1 FROM inputs WHERE session_id=? AND source_kind='initial'").get(id))this.enqueue(id,'initial',id,body,author,windows[0]!.openedAt,windows[0]!.openedAt);
      else if (!previous && active) this.enqueue(id, 'initial', id, body, author, activationAt, activationAt);
      else if (previous && active && !this.sqlite.prepare("SELECT 1 FROM inputs WHERE session_id=? AND source_kind='initial'").get(id)) this.enqueue(id, 'initial', id, body, author, activationAt, activationAt);
    }).immediate();
    return id;
  }
  getSession(id: string): Session | undefined { return this.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Session | undefined; }
  sessions(repository:string):Session[] {return this.sqlite.prepare('SELECT * FROM sessions WHERE repository=? ORDER BY number').all(repository.toLowerCase()) as Session[];}
  sessionStatus(session:Session) {
    const active=this.sqlite.prepare("SELECT worker_id FROM attempts WHERE session_id=? AND status IN ('running','stopping')").get(session.id) as {worker_id:string}|undefined;
    const reason=(this.sqlite.prepare('SELECT blocked_reason FROM sessions WHERE id=?').get(session.id) as {blocked_reason:string|null}).blocked_reason;
    const queued=this.sqlite.prepare("SELECT 1 FROM inputs WHERE session_id=? AND status='queued'").get(session.id)||this.sqlite.prepare("SELECT 1 FROM turns WHERE session_id=? AND status='recovering'").get(session.id);
    const latest=this.sqlite.prepare('SELECT status FROM turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(session.id) as {status:string}|undefined;
    return {worker:active?.worker_id??session.previous_worker,status:active?'running':!session.active?'idle':reason?'blocked':queued?'queued':latest?.status==='failed'?'error':'idle'};
  }
  enqueue(session: string, kind: string, source: string, body: string, author: string, createdAt: number, updatedAt = createdAt): boolean {
    const s = this.getSession(session);
    if (!s || !body.trim()) return false;
    const id = hash([s.host,kind,source]);
    const old = this.sqlite.prepare('SELECT * FROM inputs WHERE id=?').get(id) as Input | undefined;
    if (old) {
      if (old.status === 'queued') this.sqlite.prepare('UPDATE inputs SET body=?,updated_at=? WHERE id=? AND updated_at<=?').run(body, updatedAt, id, updatedAt);
      return false;
    }
    const hasWindows=this.sqlite.prepare('SELECT 1 FROM activation_windows WHERE session_id=? LIMIT 1').get(session);
    const eligible=hasWindows?this.sqlite.prepare('SELECT 1 FROM activation_windows WHERE session_id=? AND opened_at<=? AND (closed_at IS NULL OR closed_at>?) LIMIT 1').get(session,createdAt,createdAt):s.active&&createdAt>=s.activation_at;
    if(!eligible)return false;
    this.sqlite.prepare('INSERT INTO inputs VALUES (?,?,?,?,?,?,?,?,?)').run(id, session, kind, source, body, author, createdAt, updatedAt, 'queued');
    return true;
  }
  addControl(session: string, source: string, control: Control, createdAt: number) {
    const attempt = this.sqlite.prepare("SELECT * FROM attempts WHERE session_id=? AND started_at<=? AND (ended_at IS NULL OR ended_at>=?) ORDER BY started_at DESC LIMIT 1").get(session, createdAt, createdAt) as Attempt | undefined;
    this.sqlite.prepare('INSERT OR IGNORE INTO controls VALUES (?,?,?,?,?)').run(hash([session, source]), session, attempt?.id ?? null, JSON.stringify(control), attempt && attempt.status !== 'terminal' ? 'pending' : 'not_applied');
  }
  controls(worker: string) {
    return this.sqlite.prepare("SELECT c.id,c.attempt_id,c.payload FROM controls c JOIN attempts a ON a.id=c.attempt_id WHERE a.worker_id=? AND a.status IN ('running','stopping') AND c.status='pending'").all(worker).map(row => {
      const r = row as { id: string; attempt_id: string; payload: string }; return { id: r.id, attemptId: r.attempt_id, control: JSON.parse(r.payload) as Control };
    });
  }
  ackControl(worker: string, id: string) {
    this.sqlite.prepare("UPDATE controls SET status='applied' WHERE id=? AND attempt_id IN (SELECT id FROM attempts WHERE worker_id=?)").run(id, worker);
  }
  private steering(turnId:string):{id:string;text:string}[] {
    return this.sqlite.prepare("SELECT c.id,json_extract(c.payload,'$.text') AS text FROM controls c JOIN attempts a ON a.id=c.attempt_id WHERE a.turn_id=? AND c.status='applied' AND json_extract(c.payload,'$.kind')='steer' ORDER BY c.rowid").all(turnId) as {id:string;text:string}[];
  }
  private candidates() {
    return this.sqlite.prepare(`SELECT w.*, (SELECT COUNT(*) FROM attempts a WHERE a.worker_id=w.id AND a.status IN ('running','stopping')) AS active FROM workers w`).all().map(row => {
      const w = row as { capabilities: string; active: number; seen_at: number }; return { worker: JSON.parse(w.capabilities) as WorkerCapabilities, active: w.active, seenAt: w.seen_at };
    });
  }
  claim(workerId: string, config: Config) {
    return this.sqlite.transaction(() => {
      this.expire();
      const sessions = this.sqlite.prepare(`SELECT s.* FROM sessions s WHERE active=1 AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.session_id=s.id AND a.status IN ('running','stopping')) AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.session_id=s.id AND d.status!='posted') ORDER BY activation_at,id`).all() as Session[];
      for (const session of sessions) {
        if (!config.github.repositories.some(r => r.name.toLowerCase() === session.repository.toLowerCase())) continue;
        const recovering = this.sqlite.prepare("SELECT * FROM turns WHERE session_id=? AND status='recovering' ORDER BY rowid LIMIT 1").get(session.id) as Turn | undefined;
        const input = recovering ? this.sqlite.prepare('SELECT * FROM inputs WHERE id=?').get(recovering.input_id) as Input : this.sqlite.prepare("SELECT * FROM inputs WHERE session_id=? AND status='queued' ORDER BY created_at,source_id LIMIT 1").get(session.id) as Input | undefined;
        if (!input) continue;
        try {
          const prior = recovering?.run_config ? JSON.parse(recovering.run_config) as RunConfig : undefined;
          const requested = prior ? {family:prior.family as 'sol'|'terra'|'opus'|'sonnet',effort:prior.effort as 'low'|'medium'|'high'|'xhigh'|null} : resolveLabels(JSON.parse(session.labels), config, session.repository);
          const selected = selectWorker(this.candidates().map(c => prior ? ({ ...c, worker: { ...c.worker, models: c.worker.models.filter(m => m.id === prior.model) } }) : c), session.repository, (prior?.family ?? requested.family) as typeof requested.family, (prior ? prior.effort : requested.effort) as typeof requested.effort, this.now(), config, session.previous_worker ?? undefined);
          if (selected.worker.id !== workerId) continue;
          const turnId = recovering?.id ?? randomUUID();
          const runBase = { ...workerProjection(config), sessionConfigRevision: hash(JSON.parse(session.labels)), model: selected.model.id, engine: selected.model.engine, effort: selected.effort, family: requested.family };
          const runConfig: RunConfig = prior ?? { ...runBase, runConfigRevision: hash(runBase) };
          const generation = (recovering?.generation ?? 0) + 1;
          this.sqlite.prepare(`INSERT INTO turns(id,input_id,session_id,status,run_config,generation) VALUES (?,?,?,'running',?,?) ON CONFLICT(id) DO UPDATE SET status='running',generation=excluded.generation`).run(turnId,input.id,session.id,JSON.stringify(runConfig),generation);
          this.sqlite.prepare("UPDATE inputs SET status='dispatched' WHERE id=?").run(input.id);
          const id = randomUUID(); const now = this.now();
          this.sqlite.prepare("INSERT INTO attempts VALUES (?,?,?,?,?,'running',?,NULL,?,?,?,?,NULL)").run(id,turnId,session.id,workerId,generation,now,now+config.runtime.leaseDuration,config.runtime.leaseDuration,config.runtime.interruptGrace,config.runtime.reassignGrace);
          this.sqlite.prepare('UPDATE sessions SET previous_worker=?,blocked_reason=NULL WHERE id=?').run(workerId,session.id);
          return { attemptId: id, turnId, session, input, generation, leaseDuration: config.runtime.leaseDuration, interruptGrace: config.runtime.interruptGrace, runConfig,steering:this.steering(turnId) };
        } catch (error) {
          if (!(error instanceof ContractError)) throw error;
          this.sqlite.prepare('UPDATE sessions SET blocked_reason=? WHERE id=?').run(error.code,session.id);
        }
      }
      return null;
    }).immediate();
  }
  private owned(id: string, worker: string, generation: number): Attempt {
    const a = this.sqlite.prepare('SELECT * FROM attempts WHERE id=?').get(id) as Attempt | undefined;
    if (!a || a.worker_id !== worker || a.generation !== generation) throw new ContractError('stale_attempt');
    return a;
  }
  renew(id: string, worker: string, generation: number) {
    const a = this.owned(id,worker,generation);
    if (a.status === 'terminal' || a.lease_until <= this.now()) throw new ContractError('lease_expired');
    const deadline = this.now() + a.lease_duration;
    this.sqlite.prepare('UPDATE attempts SET lease_until=? WHERE id=?').run(deadline,id);
    return { leaseDuration: a.lease_duration, interruptGrace: a.interrupt_grace };
  }
  release(id:string,worker:string,generation:number) {
    this.sqlite.transaction(()=>{
      const a=this.owned(id,worker,generation);if(a.status==='terminal')return;
      this.sqlite.prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?").run(this.now(),id);
      this.sqlite.prepare("UPDATE turns SET status='recovering' WHERE id=?").run(a.turn_id);
    }).immediate();
  }
  preflight(id:string,worker:string,generation:number,decision:Preflight):boolean {
    return this.sqlite.transaction(()=>{
      const a=this.owned(id,worker,generation);
      if(a.status==='terminal'||a.lease_until<=this.now())throw new ContractError('lease_expired');
      const input=this.sqlite.prepare('SELECT i.* FROM inputs i JOIN turns t ON t.input_id=i.id WHERE t.id=?').get(a.turn_id) as Input;
      if(decision.status==='ready'&&(decision.body===undefined||decision.body===input.body))return true;
      this.sqlite.prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?").run(this.now(),id);
      this.sqlite.prepare('UPDATE turns SET status=? WHERE id=?').run(decision.status==='cancel'?'cancelled':'recovering',a.turn_id);
      if(decision.status==='cancel')this.sqlite.prepare("UPDATE inputs SET status='consumed' WHERE id=?").run(input.id);
      if(decision.body!==undefined)this.sqlite.prepare('UPDATE inputs SET body=?,updated_at=? WHERE id=?').run(decision.body,this.now(),input.id);
      if(decision.status==='hold')this.sqlite.prepare('UPDATE sessions SET blocked_reason=? WHERE id=?').run(decision.reason??'input_verification_pending',a.session_id);
      if(decision.reason==='session_disabled')this.sqlite.prepare('UPDATE sessions SET active=0 WHERE id=?').run(a.session_id);
      return false;
    }).immediate();
  }
  restartSteer(id:string,worker:string,generation:number,controlId:string) {
    return this.sqlite.transaction(()=>{
      const previous=this.owned(id,worker,generation);
      const mapped=this.sqlite.prepare('SELECT attempt_id FROM steer_restarts WHERE control_id=?').get(controlId) as {attempt_id:string}|undefined;
      let a:Attempt;
      if(mapped) {
        a=this.sqlite.prepare('SELECT * FROM attempts WHERE id=?').get(mapped.attempt_id) as Attempt;
        if(a.worker_id!==worker||a.turn_id!==previous.turn_id)throw new ContractError('invalid_control_target');
      } else {
        if(previous.status==='terminal'||previous.lease_until<=this.now())throw new ContractError('lease_expired');
        const control=this.sqlite.prepare("SELECT 1 FROM controls WHERE id=? AND attempt_id=? AND status='pending' AND json_extract(payload,'$.kind')='steer'").get(controlId,id);
        if(!control)throw new ContractError('invalid_control_target');
        this.sqlite.prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?").run(this.now(),id);
        const nextId=randomUUID(),now=this.now();
        this.sqlite.prepare("INSERT INTO attempts VALUES (?,?,?,?,?,'running',?,NULL,?,?,?,?,NULL)").run(nextId,previous.turn_id,previous.session_id,worker,generation+1,now,now+previous.lease_duration,previous.lease_duration,previous.interrupt_grace,previous.reassign_grace);
        this.sqlite.prepare('UPDATE turns SET generation=? WHERE id=?').run(generation+1,previous.turn_id);
        this.sqlite.prepare("UPDATE controls SET status='applied' WHERE id=?").run(controlId);
        this.sqlite.prepare('INSERT INTO steer_restarts VALUES (?,?)').run(controlId,nextId);
        a=this.sqlite.prepare('SELECT * FROM attempts WHERE id=?').get(nextId) as Attempt;
      }
      if(a.status==='terminal'||a.lease_until<=this.now())throw new ContractError('lease_expired');
      const turn=this.sqlite.prepare('SELECT * FROM turns WHERE id=?').get(a.turn_id) as Turn;
      const input=this.sqlite.prepare('SELECT * FROM inputs WHERE id=?').get(turn.input_id) as Input;
      return {attemptId:a.id,turnId:a.turn_id,session:this.getSession(a.session_id)!,input,generation:a.generation,leaseDuration:Math.min(a.lease_duration,a.lease_until-this.now()),interruptGrace:a.interrupt_grace,runConfig:JSON.parse(turn.run_config!) as RunConfig,steering:this.steering(a.turn_id)};
    }).immediate();
  }
  cancel(id: string, worker: string, generation: number) {
    this.sqlite.transaction(() => {
      const a = this.owned(id,worker,generation);
      if (a.status === 'terminal') return;
      this.sqlite.prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?").run(this.now(),id);
      this.sqlite.prepare("UPDATE turns SET status='cancelled' WHERE id=?").run(a.turn_id);
      this.sqlite.prepare("UPDATE inputs SET status='consumed' WHERE id=(SELECT input_id FROM turns WHERE id=?)").run(a.turn_id);
    }).immediate();
  }
  complete(id: string, worker: string, generation: number, result: Result): string[] {
    return this.sqlite.transaction(() => {
      const a = this.owned(id,worker,generation); const resultHash = hash(result);
      if (a.result_hash) {
        if (a.result_hash !== resultHash) throw new ContractError('result_conflict');
        return (this.sqlite.prepare('SELECT id FROM deliveries WHERE turn_id=? ORDER BY rowid').all(a.turn_id) as { id: string }[]).map(d => d.id);
      }
      if (a.status === 'terminal' || a.lease_until <= this.now()) throw new ContractError('lease_expired');
      const turn = this.sqlite.prepare('SELECT run_config FROM turns WHERE id=?').get(a.turn_id) as { run_config: string };
      const run = JSON.parse(turn.run_config) as RunConfig;
      const deliveries = splitOutput(result.text,result.origin==='runtime'?run.payload.output.automationAttribution:run.payload.output.attribution,randomUUID());
      this.sqlite.prepare("UPDATE attempts SET status='terminal',ended_at=?,result_hash=? WHERE id=?").run(this.now(),resultHash,id);
      this.sqlite.prepare('UPDATE turns SET status=?,result=? WHERE id=?').run(result.kind,JSON.stringify(result),a.turn_id);
      this.sqlite.prepare("UPDATE inputs SET status='consumed' WHERE id=(SELECT input_id FROM turns WHERE id=?)").run(a.turn_id);
      for (const d of deliveries) this.sqlite.prepare("INSERT INTO deliveries(id,session_id,turn_id,body,body_hash,expected_author,status,worker_id,claim_until,github_id) VALUES (?,?,?,?,?,NULL,'pending',NULL,NULL,NULL)").run(d.id,a.session_id,a.turn_id,d.body,d.bodyHash);
      return deliveries.map(d => d.id);
    }).immediate();
  }
  expire() {
    const expired = this.sqlite.prepare("SELECT * FROM attempts WHERE status IN ('running','stopping') AND lease_until+reassign_grace<=?").all(this.now()) as Attempt[];
    for (const a of expired) {
      const stopped = this.sqlite.prepare("SELECT 1 FROM controls WHERE attempt_id=? AND json_extract(payload,'$.kind')='stop'").get(a.id);
      this.sqlite.prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?").run(this.now(),a.id);
      this.sqlite.prepare('UPDATE turns SET status=? WHERE id=?').run(stopped ? 'cancelled' : 'recovering',a.turn_id);
    }
  }
  claimDelivery(worker: string, ttl: number) {
    return this.sqlite.transaction(() => {
      const c = this.sqlite.prepare('SELECT capabilities FROM workers WHERE id=?').get(worker) as { capabilities: string } | undefined;
      if (!c) throw new ContractError('unknown_worker',403);
      const capabilities = JSON.parse(c.capabilities) as WorkerCapabilities;
      const pending = this.sqlite.prepare("SELECT * FROM deliveries WHERE status!='posted' AND (claim_until IS NULL OR claim_until<=?) ORDER BY rowid").all(this.now()) as Delivery[];
      const d = pending.find(d => capabilities.repositories.some(r => r.toLowerCase() === this.getSession(d.session_id)!.repository.toLowerCase()));
      if (!d) return null;
      // expected_author is intentionally retained after an uncertain earlier post.
      const authors = [...new Set([...(this.sqlite.prepare('SELECT author_id FROM delivery_authors WHERE delivery_id=?').all(d.id) as {author_id:string}[]).map(r => r.author_id),capabilities.githubId])];
      this.sqlite.prepare("UPDATE deliveries SET status='claimed',worker_id=?,claim_until=?,lease_duration=? WHERE id=?").run(worker,this.now()+ttl,ttl,d.id);
      return { ...d, session: this.getSession(d.session_id)!, authors, leaseDuration: ttl };
    }).immediate();
  }
  renewDelivery(worker:string,id:string) {
    return this.sqlite.transaction(()=>{
      const d=this.sqlite.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as Delivery|undefined;
      if(!d||d.worker_id!==worker||!d.claim_until||d.claim_until<=this.now()||!d.lease_duration||d.status==='posted')throw new ContractError('delivery_lease_expired');
      this.sqlite.prepare('UPDATE deliveries SET claim_until=? WHERE id=?').run(this.now()+d.lease_duration,id);
      return {leaseDuration:d.lease_duration};
    }).immediate();
  }
  beginPost(worker: string, id: string): Delivery {
    const d = this.sqlite.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as Delivery | undefined;
    if (!d || d.worker_id !== worker || !d.claim_until || d.claim_until <= this.now() || d.status === 'posted') throw new ContractError('delivery_lease_expired');
    const w = this.sqlite.prepare('SELECT capabilities FROM workers WHERE id=?').get(worker) as { capabilities: string };
    const author = (JSON.parse(w.capabilities) as WorkerCapabilities).githubId;
    this.sqlite.transaction(() => {
      this.sqlite.prepare('INSERT OR IGNORE INTO delivery_authors VALUES (?,?)').run(id,author);
      this.sqlite.prepare("UPDATE deliveries SET expected_author=?,status='unknown' WHERE id=?").run(author,id);
    }).immediate();
    return d;
  }
  deliveryReceipt(worker: string, id: string, githubId: string) {
    const d = this.sqlite.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as Delivery | undefined;
    if(!d||d.worker_id!==worker)throw new ContractError('delivery_lease_expired');
    if(d.status==='posted'){if(d.github_id!==githubId)throw new ContractError('receipt_conflict');return;}
    if(!d.claim_until||d.claim_until<=this.now())throw new ContractError('delivery_lease_expired');
    this.sqlite.transaction(() => {
      this.sqlite.prepare("UPDATE deliveries SET status='posted',github_id=? WHERE id=?").run(githubId,id);
      this.sqlite.prepare('INSERT OR IGNORE INTO automatic_sources VALUES (?,?)').run(d.session_id,githubId);
    }).immediate();
  }
  isAutomatic(session: string, githubId: string, authorId: string, body: string): boolean {
    if (this.sqlite.prepare('SELECT 1 FROM automatic_sources WHERE session_id=? AND github_id=?').get(session,githubId)) return true;
    const marker = /<!-- forgecrew:delivery=([a-zA-Z0-9_-]+) -->\s*$/.exec(body)?.[1];
    if (!marker) return false;
    const d = this.sqlite.prepare('SELECT * FROM deliveries WHERE id=? AND session_id=?').get(marker,session) as Delivery | undefined;
    if (!d || !this.sqlite.prepare('SELECT 1 FROM delivery_authors WHERE delivery_id=? AND author_id=?').get(d.id,authorId) || d.body_hash !== hash(body)) return false;
    this.sqlite.prepare('INSERT OR IGNORE INTO automatic_sources VALUES (?,?)').run(session,githubId);
    return true;
  }
  cursor(scope: string): number { return (this.sqlite.prepare('SELECT completed_at FROM cursors WHERE scope=?').get(scope) as { completed_at: number } | undefined)?.completed_at ?? 0; }
  advanceCursor(scope: string, at: number) { this.sqlite.prepare('INSERT INTO cursors VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET completed_at=MAX(completed_at,excluded.completed_at)').run(scope,at); }
  issueToken(): string { return randomBytes(32).toString('base64url'); }
}
