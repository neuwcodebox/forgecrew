import { join } from 'node:path';
import type { LocalConfig } from '../local.ts';
import { createWorker } from '../application.ts';
import { acquireLock } from '../lock.ts';
import { UpdateManager } from '../launcher/update.ts';

export async function runWorker(config: LocalConfig, directory: string) {
  const runtimeDirectory = join(directory, 'workers', config.id);
  const release = await acquireLock(join(runtimeDirectory, 'worker.lock'));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const runtime = createWorker(config, runtimeDirectory),
    updater = new UpdateManager(directory);
  runtime.setUpdateHandler((p, signal) =>
    updater.check(p, (timeout) => runtime.drain(timeout, signal), signal),
  );
  const message = (m: unknown) => {
    const v = m as { type?: string; protocolVersion?: number; id?: string };
    if (v?.protocolVersion !== 1) return;
    if (v.type === 'STOP') stop();
    if (v.type === 'HEALTH' && process.connected)
      process.send?.({ type: 'HEALTH', protocolVersion: 1 });
    if (v.type === 'ACTIVATE') runtime.activate();
    if (v.type === 'STAGE_ACCEPTED' && v.id) updater.acknowledge(v.id);
  };
  process.on('message', message);
  process.once('disconnect', stop);
  try {
    await runtime.run(controller.signal, process.env.FORGECREW_REGISTRATION_TOKEN);
  } finally {
    process.removeListener('message', message);
    process.removeListener('disconnect', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await release();
  }
  return;
}
