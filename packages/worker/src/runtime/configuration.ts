import type { Projection } from '../../../shared/src/config/index.ts';
import { validateProjection } from '../../../shared/src/config/index.ts';
import type { Dispatcher } from '../dispatcher/protocol.ts';
import { cacheProjection, readLatestProjection } from '../local.ts';

export class ConfigurationSync {
  private readonly directory: string;
  private readonly hostname: string;
  private readonly dispatcher: Pick<Dispatcher, 'configuration' | 'requestTimeout'>;
  private projection: Projection | undefined;
  private sequence = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    directory: string,
    hostname: string,
    dispatcher: Pick<Dispatcher, 'configuration' | 'requestTimeout'>,
  ) {
    this.directory = directory;
    this.hostname = hostname;
    this.dispatcher = dispatcher;
  }
  get current() {
    return this.projection;
  }
  async loadCache() {
    const projection = await readLatestProjection(this.directory).catch(() => undefined);
    this.projection =
      projection?.payload.github.hostname === this.hostname ? projection : undefined;
    if (this.projection)
      this.dispatcher.requestTimeout = this.projection.payload.runtime.requestTimeout;
  }
  async sync(revision: string) {
    const sequence = ++this.sequence;
    const projection =
      this.projection?.configRevision === revision
        ? this.projection
        : await this.dispatcher.configuration(revision);
    validateProjection(projection);
    if (
      projection.configRevision !== revision ||
      projection.payload.github.hostname !== this.hostname
    )
      throw new Error('worker_config_host_mismatch');
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        if (sequence !== this.sequence) return;
        if (this.projection?.configRevision !== revision)
          await cacheProjection(this.directory, projection);
        this.projection = projection;
        this.dispatcher.requestTimeout = projection.payload.runtime.requestTimeout;
      });
    this.writes = write;
    await write;
  }
}
