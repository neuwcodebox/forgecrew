import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { ConfigManager, parseConfig } from '../../shared/src/config.ts';
import { Store } from './store.ts';
import { createApp } from './api.ts';
import { GitHubClient, Poller } from './github.ts';

const configPath = process.env.FORGECREW_CONFIG ?? 'config.yaml';
async function main() {
  const source = await readFile(configPath, 'utf8');
  const initial = parseConfig(source);
  const pat = process.env[initial.github.tokenEnv];
  const registration = process.env[initial.registration.tokenEnv];
  if (!pat || !registration || registration.length < 32)
    throw new Error('required Dispatcher secrets are missing or too short');
  await mkdir(initial.server.dataDir, { recursive: true });
  const store = new Store(join(initial.server.dataDir, 'forgecrew.sqlite'));
  const configs = new ConfigManager(source, (config) => store.saveConfig(config));
  const github = new GitHubClient(initial, pat);
  const poller = new Poller(store, github);
  let stopping = false;
  const server = serve({
    fetch: createApp(store, configs, registration, (claim) => github.preflight(claim)).fetch,
    hostname: initial.server.listen,
    port: initial.server.port,
  });
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref();
    });
  const reload = (async () => {
    while (!stopping) {
      await pause(configs.current.server.configReloadInterval);
      if (stopping) break;
      try {
        configs.reload(await readFile(configPath, 'utf8'));
      } catch {
        configs.lastError = 'configuration file unavailable';
      }
    }
  })();
  const polling = (async () => {
    while (!stopping) {
      const config = configs.current;
      const queue = [...config.github.repositories];
      await Promise.all(
        Array.from(
          { length: Math.min(queue.length, config.github.polling.maxConcurrentRequests) },
          async () => {
            let repository;
            while (!stopping && (repository = queue.shift())) {
              try {
                await poller.pollRepository(repository.name, config);
              } catch {
                console.error(
                  JSON.stringify({ event: 'github_poll_failed', repository: repository.name }),
                );
              }
            }
          },
        ),
      );
      await pause(config.github.polling.interval);
    }
  })();
  async function stop() {
    stopping = true;
    server.close();
    await Promise.all([reload, polling]);
    store.close();
  }
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  console.log(JSON.stringify({ event: 'dispatcher_ready', port: initial.server.port }));
}
main().catch(() => {
  console.error(
    'Dispatcher startup failed; check configuration, data directory and secret references.',
  );
  process.exitCode = 1;
});
