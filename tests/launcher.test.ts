import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../packages/worker/src/local.ts';
import { stageUpdate, bootstrap } from '../packages/worker/src/launcher/install.ts';
import {
  startLauncher,
  stopLauncher,
  launcherStatus,
} from '../packages/worker/src/launcher/control.ts';
import { linuxUnit, windowsTaskScript } from '../packages/worker/src/launcher/autostart.ts';
import { config } from './helpers.ts';
import type { InstalledVersion } from '../packages/worker/src/launcher/state.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'forgecrew-launcher-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function wait<T>(read: () => Promise<T>, predicate: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  while (true) {
    const v = await read();
    if (predicate(v)) return v;
    if (Date.now() > deadline) throw new Error('condition_timeout: ' + JSON.stringify(v));
    await new Promise((r) => setTimeout(r, 25));
  }
}
const current: InstalledVersion = {
  formatVersion: 1,
  id: 'old',
  version: '0.1.0',
  entry: 'worker.cjs',
  integrity: 'sha512-old',
  launcherProtocol: 1,
  stateSchema: 1,
};
async function version(dir: string, id: string) {
  await mkdir(join(dir, 'versions', id), { recursive: true });
  await copyFile(
    fileURLToPath(new URL('./fixtures/launcher-worker.cjs', import.meta.url)),
    join(dir, 'versions', id, 'worker.cjs'),
  );
  await atomicWrite(join(dir, 'versions', id, 'installed.json'), { ...current, id });
}
async function setup() {
  const dir = await directory();
  await version(dir, 'old');
  await version(dir, 'good');
  await version(dir, 'bad');
  await copyFile(resolve('packages/worker/launcher.mjs'), join(dir, 'launcher.mjs'));
  await atomicWrite(join(dir, 'launch.json'), {
    formatVersion: 1,
    node: process.execPath,
    configPath: join(dir, 'config.json'),
  });
  await atomicWrite(join(dir, 'current.json'), {
    formatVersion: 1,
    active: 'old',
    lastKnownGood: 'old',
    pending: null,
    phase: 'idle',
    failed: {},
  });
  cleanup.push(() => stopLauncher(dir));
  return dir;
}
const pointer = (dir: string) =>
  readFile(join(dir, 'current.json'), 'utf8').then(
    (s) =>
      JSON.parse(s) as {
        active: string;
        pending: unknown;
        phase: string;
        failed: Record<string, number>;
      },
  );
const events = (dir: string) =>
  readFile(join(dir, 'fixture-events.jsonl'), 'utf8').then(
    (s) =>
      s
        .trim()
        .split('\n')
        .map((v) => JSON.parse(v) as { id: string; event: string }),
    () => [],
  );
