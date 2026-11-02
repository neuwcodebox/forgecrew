import type { StorageContext } from './database.ts';
import { randomUUID } from 'node:crypto';
import { workerProjection } from '../../../shared/src/config/index.ts';
import type { Config } from '../../../shared/src/config/index.ts';
import { hash } from '../../../shared/src/hash.ts';
import { ContractError } from '../../../shared/src/types.ts';
import type { Control, Result } from '../../../shared/src/types.ts';
import { resolveLabels, selectWorker } from '../../../shared/src/models.ts';
import type { RunConfig } from '../../../shared/src/protocol.ts';
import type { Session, Input, Turn, Attempt, Preflight } from './types.ts';
import type { WorkerRegistry } from './workers.ts';
import type { SessionRepository } from './sessions.ts';
import type { DeliveryRepository } from './deliveries.ts';

export class ExecutionRepository {
  private readonly database: StorageContext;
  private readonly workers: Pick<WorkerRegistry, 'candidates'>;
  private readonly sessions: Pick<SessionRepository, 'get'>;
  private readonly deliveries: Pick<DeliveryRepository, 'create' | 'idsForTurn'>;
  constructor(
    database: StorageContext,
    workers: Pick<WorkerRegistry, 'candidates'>,
    sessions: Pick<SessionRepository, 'get'>,
    deliveries: Pick<DeliveryRepository, 'create' | 'idsForTurn'>,
  ) {
    this.database = database;
    this.workers = workers;
    this.sessions = sessions;
    this.deliveries = deliveries;
  }

  addControl(session: string, source: string, control: Control, createdAt: number) {
    const attempt = this.database.sqlite
      .prepare(
        'SELECT * FROM attempts WHERE session_id=? AND started_at<=? AND (ended_at IS NULL OR ended_at>=?) ORDER BY started_at DESC LIMIT 1',
      )
      .get(session, createdAt, createdAt) as Attempt | undefined;
    this.database.sqlite
      .prepare('INSERT OR IGNORE INTO controls VALUES (?,?,?,?,?)')
      .run(
        hash([session, source]),
        session,
        attempt?.id ?? null,
        JSON.stringify(control),
        attempt && attempt.status !== 'terminal' ? 'pending' : 'not_applied',
      );
  }

  pendingControls(worker: string) {
    return this.database.sqlite
      .prepare(
        "SELECT c.id,c.attempt_id,c.payload FROM controls c JOIN attempts a ON a.id=c.attempt_id WHERE a.worker_id=? AND a.status IN ('running','stopping') AND c.status='pending'",
      )
      .all(worker)
      .map((row) => {
        const r = row as { id: string; attempt_id: string; payload: string };
        return { id: r.id, attemptId: r.attempt_id, control: JSON.parse(r.payload) as Control };
      });
  }

  ackControl(worker: string, id: string) {
    this.database.sqlite
      .prepare(
        "UPDATE controls SET status='applied' WHERE id=? AND attempt_id IN (SELECT id FROM attempts WHERE worker_id=?)",
      )
      .run(id, worker);
  }

  private steering(turnId: string): { id: string; text: string }[] {
    return this.database.sqlite
      .prepare(
        "SELECT c.id,json_extract(c.payload,'$.text') AS text FROM controls c JOIN attempts a ON a.id=c.attempt_id WHERE a.turn_id=? AND c.status='applied' AND json_extract(c.payload,'$.kind')='steer' ORDER BY c.rowid",
      )
      .all(turnId) as { id: string; text: string }[];
  }

