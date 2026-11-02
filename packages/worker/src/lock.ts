import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const create = async () => {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      await file.sync();
    } finally {
      await file.close();
    }
  };
  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0)
      throw new Error('worker_lock_requires_repair');
    try {
      process.kill(previous.pid, 0);
      throw new Error('worker_already_running');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await unlink(path);
    await create();
  }
  return async () => {
    const current = await readFile(path, 'utf8').then(
      (s) => JSON.parse(s) as { nonce: string },
      () => undefined,
    );
    if (current?.nonce === nonce) await unlink(path);
  };
}
