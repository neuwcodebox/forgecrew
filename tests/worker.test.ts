import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command, spawnProcess } from '../packages/worker/src/process.ts';
import { RpcClient } from '../packages/worker/src/rpc.ts';
import {
  cacheProjection,
  LeaseClock,
  readProjection,
  writeResult,
} from '../packages/worker/src/local.ts';
import { workerProjection } from '../packages/shared/src/config.ts';
import { config } from './helpers.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function directory() {
  const d = await mkdtemp(join(tmpdir(), 'forgecrew-test-'));
  directories.push(d);
  return d;
}
describe('Worker local recovery primitives', () => {
  it('starts the lease clock at request send time and respects both clocks', () => {
    const l = new LeaseClock();
    l.renew(1000, 50, { duration: 90000, interruptGrace: 10000 });
    expect(l.canRun(81000, 100)).toBe(false);
    expect(l.canRun(1000, 80050)).toBe(false);
    expect(l.canRun(50000, 50000)).toBe(true);
  });
  it('preserves compatible config snapshots and rejects cache tampering', async () => {
    const d = await directory();
    const p = workerProjection(config());
    await cacheProjection(d, p);
    expect(await readProjection(d, p.configRevision)).toEqual(p);
    const path = join(d, 'cache', 'config', '1', p.configRevision + '.json');
    const changed = JSON.parse(await readFile(path, 'utf8'));
    changed.payload.agent.instructions = 'changed';
    await writeFile(path, JSON.stringify(changed));
    await expect(readProjection(d, p.configRevision)).rejects.toThrow('invalid config projection');
  });
  it('persists unacknowledged results independently of the installed program version', async () => {
    const d = await directory();
    const record = await writeResult(d, 'attempt_1', { text: 'done' });
    expect(JSON.parse(await readFile(join(d, 'journal', 'attempt_1.json'), 'utf8'))).toEqual(
      record,
    );
    await expect(writeResult(d, '../outside', {})).rejects.toThrow('invalid_attempt_id');
  });
});
describe('isolated runtime processes and JSON-RPC transport', () => {
  it('passes prompt text as data without evaluating shell substitutions', async () => {
    const input = '$(echo BAD) `echo BAD` "hello"';
    const r = await command(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input,
    });
    expect(r.stdout).toBe(input);
    expect(r.code).toBe(0);
  });
  it('terminates a stalled command on timeout', async () => {
    await expect(
      command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }),
    ).rejects.toThrow('command_timeout');
  });
  it('fails cleanly for a missing executable', async () => {
    await expect(command('forgecrew-test-missing-executable', [])).rejects.toThrow(
      'executable_unavailable',
    );
  });
  it('separates interleaved notifications and correlated responses', async () => {
    const child = spawnProcess(process.execPath, [
      '-e',
      `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',l=>{const m=JSON.parse(l);if(!m.id)return;console.log(JSON.stringify({method:'turn/started',params:{threadId:'one'}}));console.log(JSON.stringify({id:m.id,result:{echo:m.params}}))})`,
    ]);
    const rpc = new RpcClient(child);
    const events: string[] = [];
    rpc.on('notification', (m) => events.push(m.method));
    try {
      expect(await rpc.request('sample', { prompt: 'a' })).toEqual({ echo: { prompt: 'a' } });
      expect(events).toContain('turn/started');
    } finally {
      await rpc.close();
    }
  });
  it('rejects pending calls when the runtime exits', async () => {
    const rpc = new RpcClient(
      spawnProcess(process.execPath, ['-e', 'process.stdin.once("data",()=>process.exit(1))']),
    );
    try {
      await expect(rpc.request('sample')).rejects.toThrow('runtime_exited');
    } finally {
      await rpc.close();
    }
  });
  it('times out an individual RPC without inventing a user response', async () => {
    const rpc = new RpcClient(spawnProcess(process.execPath, ['-e', 'process.stdin.resume()']), 50);
    try {
      await expect(rpc.request('tool/requestUserInput')).rejects.toThrow('rpc_timeout');
    } finally {
      await rpc.close();
    }
  });
});
