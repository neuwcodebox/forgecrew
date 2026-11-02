import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { command } from '../packages/worker/src/process.ts';
import { prepareLauncher } from '../packages/worker/src/launcher/install.ts';
import {
  startLauncher,
  stopLauncher,
  launcherStatus,
} from '../packages/worker/src/launcher/control.ts';
import { atomicWrite } from '../packages/worker/src/local.ts';

const dir = await mkdtemp(join(tmpdir(), 'forgecrew-package-')),
  data = join(dir, 'data');
try {
  const pack = await command('npm', [
    'pack',
    resolve('packages/worker'),
    '--pack-destination',
    dir,
    '--json',
    '--ignore-scripts',
  ]);
  assert.equal(pack.code, 0, 'npm pack failed');
  const tarball = join(dir, JSON.parse(pack.stdout)[0].filename),
    prefix = join(dir, 'clean-install');
  const install = await command('npm', [
    'install',
    tarball,
    '--prefix',
    prefix,
    '--offline',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ]);
  assert.equal(install.code, 0, 'production-only install failed');
  const pkg = join(prefix, 'node_modules', '@forgecrew', 'worker');
  const help = await command(process.execPath, [join(pkg, 'dist', 'cli.js'), '--help'], {
    cwd: prefix,
  });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /start \| stop \| status/);
  const config = join(data, 'config.json');
  await atomicWrite(config, {
    schemaVersion: 1,
    id: randomUUID(),
    token: 's'.repeat(48),
    dispatcher: 'http://127.0.0.1:1',
    hostname: 'github.invalid',
    maxConcurrentSessions: 1,
    engines: { codex: 'unavailable-test-provider' },
  });
  await prepareLauncher(data, pkg, config);
  // gh fixture fails locally. READY and version health must not depend on external service availability.
  const bin = join(dir, 'bin');
  await mkdir(bin);
  if (process.platform === 'win32') await writeFile(join(bin, 'gh.cmd'), '@exit /b 1\r\n');
  else await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const launch = JSON.parse(await readFile(join(data, 'launch.json'), 'utf8'));
  launch.path = bin + delimiter + launch.path;
  await atomicWrite(join(data, 'launch.json'), launch);
  await startLauncher(data);
  const until = Date.now() + 30000;
  while ((await launcherStatus(data)).event !== 'running') {
    assert.ok(Date.now() < until, 'offline Worker did not become locally READY');
    await new Promise((r) => setTimeout(r, 25));
  }
  await stopLauncher(data);
  assert.equal((await launcherStatus(data)).running, false);
  console.log(
    'Packed Worker clean install, standalone CLI, local READY during service outage and graceful Launcher stop passed.',
  );
} catch (error) {
  for (const name of [
    'status.json',
    'launcher-error.json',
    'logs/launcher.log',
    'logs/worker.log',
  ]) {
    const diagnostic = await readFile(join(data, name), 'utf8').catch(() => undefined);
    if (diagnostic) console.error(name + ': ' + diagnostic.slice(-4000));
  }
  throw error;
} finally {
  await stopLauncher(data).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