const policy = { stabilizationWindow: 1, failedVersionCooldown: 10000 };
describe('stable Launcher and production staging', { timeout: 20000 }, () => {
  it('keeps one background Worker, respects stop intent and resumes on explicit start', async () => {
    const dir = await setup();
    await startLauncher(dir);
    await wait(
      () => events(dir),
      (e) => e.some((v) => v.id === 'old' && v.event === 'started'),
    );
    const first = await launcherStatus(dir);
    await startLauncher(dir);
    expect((await launcherStatus(dir)).pid).toBe(first.pid);
    await stopLauncher(dir);
    expect((await launcherStatus(dir)).running).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'intent.json'), 'utf8'))).toEqual({
      desired: false,
    });
    await startLauncher(dir);
    await wait(
      () => events(dir),
      (e) => e.filter((v) => v.event === 'started').length === 2,
    );
  });
  it('retries local READY persistence after a filesystem failure without restarting a healthy Worker', async () => {
    const dir = await setup();
    const gate = join(dir, 'fixture-delay-ready');
    await writeFile(gate, 'hold READY');
    await startLauncher(dir);
    await wait(
      () => events(dir),
      (items) => items.some((item) => item.event === 'started'),
    );
    const before = await launcherStatus(dir);
    const status = join(dir, 'status.json');
    await rm(status);
    await mkdir(status);
    await rm(gate);
    try {
      await wait(
        () =>
          readFile(join(dir, 'launcher-error.json'), 'utf8').then(
            (text) => JSON.parse(text) as { event?: string },
            () => ({}) as { event?: string },
          ),
        (error) => error.event === 'launcher_operation_failed',
      );
    } finally {
      await rm(status, { recursive: true, force: true });
    }
    const recovered = await wait(
      () => launcherStatus(dir),
      (state) => state.event === 'running',
    );
    expect(recovered.pid).toBe(before.pid);
    expect((await events(dir)).filter((item) => item.event === 'started')).toHaveLength(1);
  });
  it('switches only from a staged version and promotes after local READY and observation', async () => {
    const dir = await setup();
    await startLauncher(dir);
    await wait(
      () => launcherStatus(dir),
      (s) => s.event === 'running',
    );
    await atomicWrite(join(dir, 'fixture-request.json'), { from: 'old', id: 'good', policy });
    await wait(
      () => pointer(dir),
      (p) => p.active === 'good' && p.phase === 'idle',
    );
    await wait(
      () => events(dir),
      (e) => e.some((v) => v.id === 'good' && v.event === 'activated'),
    );
    expect(
      (await events(dir)).findIndex((v) => v.id === 'old' && v.event === 'stopped'),
    ).toBeLessThan((await events(dir)).findIndex((v) => v.id === 'good' && v.event === 'started'));
  });
  it('rolls back a candidate crash and records cooldown without repeating the failed version', async () => {
    const dir = await setup();
    await startLauncher(dir);
    await wait(
      () => launcherStatus(dir),
      (s) => s.event === 'running',
    );
    await atomicWrite(join(dir, 'fixture-request.json'), { from: 'old', id: 'bad', policy });
    const p = await wait(
      () => pointer(dir),
      (p) => (p.failed.bad ?? 0) > 0,
    );
    expect(p.active).toBe('old');
    expect(p.pending).toBeNull();
    // A repeated stage request is rejected by Launcher cooldown, independently of the updater.
    await wait(
      () => events(dir),
      (e) => e.filter((v) => v.id === 'old' && v.event === 'started').length === 2,
    );
  });
  it('recovers a crash during pointer handoff using the last known good version', async () => {
    const dir = await setup();
    await atomicWrite(join(dir, 'current.json'), {
      formatVersion: 1,
      active: 'old',
      lastKnownGood: 'old',
      pending: { id: 'good', policy },
      phase: 'switching',
      failed: {},
    });
    await startLauncher(dir);
    await wait(
      () => events(dir),
      (e) => e.some((v) => v.id === 'old' && v.event === 'started'),
    );
    expect((await pointer(dir)).failed.good).toBeGreaterThan(0);
    expect((await events(dir)).some((v) => v.id === 'good')).toBe(false);
  });
  it('recovers the previous atomic pointer when the current file is damaged', async () => {
    const dir = await setup();
    await copyFile(join(dir, 'current.json'), join(dir, 'current.previous.json'));
    await writeFile(join(dir, 'current.json'), '{invalid');
    await startLauncher(dir);
    await wait(
      () => events(dir),
      (e) => e.some((v) => v.id === 'old' && v.event === 'started'),
    );
    expect((await launcherStatus(dir)).running).toBe(true);
  });
  it('installs an exact version without scripts and verifies registry, lock integrity and protocol', async () => {
    const dir = await directory();
    const c = config().updates;
    const integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
    const tarball = new URL('worker.tgz', c.registry).href;
    const calls: string[][] = [];
    const staged = await stageUpdate(dir, c, current, async (_exe, args) => {
      calls.push(args);
      if (args[0] === 'view')
        return {
          code: 0,
          stdout: JSON.stringify({ version: '0.2.0', dist: { integrity, tarball } }),
          stderr: '',
        };
      const root = args[args.indexOf('--prefix') + 1]!;
      const pkg = join(root, 'node_modules', c.package);
      await mkdir(join(pkg, 'dist'), { recursive: true });
      await writeFile(join(pkg, 'dist', 'cli.js'), 'export {};');
      await atomicWrite(join(pkg, 'package.json'), {
        name: c.package,
        version: '0.2.0',
        bin: { forgecrew: 'dist/cli.js' },
        forgecrew: { launcherProtocol: 1, stateSchema: 1 },
      });
      await atomicWrite(join(root, 'package-lock.json'), {
        packages: { ['node_modules/' + c.package]: { integrity, resolved: tarball } },
      });
      return { code: 0, stdout: '', stderr: '' };
    });
    expect(staged?.version).toBe('0.2.0');
    expect(calls[1]).toContain(c.package + '@0.2.0');
    expect(calls[1]).toContain('--ignore-scripts');
    expect(calls[1]).toContain('--engine-strict');
    expect(await readFile(join(dir, 'versions', staged!.id, 'installed.json'), 'utf8')).toContain(
      integrity,
    );
  });
  it.each(['integrity', 'contract', 'install'] as const)(
    'preserves the working pointer and removes incomplete staging after %s failure',
    async (failure) => {
      const dir = await directory(),
        c = config().updates,
        integrity = 'sha512-' + Buffer.alloc(64, 2).toString('base64'),
        tarball = new URL('candidate.tgz', c.registry).href;
      await atomicWrite(join(dir, 'current.json'), {
        formatVersion: 1,
        active: 'old',
        lastKnownGood: 'old',
        pending: null,
        phase: 'idle',
        failed: {},
      });
      const before = await readFile(join(dir, 'current.json'), 'utf8');
      await expect(
        stageUpdate(dir, c, current, async (_exe, args) => {
          if (args[0] === 'view')
            return {
              code: 0,
              stdout: JSON.stringify({ version: '0.2.0', dist: { integrity, tarball } }),
              stderr: '',
            };
          const root = args[args.indexOf('--prefix') + 1]!,
            pkg = join(root, 'node_modules', c.package);
          await mkdir(join(pkg, 'dist'), { recursive: true });
          await writeFile(join(pkg, 'dist', 'cli.js'), 'export {};');
          if (failure === 'install')
            return { code: 1, stdout: '', stderr: 'fixture install failed' };
          await atomicWrite(join(root, 'package-lock.json'), {
            packages: {
              ['node_modules/' + c.package]: {
                integrity: failure === 'integrity' ? 'different' : integrity,
                resolved: tarball,
              },
            },
          });
          await atomicWrite(join(pkg, 'package.json'), {
            name: c.package,
            version: '0.2.0',
            bin: { forgecrew: 'dist/cli.js' },
            forgecrew: { launcherProtocol: 1, stateSchema: 2 },
          });
          return { code: 0, stdout: '', stderr: '' };
        }),
      ).rejects.toThrow(
        failure === 'integrity'
          ? 'update_integrity_mismatch'
          : failure === 'contract'
            ? 'incompatible_worker_contract'
            : 'update_install_failed',
      );
      expect(await readFile(join(dir, 'current.json'), 'utf8')).toBe(before);
      expect(await readdir(join(dir, 'staging'))).toEqual([]);
      expect(await readdir(join(dir, 'versions')).catch(() => [])).toEqual([]);
    },
  );
  it('keeps the current install when metadata points to an unapproved registry host', async () => {
    const dir = await directory();
    let installs = 0;
    await expect(
      stageUpdate(dir, config().updates, current, async (_exe, args) => {
        if (args[0] === 'install') installs++;
        return {
          code: 0,
          stdout: JSON.stringify({
            version: '0.2.0',
            dist: { integrity: 'sha512-YQ==', tarball: 'https://unapproved.example/worker.tgz' },
          }),
          stderr: '',
        };
      }),
    ).rejects.toThrow('update_tarball_outside_registry');
    expect(installs).toBe(0);
  });
  it('snapshots a self contained package without the developer toolchain', async () => {
    const dir = await directory(),
      pkg = join(dir, 'source');
    await mkdir(join(pkg, 'dist'), { recursive: true });
    await writeFile(join(pkg, 'dist', 'cli.js'), 'export {};');
    await atomicWrite(join(pkg, 'package.json'), {
      version: '0.1.0',
      bin: { forgecrew: 'dist/cli.js' },
      forgecrew: { launcherProtocol: 1, stateSchema: 1 },
    });
    const v = await bootstrap(dir, pkg);
    expect(await readFile(join(dir, 'versions', v.id, v.entry), 'utf8')).toBe('export {};');
  });
  it('quotes native login service paths and uses the current interactive Windows user', () => {
    const unit = linuxUnit('/node path/node', '/data path/100%crew', '/bin:/custom');
    expect(unit).toContain('100%%crew');
    expect(unit).toContain('KillMode=mixed');
    const script = windowsTaskScript('C:\\node path\\node.exe', "C:\\crew's data", 'task', true);
    expect(script).toContain("crew''s data");
    expect(script).toContain('-LogonType Interactive -RunLevel Limited');
    expect(script).not.toContain('-Password');
  });
});