  claim(workerId: string, config: Config) {
    return this.database.sqlite
      .transaction(() => {
        this.expire();
        const sessions = this.database.sqlite
          .prepare(
            `SELECT s.* FROM sessions s WHERE active=1 AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.session_id=s.id AND a.status IN ('running','stopping')) AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.session_id=s.id AND d.status!='posted') ORDER BY activation_at,id`,
          )
          .all() as Session[];
        for (const session of sessions) {
          if (
            !config.github.repositories.some(
              (r) => r.name.toLowerCase() === session.repository.toLowerCase(),
            )
          )
            continue;
          const recovering = this.database.sqlite
            .prepare(
              "SELECT * FROM turns WHERE session_id=? AND status='recovering' ORDER BY rowid LIMIT 1",
            )
            .get(session.id) as Turn | undefined;
          const input = recovering
            ? (this.database.sqlite
                .prepare('SELECT * FROM inputs WHERE id=?')
                .get(recovering.input_id) as Input)
            : (this.database.sqlite
                .prepare(
                  "SELECT * FROM inputs WHERE session_id=? AND status='queued' ORDER BY created_at,source_id LIMIT 1",
                )
                .get(session.id) as Input | undefined);
          if (!input) continue;
          try {
            const prior = recovering?.run_config
              ? (JSON.parse(recovering.run_config) as RunConfig)
              : undefined;
            const requested = prior
              ? {
                  family: prior.family,
                  effort: prior.effort,
                }
              : resolveLabels(JSON.parse(session.labels), config, session.repository);
            const selected = selectWorker(
              this.workers.candidates().map((c) =>
                prior
                  ? {
                      ...c,
                      worker: {
                        ...c.worker,
                        models: c.worker.models.filter((m) => m.id === prior.model),
                      },
                    }
                  : c,
              ),
              session.repository,
              requested.family,
              requested.effort,
              this.database.now(),
              config,
              session.previous_worker ?? undefined,
            );
            if (selected.worker.id !== workerId) continue;
            const turnId = recovering?.id ?? randomUUID();
            const runBase = {
              ...workerProjection(config),
              sessionConfigRevision: hash(JSON.parse(session.labels)),
              model: selected.model.id,
              engine: selected.model.engine,
              effort: selected.effort,
              family: requested.family,
            };
            const runConfig: RunConfig = prior ?? { ...runBase, runConfigRevision: hash(runBase) };
            const generation = (recovering?.generation ?? 0) + 1;
            this.database.sqlite
              .prepare(
                `INSERT INTO turns(id,input_id,session_id,status,run_config,generation) VALUES (?,?,?,'running',?,?) ON CONFLICT(id) DO UPDATE SET status='running',generation=excluded.generation`,
              )
              .run(turnId, input.id, session.id, JSON.stringify(runConfig), generation);
            this.database.sqlite
              .prepare("UPDATE inputs SET status='dispatched' WHERE id=?")
              .run(input.id);
            const id = randomUUID();
            const now = this.database.now();
            this.database.sqlite
              .prepare("INSERT INTO attempts VALUES (?,?,?,?,?,'running',?,NULL,?,?,?,?,NULL)")
              .run(
                id,
                turnId,
                session.id,
                workerId,
                generation,
                now,
                now + config.runtime.leaseDuration,
                config.runtime.leaseDuration,
                config.runtime.interruptGrace,
                config.runtime.reassignGrace,
              );
            this.database.sqlite
              .prepare('UPDATE sessions SET previous_worker=?,blocked_reason=NULL WHERE id=?')
              .run(workerId, session.id);
            return {
              attemptId: id,
              turnId,
              session,
              input,
              generation,
              leaseDuration: config.runtime.leaseDuration,
              interruptGrace: config.runtime.interruptGrace,
              runConfig,
              steering: this.steering(turnId),
            };
          } catch (error) {
            if (!(error instanceof ContractError)) throw error;
            this.database.sqlite
              .prepare('UPDATE sessions SET blocked_reason=? WHERE id=?')
              .run(error.code, session.id);
          }
        }
        return null;
      })
      .immediate();
  }

  private owned(id: string, worker: string, generation: number): Attempt {
    const a = this.database.sqlite.prepare('SELECT * FROM attempts WHERE id=?').get(id) as
      Attempt | undefined;
    if (!a || a.worker_id !== worker || a.generation !== generation)
      throw new ContractError('stale_attempt');
    return a;
  }

  renew(id: string, worker: string, generation: number) {
    const a = this.owned(id, worker, generation);
    if (a.status === 'terminal' || a.lease_until <= this.database.now())
      throw new ContractError('lease_expired');
    const deadline = this.database.now() + a.lease_duration;
    this.database.sqlite.prepare('UPDATE attempts SET lease_until=? WHERE id=?').run(deadline, id);
    return { leaseDuration: a.lease_duration, interruptGrace: a.interrupt_grace };
  }

