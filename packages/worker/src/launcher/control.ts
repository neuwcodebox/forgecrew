import { open, readFile, stat, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite } from '../local.ts';

export async function launcherStatus(directory: string) {
  const lock = await readFile(join(directory, 'launcher.lock'), 'utf8')
    .then((s) => JSON.parse(s) as { pid: number })
    .catch(() => undefined);
  let running = false;
  if (lock && Number.isSafeInteger(lock.pid) && lock.pid > 0)
    try {
      process.kill(lock.pid, 0);
      running = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  const state = await readFile(join(directory, 'status.json'), 'utf8')
    .then((s) => JSON.parse(s) as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>);
  const pointer = await readFile(join(directory, 'current.json'), 'utf8')
    .then((s) => JSON.parse(s) as Record<string, unknown>)
    .catch(() =>
      readFile(join(directory, 'current.previous.json'), 'utf8')
        .then((s) => JSON.parse(s) as Record<string, unknown>)
        .catch(() => ({}) as Record<string, unknown>),
    );
  return {
    ...state,
    pid: lock?.pid,
    event: state.event,
    running,
    active: pointer.active,
    pending: pointer.pending,
    lastKnownGood: pointer.lastKnownGood,
    failedVersions: pointer.failed,
  };
}
export async function startLauncher(directory: string) {
  if ((await launcherStatus(directory)).running) return;
  await atomicWrite(join(directory, 'intent.json'), { desired: true });
  await mkdir(join(directory, 'logs'), { recursive: true });
  const path = join(directory, 'logs', 'launcher.log');
  if ((await stat(path).catch(() => ({ size: 0 }))).size > 8 * 1024 * 1024)
    await rename(path, path + '.previous');
  const log = await open(path, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [join(directory, 'launcher.mjs'), directory], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
      env: process.env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await launcherStatus(directory)).running) return;
    await delay(50);
  }
  throw new Error('launcher_start_timeout');
}
export async function stopLauncher(directory: string) {
  await atomicWrite(join(directory, 'intent.json'), { desired: false });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (!(await launcherStatus(directory)).running) return;
    await delay(100);
  }
  throw new Error('launcher_stop_timeout');
}
