import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalConfigSchema } from '../local.ts';
import { DispatcherClient } from '../dispatcher/client.ts';
import { launcherStatus } from '../launcher/control.ts';
import type { Invocation } from './options.ts';

export async function showStatus({ directory, configPath, value }: Invocation) {
  const launch = await readFile(join(directory, 'launch.json'), 'utf8')
    .then((s) => JSON.parse(s) as { configPath: string })
    .catch(() => undefined);
  const local = await readFile(value('config') ?? launch?.configPath ?? configPath, 'utf8')
    .then((s) => LocalConfigSchema.parse(JSON.parse(s)))
    .catch(() => undefined);
  let dispatcher: unknown = { available: false, reason: 'local_configuration_unavailable' };
  if (local)
    try {
      dispatcher = await new DispatcherClient(local).status();
    } catch {
      dispatcher = { available: false, reason: 'dispatcher_status_unavailable' };
    }
  console.log(JSON.stringify({ launcher: await launcherStatus(directory), dispatcher }, null, 2));
  return;
}
