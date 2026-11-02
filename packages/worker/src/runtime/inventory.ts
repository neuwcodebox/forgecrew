import type { Projection } from '../../../shared/src/config/index.ts';
import type { Engine, Model, WorkerCapabilities } from '../../../shared/src/types.ts';
import type { GitHubAccess } from '../github/contracts.ts';
import type { Provider } from '../providers/types.ts';
import { errorCode, providerAvailability } from './errors.ts';
import type { RuntimeLog } from './errors.ts';

type InventoryOptions = {
  id: string;
  version: string;
  maxConcurrentSessions: number;
  github: GitHubAccess;
  providers: Partial<Record<Engine, Provider>>;
  log: RuntimeLog;
};
export class WorkerInventory {
  private readonly options: InventoryOptions;
  private capabilities: WorkerCapabilities | undefined;
  private revision = 0;
  lastRefresh = 0;
  constructor(options: InventoryOptions) {
    this.options = options;
  }
  get current() {
    if (!this.capabilities) throw new Error('worker_not_initialized');
    return this.capabilities;
  }
  async identify() {
    const { id, version, maxConcurrentSessions, github } = this.options;
    ++this.revision;
    const account = await github.account();
    this.capabilities = {
      id,
      githubLogin: account.login,
      githubId: String(account.id),
      version,
      schemaVersions: [1],
      maxConcurrentSessions,
      repositories: [],
      models: [],
      draining: false,
    };
  }
  snapshot(draining: boolean, revision?: string) {
    const capabilities = this.current;
    capabilities.draining = draining;
    if (revision) capabilities.configRevision = revision;
    return capabilities;
  }
  async refresh(projection: Projection) {
    if (!this.capabilities) return;
    const revision = ++this.revision;
    const current = this.capabilities;
    const { github, providers, log } = this.options,
      account = await github.account();
    const repositories = await github.repositories(projection.payload.github.repositories);
    const models: Model[] = [];
    for (const [engine, provider] of Object.entries(providers)) {
      try {
        models.push(...(await provider.probe()));
      } catch (error) {
        const reason = errorCode(error);
        models.push(
          ...current.models
            .filter((model) => model.engine === engine)
            .map((model) => ({ ...model, availability: providerAvailability(reason) })),
        );
        log('provider_blocked', engine + ':' + reason);
      }
    }
    if (revision !== this.revision || this.capabilities !== current) return;
    this.capabilities = {
      ...current,
      githubLogin: account.login,
      githubId: String(account.id),
      repositories,
      models,
    };
    this.lastRefresh = Date.now();
  }
  blockRepository(repository: string) {
    ++this.revision;
    if (this.capabilities)
      this.capabilities.repositories = this.capabilities.repositories.filter(
        (name) => name.toLowerCase() !== repository.toLowerCase(),
      );
  }
  blockProvider(engine: Engine, reason: string) {
    ++this.revision;
    if (this.capabilities)
      this.capabilities.models = this.capabilities.models.map((model) =>
        model.engine === engine ? { ...model, availability: providerAvailability(reason) } : model,
      );
    this.lastRefresh = Date.now();
  }
}
