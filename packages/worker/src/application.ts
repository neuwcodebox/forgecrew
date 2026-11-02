import type { LocalConfig } from './local.ts';
import { DispatcherClient } from './dispatcher/client.ts';
import { GhClient } from './github/client.ts';
import { GitWorkspaces } from './github/workspaces.ts';
import { CodexProvider } from './providers/codex/index.ts';
import { ClaudeProvider } from './providers/claude/index.ts';
import { WorkerRuntime } from './runtime/index.ts';
import { workerVersion } from './version.ts';

export function createWorker(config: LocalConfig, directory: string): WorkerRuntime {
  return new WorkerRuntime(config, directory, {
    dispatcher: new DispatcherClient(config),
    github: new GhClient(config.hostname),
    workspaces: new GitWorkspaces(config.hostname, directory),
    providers: {
      ...(config.engines.codex ? { codex: new CodexProvider(config.engines.codex) } : {}),
      ...(config.engines.claude ? { claude: new ClaudeProvider(config.engines.claude) } : {}),
    },
    version: workerVersion,
    logger: (record) => console.log(JSON.stringify(record)),
    ready: () => process.send?.({ type: 'READY', protocolVersion: 1 }),
    stabilizing: process.env.FORGECREW_STABILIZING === '1',
  });
}