  release(id: string, worker: string, generation: number) {
    this.database.sqlite
      .transaction(() => {
        const a = this.owned(id, worker, generation);
        if (a.status === 'terminal') return;
        this.database.sqlite
          .prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?")
          .run(this.database.now(), id);
        this.database.sqlite
          .prepare("UPDATE turns SET status='recovering' WHERE id=?")
          .run(a.turn_id);
      })
      .immediate();
  }

  preflight(id: string, worker: string, generation: number, decision: Preflight): boolean {
    return this.database.sqlite
      .transaction(() => {
        const a = this.owned(id, worker, generation);
        if (a.status === 'terminal' || a.lease_until <= this.database.now())
          throw new ContractError('lease_expired');
        const input = this.database.sqlite
          .prepare('SELECT i.* FROM inputs i JOIN turns t ON t.input_id=i.id WHERE t.id=?')
          .get(a.turn_id) as Input;
        if (
          decision.status === 'ready' &&
          (decision.body === undefined || decision.body === input.body)
        )
          return true;
        this.database.sqlite
          .prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?")
          .run(this.database.now(), id);
        this.database.sqlite
          .prepare('UPDATE turns SET status=? WHERE id=?')
          .run(decision.status === 'cancel' ? 'cancelled' : 'recovering', a.turn_id);
        if (decision.status === 'cancel')
          this.database.sqlite
            .prepare("UPDATE inputs SET status='consumed' WHERE id=?")
            .run(input.id);
        if (decision.body !== undefined)
          this.database.sqlite
            .prepare('UPDATE inputs SET body=?,updated_at=? WHERE id=?')
            .run(decision.body, this.database.now(), input.id);
        if (decision.status === 'hold')
          this.database.sqlite
            .prepare('UPDATE sessions SET blocked_reason=? WHERE id=?')
            .run(decision.reason ?? 'input_verification_pending', a.session_id);
        if (decision.reason === 'session_disabled')
          this.database.sqlite.prepare('UPDATE sessions SET active=0 WHERE id=?').run(a.session_id);
        return false;
      })
      .immediate();
  }

  restartSteer(id: string, worker: string, generation: number, controlId: string) {
    return this.database.sqlite
      .transaction(() => {
        const previous = this.owned(id, worker, generation);
        const mapped = this.database.sqlite
          .prepare('SELECT attempt_id FROM steer_restarts WHERE control_id=?')
          .get(controlId) as { attempt_id: string } | undefined;
        let a: Attempt;
        if (mapped) {
          a = this.database.sqlite
            .prepare('SELECT * FROM attempts WHERE id=?')
            .get(mapped.attempt_id) as Attempt;
          if (a.worker_id !== worker || a.turn_id !== previous.turn_id)
            throw new ContractError('invalid_control_target');
        } else {
          if (previous.status === 'terminal' || previous.lease_until <= this.database.now())
            throw new ContractError('lease_expired');
          const control = this.database.sqlite
            .prepare(
              "SELECT 1 FROM controls WHERE id=? AND attempt_id=? AND status='pending' AND json_extract(payload,'$.kind')='steer'",
            )
            .get(controlId, id);
          if (!control) throw new ContractError('invalid_control_target');
          this.database.sqlite
            .prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?")
            .run(this.database.now(), id);
          const nextId = randomUUID(),
            now = this.database.now();
          this.database.sqlite
            .prepare("INSERT INTO attempts VALUES (?,?,?,?,?,'running',?,NULL,?,?,?,?,NULL)")
            .run(
              nextId,
              previous.turn_id,
              previous.session_id,
              worker,
              generation + 1,
              now,
              now + previous.lease_duration,
              previous.lease_duration,
              previous.interrupt_grace,
              previous.reassign_grace,
            );
          this.database.sqlite
            .prepare('UPDATE turns SET generation=? WHERE id=?')
            .run(generation + 1, previous.turn_id);
          this.database.sqlite
            .prepare("UPDATE controls SET status='applied' WHERE id=?")
            .run(controlId);
          this.database.sqlite
            .prepare('INSERT INTO steer_restarts VALUES (?,?)')
            .run(controlId, nextId);
          a = this.database.sqlite
            .prepare('SELECT * FROM attempts WHERE id=?')
            .get(nextId) as Attempt;
        }
        if (a.status === 'terminal' || a.lease_until <= this.database.now())
          throw new ContractError('lease_expired');
        const turn = this.database.sqlite
          .prepare('SELECT * FROM turns WHERE id=?')
          .get(a.turn_id) as Turn;
        const input = this.database.sqlite
          .prepare('SELECT * FROM inputs WHERE id=?')
          .get(turn.input_id) as Input;
        return {
          attemptId: a.id,
          turnId: a.turn_id,
          session: this.sessions.get(a.session_id)!,
          input,
          generation: a.generation,
          leaseDuration: Math.min(a.lease_duration, a.lease_until - this.database.now()),
          interruptGrace: a.interrupt_grace,
          runConfig: JSON.parse(turn.run_config!) as RunConfig,
          steering: this.steering(a.turn_id),
        };
      })
      .immediate();
  }

