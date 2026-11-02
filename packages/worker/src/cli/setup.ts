import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { LocalConfigSchema, atomicWrite } from '../local.ts';
import { createWorker } from '../application.ts';
import { prepareLauncher } from '../launcher/install.ts';
import { launcherStatus } from '../launcher/control.ts';
import { setAutostart } from '../launcher/autostart.ts';
import type { Invocation } from './options.ts';
import type { LocalConfig } from '../local.ts';

export async function setupWorker({
  directory,
  configPath,
  packageDirectory,
  args,
  value,
}: Invocation) {
  if ((await launcherStatus(directory)).running) throw new Error('stop_launcher_before_setup');
  const existing = await readFile(configPath, 'utf8').then(
    (s) => LocalConfigSchema.parse(JSON.parse(s)),
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    },
  );
  const config = setupConfiguration(value, existing);
  await atomicWrite(configPath, config);
  await prepareLauncher(directory, packageDirectory, configPath);
  const runtime = createWorker(config, join(directory, 'workers', config.id));
  await runtime.initialize(process.env.FORGECREW_REGISTRATION_TOKEN);
  if (args.includes('--autostart')) await setAutostart(directory, true);
  console.log('Worker setup complete. Run forgecrew start.');
  return;
}

export function setupConfiguration(
  value: Invocation['value'],
  existing?: LocalConfig,
): LocalConfig {
  const engine = value('engine');
  if (engine !== undefined && !['codex', 'claude', 'both'].includes(engine))
    throw new Error('invalid_engine');
  if (!existing && !engine) throw new Error('engine_required');
  const identity = existing ?? {
    schemaVersion: 1,
    id: randomUUID(),
    token: randomBytes(32).toString('base64url'),
  };
  return LocalConfigSchema.parse({
    ...identity,
    dispatcher: value('dispatcher') ?? existing?.dispatcher,
    hostname: value('hostname') ?? existing?.hostname,
    maxConcurrentSessions:
      value('sessions') !== undefined
        ? Number(value('sessions'))
        : (existing?.maxConcurrentSessions ?? 2),
    engines: engine
      ? {
          ...(engine === 'codex' || engine === 'both'
            ? { codex: value('codex') ?? existing?.engines.codex ?? 'codex' }
            : {}),
          ...(engine === 'claude' || engine === 'both'
            ? { claude: value('claude') ?? existing?.engines.claude ?? 'claude' }
            : {}),
        }
      : existing?.engines,
  });
}
