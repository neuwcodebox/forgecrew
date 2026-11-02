import { mkdir, realpath, rename, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command } from '../process.ts';
import type { WorkSession } from '../../../shared/src/protocol.ts';
import type { Workspaces } from './contracts.ts';

export class GitWorkspaces implements Workspaces {
  private readonly hostname: string;
  private readonly directory: string;
  private readonly execute: typeof command;
  constructor(hostname: string, directory: string, execute: typeof command = command) {
    this.hostname = hostname;
    this.directory = directory;
    this.execute = execute;
  }
  async prepare(session: WorkSession, signal?: AbortSignal): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(session.id) || session.host !== this.hostname)
      throw new Error('invalid_workspace_identity');
    const root = resolve(this.directory, 'workspaces');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = join(root, session.id);
    if (
      await stat(destination).then(
        () => true,
        () => false,
      )
    ) {
      const actual = await realpath(destination);
      if (!actual.startsWith((await realpath(root)) + sep))
        throw new Error('workspace_outside_managed_root');
      const result = await this.execute('git', ['rev-parse', '--show-toplevel'], {
        cwd: destination,
        ...(signal ? { signal } : {}),
      });
      if (result.code !== 0 || resolve(result.stdout.trim()) !== actual)
        throw new Error('workspace_requires_repair');
      return destination;
    }
    const staging = join(root, '.clone-' + session.id + '-' + randomUUID());
    // A failed partial clone is preserved for diagnosis; an existing checkout is never reset.
    const clone = await this.execute(
      'gh',
      ['repo', 'clone', `https://${this.hostname}/${session.repository}.git`, staging],
      { timeout: 120000, ...(signal ? { signal } : {}) },
    );
    if (clone.code !== 0) throw new Error('workspace_clone_failed');
    if (session.kind === 'pull') {
      const checkout = await this.execute(
        'gh',
        [
          'pr',
          'checkout',
          String(session.number),
          '--repo',
          `https://${this.hostname}/${session.repository}`,
        ],
        { cwd: staging, timeout: 60000, ...(signal ? { signal } : {}) },
      );
      if (checkout.code !== 0) throw new Error('pull_checkout_failed');
    }
    await rename(staging, destination);
    return destination;
  }
}
