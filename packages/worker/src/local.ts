import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hash } from '../../shared/src/hash.ts';
import { validateProjection } from '../../shared/src/config.ts';
import type { Projection } from '../../shared/src/config.ts';

export const LocalConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  dispatcher: z.url(),
  hostname: z.string().min(1),
  token: z.string().min(32),
  maxConcurrentSessions: z.number().int().min(1).max(100),
  engines: z
    .strictObject({ codex: z.string().min(1).optional(), claude: z.string().min(1).optional() })
    .refine((e) => !!e.codex || !!e.claude),
});
export type LocalConfig = z.infer<typeof LocalConfigSchema>;
export async function atomicWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function cacheProjection(directory: string, projection: Projection) {
  validateProjection(projection);
  await atomicWrite(
    join(directory, 'cache', 'config', '1', projection.configRevision + '.json'),
    projection,
  );
  await atomicWrite(join(directory, 'cache', 'config', '1', 'current.json'), {
    revision: projection.configRevision,
  });
}
export async function readProjection(directory: string, revision: string): Promise<Projection> {
  if (!/^[0-9a-f]{64}$/.test(revision)) throw new Error('invalid_config_revision');
  const p = JSON.parse(
    await readFile(join(directory, 'cache', 'config', '1', revision + '.json'), 'utf8'),
  ) as Projection;
  validateProjection(p);
  if (p.configRevision !== revision) throw new Error('config_revision_mismatch');
  return p;
}
export async function readLatestProjection(directory: string): Promise<Projection | undefined> {
  const pointer = await readFile(
    join(directory, 'cache', 'config', '1', 'current.json'),
    'utf8',
  ).then(
    (s) => JSON.parse(s) as { revision: string },
    () => undefined,
  );
  return pointer ? readProjection(directory, pointer.revision) : undefined;
}
export type LeaseContract = { duration: number; interruptGrace: number };
export class LeaseClock {
  private wallDeadline = 0;
  private monoDeadline = 0;
  renew(sentWall: number, sentMono: number, contract: LeaseContract) {
    const margin = contract.duration - contract.interruptGrace;
    if (margin <= 0) throw new Error('invalid_lease_margin');
    this.wallDeadline = sentWall + margin;
    this.monoDeadline = sentMono + margin;
  }
  canRun(wall = Date.now(), mono = performance.now()) {
    return wall < this.wallDeadline && mono < this.monoDeadline;
  }
}
export async function writeResult(directory: string, attemptId: string, result: unknown) {
  if (!/^[a-zA-Z0-9_-]+$/.test(attemptId)) throw new Error('invalid_attempt_id');
  const record = { schemaVersion: 1, attemptId, result, resultHash: hash(result) };
  await atomicWrite(join(directory, 'journal', attemptId + '.json'), record);
  return record;
}
