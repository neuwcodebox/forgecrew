// Stable, dependency-free Launcher protocol 1. Updated only by explicit setup/repair.
import { fork, spawn, execFile } from 'node:child_process';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  realpath,
  appendFile,
  stat,
} from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function read(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
async function write(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
}
async function lock(path) {
  const nonce = randomUUID();
  try {
    const f = await open(path, 'wx', 0o600);
    await f.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    await f.close();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const old = await read(path);
    if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || alive(old.pid))
      throw new Error('launcher_already_running');
    await unlink(path);
    return lock(path);
  }
  return async () => {
    if ((await read(path).catch(() => ({}))).nonce === nonce) await unlink(path);
  };
}
async function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8'),
        boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8');
      return boot.trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } catch {
      return;
    }
  }
  if (process.platform === 'win32') {
    const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){$p.CreationDate.ToUniversalTime().Ticks.ToString()}`;
    return new Promise((resolve) =>
      execFile(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, timeout: 5000 },
        (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
      ),
    );
  }
}
async function killRecorded(record) {
  if (record.identity && (await identity(record.pid)) === record.identity)
    await killTree(record.pid);
}
async function killTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32')
    await new Promise((r) => {
      const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      p.once('close', r);
      p.once('error', r);
    });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
}
async function installed(directory, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(id))
    throw new Error('invalid_version_id');
  const root = await realpath(join(directory, 'versions', id)),
    v = await read(join(root, 'installed.json'));
  if (v.formatVersion !== 1 || v.id !== id || v.launcherProtocol !== 1 || v.stateSchema !== 1)
    throw new Error('incompatible_version');
  const entry = await realpath(join(root, v.entry)),
    rel = relative(root, entry);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\'))
    throw new Error('invalid_entry');
  return { ...v, entry };
}
export async function runLauncher(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lock(join(directory, 'launcher.lock'));
  let child,
    pendingReady,
    stopping = false,
    ready = false,
    healthAt = 0,
    observedAt = 0,
    childBornAt = 0,
    restartAt = 0,
    backoff = 1000,
    transition = false,
    serial = Promise.resolve();
  const queue = (task) => {
    serial = serial.then(task).catch(async (error) => {
      await write(join(directory, 'launcher-error.json'), {
        event: 'launcher_operation_failed',
        reason:
          typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code)
            ? error.code
            : 'state_operation_failed',
        at: Date.now(),
      }).catch(() => {});
    });
  };
  await mkdir(join(directory, 'logs'), { recursive: true, mode: 0o700 });
  let logWrites = Promise.resolve();
  const capture = (stream) =>
    stream.on('data', (chunk) => {
      stream.pause();
      logWrites = logWrites
        .then(async () => {
          const path = join(directory, 'logs', 'worker.log');
          if ((await stat(path).catch(() => ({ size: 0 }))).size + chunk.length > 8 * 1024 * 1024) {
            await unlink(path + '.previous').catch(() => {});
            await rename(path, path + '.previous').catch(() => {});
          }
          await appendFile(path, chunk, { mode: 0o600 });
        })
        .catch(() => {})
        .finally(() => stream.resume());
    });
  const log = async (event, details = {}) =>
    write(join(directory, 'status.json'), {
      formatVersion: 1,
      pid: process.pid,
      workerPid: child?.pid ?? null,
      event,
      ...details,
      at: Date.now(),
    });
  const pointerPath = join(directory, 'current.json'),
    intentPath = join(directory, 'intent.json');
  const savePointer = async () => {
    const previous = await read(pointerPath).catch(() => undefined);
    if (previous) await write(join(directory, 'current.previous.json'), previous);
    await write(pointerPath, pointer);
  };
  let pointer = await read(pointerPath).catch(async () => {
    const previous = await read(join(directory, 'current.previous.json'));
    await write(pointerPath, previous);
    return previous;
  });
  if (pointer.formatVersion !== 1) throw new Error('unsupported_pointer_format');
  const launch = await read(join(directory, 'launch.json'));
  if (launch.formatVersion !== 1) throw new Error('unsupported_launch_format');
  const orphan = await read(join(directory, 'children.json')).catch(() => ({ children: [] }));
  for (const record of orphan.children ?? []) await killRecorded(record);
  const descendants = new Map();
  const saveChildren = () =>
    write(join(directory, 'children.json'), {
      children: [...descendants].map(([pid, identity]) => ({ pid, identity })),
    });
  const remember = async (pid) => {
    if (!alive(pid)) return;
    const token = await identity(pid);
    if (token) {
      descendants.set(pid, token);
      await saveChildren();
    }
  };
  const clearChildren = async () => {
    for (const [pid, token] of descendants) await killRecorded({ pid, identity: token });
    descendants.clear();
    await saveChildren();
  };
  const failCandidate = async () => {
    if (pointer.pending) {
      pointer.failed[pointer.pending.id] =
        Date.now() + pointer.pending.policy.failedVersionCooldown;
      pointer.active = pointer.lastKnownGood;
      pointer.pending = null;
      pointer.phase = 'idle';
      await savePointer();
    }
  };
  // A crash during handoff/observation cannot certify the candidate as healthy.
  if (pointer.pending) {
    if (pointer.phase !== 'staged') await failCandidate();
    else {
      pointer.pending = null;
      pointer.phase = 'idle';
      await savePointer();
    }
  }
  const desired = async () =>
    !(await read(intentPath).catch(() => ({ desired: true }))).desired ? false : true;
  const stopChild = async () => {
    if (!child) return;
    const current = child;
    if (current.connected) current.send({ type: 'STOP', protocolVersion: 1 });
    let closed = current.exitCode !== null || current.signalCode !== null;
    current.once('close', () => {
      closed = true;
    });
    const deadline = Date.now() + 30000;
    while (!closed && Date.now() < deadline) await delay(50);
    if (!closed) {
      await killTree(current.pid);
      while (!closed) await delay(25);
    }
    await clearChildren();
    if (child === current) child = undefined;
  };
  const persistReady = async () => {
    const notice = pendingReady;
    if (!notice) return;
    if (notice.child !== child) {
      pendingReady = undefined;
      return;
    }
    if (notice.candidate) {
      pointer.phase = 'observing';
      await savePointer();
    }
    await log(notice.candidate ? 'observing' : 'running', { version: notice.version });
    ready = true;
    healthAt = Date.now();
    observedAt = Date.now();
    pendingReady = undefined;
  };
  const startChild = async () => {
    const candidate = pointer.pending && pointer.phase === 'switching';
    const selected = candidate ? pointer.pending.id : pointer.active;
    let version;
    try {
      version = await installed(directory, selected);
    } catch (error) {
      if (candidate) {
        await failCandidate();
        return;
      }
      throw error;
    }
    ready = false;
    pendingReady = undefined;
    healthAt = Date.now();
    observedAt = 0;
    const p = fork(version.entry, ['run', '--config', launch.configPath], {
      execPath: launch.node,
      execArgv: [],
      env: {
        ...process.env,
        PATH: launch.path ?? process.env.PATH,
        FORGECREW_DATA_DIR: directory,
        FORGECREW_STABILIZING: candidate ? '1' : '0',
        FORGECREW_VERSION: version.version,
        FORGECREW_VERSION_ID: selected,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child = p;
    if (p.pid) queue(() => remember(p.pid));
    capture(p.stdout);
    capture(p.stderr);
    const bornAt = Date.now();
    childBornAt = bornAt;
    p.on('message', (message) => {
      if (p === child && message?.protocolVersion === 1 && message.type === 'HEALTH') {
        healthAt = Date.now();
        return;
      }
      queue(async () => {
        if (p !== child || message?.protocolVersion !== 1) return;
        if (
          message.type === 'CHILD_SPAWN' &&
          Number.isSafeInteger(message.pid) &&
          message.pid > 0
        ) {
          await remember(message.pid);
        }
        if (message.type === 'CHILD_EXIT') {
          descendants.delete(message.pid);
          await saveChildren();
        }
        if (message.type === 'READY' && !ready) {
          pendingReady = { child: p, candidate, version: version.version };
          await persistReady();
        }
        if (message.type === 'HEALTH') healthAt = Date.now();
        if (
          message.type === 'STAGE_READY' &&
          pointer.pending?.id === message.id &&
          pointer.phase === 'staged'
        ) {
          p.send({ type: 'STAGE_ACCEPTED', protocolVersion: 1, id: message.id });
          return;
        }
        if (
          message.type === 'STAGE_READY' &&
          ready &&
          !pointer.pending &&
          (pointer.failed[message.id] ?? 0) <= Date.now() &&
          message.id !== pointer.active
        ) {
          await installed(directory, message.id);
          const policy = message.policy;
          if (
            !policy ||
            !Number.isFinite(policy.stabilizationWindow) ||
            policy.stabilizationWindow <= 0 ||
            !Number.isFinite(policy.failedVersionCooldown) ||
            policy.failedVersionCooldown <= 0
          )
            return;
          pointer.pending = { id: message.id, policy };
          pointer.phase = 'staged';
          await savePointer();
          p.send({ type: 'STAGE_ACCEPTED', protocolVersion: 1, id: message.id });
        }
        if (
          message.type === 'SWITCH' &&
          pointer.pending?.id === message.id &&
          pointer.phase === 'staged'
        ) {
          pointer.phase = 'switching';
          await savePointer();
          transition = true;
          await stopChild();
          transition = false;
          restartAt = 0;
        }
      });
    });
    p.once('error', () => {
      queue(() => log('worker_spawn_failed'));
    });
    p.once('close', () =>
      queue(async () => {
        if (child !== p) return;
        child = undefined;
        await clearChildren();
        if (transition || stopping) return;
        if ((pointer.pending && pointer.phase === 'observing') || candidate) await failCandidate();
        else if (pointer.phase === 'staged') {
          pointer.pending = null;
          pointer.phase = 'idle';
          await savePointer();
        }
        if (Date.now() - bornAt > 60000) backoff = 1000;
        restartAt = Date.now() + backoff;
        backoff = Math.min(backoff * 2, 30000);
        await log('restarting');
      }),
    );
  };
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const healthTimer = setInterval(() => {
    if (child?.connected && ready && !transition && !stopping)
      child.send({ type: 'HEALTH', protocolVersion: 1 });
  }, 1000);
  try {
    await log('starting');
    while (!stopping && (await desired())) {
      await serial;
      if (pendingReady) queue(persistReady);
      if (!child && Date.now() >= restartAt) await startChild();
      if (child) {
        if (
          (!ready && Date.now() - childBornAt > 30000) ||
          (ready && Date.now() - healthAt > 30000)
        ) {
          queue(async () => {
            transition = true;
            await stopChild();
            transition = false;
            await failCandidate();
            restartAt = Date.now() + backoff;
            backoff = Math.min(backoff * 2, 30000);
          });
        }
        if (
          ready &&
          pointer.phase === 'observing' &&
          Date.now() - observedAt >= pointer.pending.policy.stabilizationWindow
        ) {
          pointer.active = pointer.pending.id;
          pointer.lastKnownGood = pointer.active;
          pointer.pending = null;
          pointer.phase = 'idle';
          await savePointer();
          child.send({ type: 'ACTIVATE', protocolVersion: 1 });
          await log('running');
        }
      }
      await delay(250);
    }
  } finally {
    stopping = true;
    clearInterval(healthTimer);
    await serial;
    await stopChild();
    await logWrites;
    await log('stopped');
    await release();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runLauncher(resolve(process.argv[2] ?? '.')).catch(() => {
    console.error('ForgeCrew Launcher failed. Inspect local status and configuration.');
    process.exitCode = 1;
  });
