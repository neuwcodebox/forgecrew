import { DatabaseConnection } from './database.ts';
import { ConfigSnapshots } from './configurations.ts';
import { WorkerRegistry } from './workers.ts';
import { SessionRepository } from './sessions.ts';
import { ExecutionRepository } from './executions.ts';
import { DeliveryRepository } from './deliveries.ts';
import { Diagnostics } from './diagnostics.ts';
import { Checkpoints } from './checkpoints.ts';
export type { ActivationWindow, Preflight } from './types.ts';

export class Store {
  readonly sqlite: DatabaseConnection['sqlite'];
  readonly configs: ConfigSnapshots;
  readonly workers: WorkerRegistry;
  readonly sessions: SessionRepository;
  readonly executions: ExecutionRepository;
  readonly deliveries: DeliveryRepository;
  readonly diagnostics: Diagnostics;
  readonly checkpoints: Checkpoints;
  private readonly connection: DatabaseConnection;

  constructor(path = ':memory:', now: () => number = Date.now) {
    this.connection = new DatabaseConnection(path, now);
    this.sqlite = this.connection.sqlite;
    this.configs = new ConfigSnapshots(this.connection);
    this.workers = new WorkerRegistry(this.connection);
    this.sessions = new SessionRepository(this.connection);
    this.deliveries = new DeliveryRepository(this.connection, this.workers, this.sessions);
    this.executions = new ExecutionRepository(
      this.connection,
      this.workers,
      this.sessions,
      this.deliveries,
    );
    this.diagnostics = new Diagnostics(this.connection, this.workers);
    this.checkpoints = new Checkpoints(this.connection);
  }

  close() {
    this.connection.close();
  }
}