  cancel(id: string, worker: string, generation: number) {
    this.database.sqlite
      .transaction(() => {
        const a = this.owned(id, worker, generation);
        if (a.status === 'terminal') return;
        this.database.sqlite
          .prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?")
          .run(this.database.now(), id);
        this.database.sqlite
          .prepare("UPDATE turns SET status='cancelled' WHERE id=?")
          .run(a.turn_id);
        this.database.sqlite
          .prepare(
            "UPDATE inputs SET status='consumed' WHERE id=(SELECT input_id FROM turns WHERE id=?)",
          )
          .run(a.turn_id);
      })
      .immediate();
  }

  complete(id: string, worker: string, generation: number, result: Result): string[] {
    return this.database.sqlite
      .transaction(() => {
        const attempt = this.owned(id, worker, generation);
        const resultHash = hash(result);
        if (attempt.result_hash) {
          if (attempt.result_hash !== resultHash) throw new ContractError('result_conflict');
          return this.deliveries.idsForTurn(attempt.turn_id);
        }
        if (attempt.status === 'terminal' || attempt.lease_until <= this.database.now())
          throw new ContractError('lease_expired');
        const turn = this.database.sqlite
          .prepare('SELECT run_config FROM turns WHERE id=?')
          .get(attempt.turn_id) as { run_config: string };
        const run = JSON.parse(turn.run_config) as RunConfig;
        this.database.sqlite
          .prepare("UPDATE attempts SET status='terminal',ended_at=?,result_hash=? WHERE id=?")
          .run(this.database.now(), resultHash, id);
        this.database.sqlite
          .prepare('UPDATE turns SET status=?,result=? WHERE id=?')
          .run(result.kind, JSON.stringify(result), attempt.turn_id);
        this.database.sqlite
          .prepare(
            "UPDATE inputs SET status='consumed' WHERE id=(SELECT input_id FROM turns WHERE id=?)",
          )
          .run(attempt.turn_id);
        return this.deliveries.create(attempt, result, run.payload.output);
      })
      .immediate();
  }

  expire() {
    const expired = this.database.sqlite
      .prepare(
        "SELECT * FROM attempts WHERE status IN ('running','stopping') AND lease_until+reassign_grace<=?",
      )
      .all(this.database.now()) as Attempt[];
    for (const a of expired) {
      const stopped = this.database.sqlite
        .prepare(
          "SELECT 1 FROM controls WHERE attempt_id=? AND json_extract(payload,'$.kind')='stop'",
        )
        .get(a.id);
      this.database.sqlite
        .prepare("UPDATE attempts SET status='terminal',ended_at=? WHERE id=?")
        .run(this.database.now(), a.id);
      this.database.sqlite
        .prepare('UPDATE turns SET status=? WHERE id=?')
        .run(stopped ? 'cancelled' : 'recovering', a.turn_id);
    }
  }
}
