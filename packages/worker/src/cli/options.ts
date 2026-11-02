import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export type Invocation = ReturnType<typeof invocation>;
export function invocation(args: string[], packageDirectory: string) {
  const value = (name: string) => {
    const i = args.indexOf('--' + name);
    if (i < 0) return undefined;
    const result = args[i + 1];
    if (!result || result.startsWith('--')) throw new Error('missing_option_value');
    return result;
  };
  const directory = resolve(
    process.env.FORGECREW_DATA_DIR ??
      (process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? homedir(), 'ForgeCrew')
        : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'forgecrew')),
  );
  const configPath = resolve(value('config') ?? join(directory, 'config.json'));
  return { args, directory, configPath, packageDirectory, value };
}
