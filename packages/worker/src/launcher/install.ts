import { cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from '../local.ts';
import { command } from '../process.ts';
import type { Projection } from '../../../shared/src/config/index.ts';
import { installedVersion } from './state.ts';
import type { InstalledVersion } from './state.ts';

type UpdatePolicy = Projection['payload']['updates'];
type Execute = typeof command;
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
function compatible(p: Record<string, unknown>) {
  const contract = p.forgecrew as { launcherProtocol?: number; stateSchema?: number } | undefined;
  if (contract?.launcherProtocol !== 1 || contract.stateSchema !== 1)
    throw new Error('incompatible_worker_contract');
  if (Object.keys((p.dependencies ?? {}) as object).length)
    throw new Error('worker_must_be_self_contained');
  const bin = p.bin as { forgecrew?: string } | undefined;
  if (bin?.forgecrew !== 'dist/cli.js') throw new Error('invalid_worker_entry');
}
export async function bootstrap(directory: string, packageDirectory: string) {
  const p = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  compatible(p);
  const cli = await readFile(join(packageDirectory, 'dist', 'cli.js'), 'utf8');
  const integrity = 'sha256-' + createHash('sha256').update(cli).digest('base64');
  const id = String(p.version) + '-' + digest(integrity);
  await mkdir(join(directory, 'versions'), { recursive: true, mode: 0o700 });
  try {
    return await installedVersion(directory, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stage = await mkdtemp(join(directory, 'versions', '.bootstrap-'));
  try {
    await cp(join(packageDirectory, 'dist'), join(stage, 'package', 'dist'), { recursive: true });
    await cp(join(packageDirectory, 'package.json'), join(stage, 'package', 'package.json'));
    const manifest: InstalledVersion = {
      formatVersion: 1,
      id,
      version: String(p.version),
      entry: 'package/dist/cli.js',
      integrity,
      launcherProtocol: 1,
      stateSchema: 1,
    };
    await atomicWrite(join(stage, 'installed.json'), manifest);
    await rename(stage, join(directory, 'versions', id));
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function stageUpdate(
  directory: string,
  policy: UpdatePolicy,
  current: InstalledVersion,
  execute: Execute = command,
  signal?: AbortSignal,
): Promise<InstalledVersion | undefined> {
  // npm retains the user's local credentials, CA and proxy settings. No auth values enter arguments or logs.
  const registryArgs = [
    '--registry',
    policy.registry,
    ...(policy.package.startsWith('@')
      ? ['--' + policy.package.split('/')[0] + ':registry=' + policy.registry]
      : []),
  ];
  const view = await execute(
    'npm',
    ['view', policy.package + '@' + policy.channel, 'version', 'dist', '--json', ...registryArgs],
    { timeout: 60000, ...(signal ? { signal } : {}) },
  );
  if (view.code !== 0) throw new Error('update_registry_unavailable');
  const candidate = JSON.parse(view.stdout) as {
    version: string;
    dist: { integrity: string; tarball: string };
  };
  if (
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(candidate.version) ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(candidate.dist?.integrity)
  )
    throw new Error('invalid_update_metadata');
  const source = new URL(candidate.dist.tarball),
    registry = new URL(policy.registry);
  if (source.origin !== registry.origin || source.username || source.password)
    throw new Error('update_tarball_outside_registry');
  const id = candidate.version + '-' + digest(candidate.dist.integrity);
  if (
    id === current.id ||
    (current.version === candidate.version && current.integrity === candidate.dist.integrity)
  )
    return;
  const pointer = await readFile(join(directory, 'current.json'), 'utf8').then(
    (s) => JSON.parse(s) as { failed?: Record<string, number> },
    () => ({ failed: {} as Record<string, number> }),
  );
  if ((pointer.failed?.[id] ?? 0) > Date.now()) return;
  try {
    return await installedVersion(directory, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(join(directory, 'staging'), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(directory, 'staging', 'install-'));
  try {
    await atomicWrite(join(stage, 'package.json'), {
      name: 'forgecrew-install',
      version: '0.0.0',
      private: true,
    });
    const result = await execute(
      'npm',
      [
        'install',
        policy.package + '@' + candidate.version,
        '--prefix',
        stage,
        ...registryArgs,
        '--ignore-scripts',
        '--omit=dev',
        '--engine-strict',
        '--no-audit',
        '--no-fund',
        '--save-exact',
      ],
      { timeout: 300000, ...(signal ? { signal } : {}) },
    );
    if (result.code !== 0) throw new Error('update_install_failed');
    const lock = JSON.parse(await readFile(join(stage, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { integrity?: string; resolved?: string }>;
    };
    const pkg = 'node_modules/' + policy.package;
    if (
      lock.packages[pkg]?.integrity !== candidate.dist.integrity ||
      lock.packages[pkg]?.resolved !== candidate.dist.tarball
    )
      throw new Error('update_integrity_mismatch');
    const p = JSON.parse(await readFile(join(stage, pkg, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    compatible(p);
    if (p.name !== policy.package || p.version !== candidate.version)
      throw new Error('update_package_mismatch');
    const manifest: InstalledVersion = {
      formatVersion: 1,
      id,
      version: candidate.version,
      entry: pkg + '/dist/cli.js',
      integrity: candidate.dist.integrity,
      launcherProtocol: 1,
      stateSchema: 1,
    };
    await atomicWrite(join(stage, 'installed.json'), manifest);
    // Validate the complete install before it can appear in versions/.
    await readFile(join(stage, manifest.entry));
    await mkdir(join(directory, 'versions'), { recursive: true, mode: 0o700 });
    await rename(stage, join(directory, 'versions', id));
    return await installedVersion(directory, id);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function prepareLauncher(
  directory: string,
  packageDirectory: string,
  configPath: string,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const launcher = await readFile(join(packageDirectory, 'launcher.mjs'), 'utf8');
  const target = join(directory, 'launcher.mjs');
  const temporary = target + '.tmp';
  await mkdir(dirname(target), { recursive: true });
  // The launcher itself is replaced only during explicit setup/repair, while stopped.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(temporary, launcher, { mode: 0o600 });
  await rename(temporary, target);
  await atomicWrite(join(directory, 'launch.json'), {
    formatVersion: 1,
    node: process.execPath,
    configPath,
    path: process.env.PATH ?? '',
  });
  try {
    await readFile(join(directory, 'current.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const v = await bootstrap(directory, packageDirectory);
    await atomicWrite(join(directory, 'current.json'), {
      formatVersion: 1,
      active: v.id,
      lastKnownGood: v.id,
      pending: null,
      phase: 'idle',
      failed: {},
    });
  }
}
