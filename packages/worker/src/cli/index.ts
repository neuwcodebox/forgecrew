import { readFile } from 'node:fs/promises';
import { LocalConfigSchema } from '../local.ts';
import { doctor } from '../doctor.ts';
import { workerVersion } from '../version.ts';
import { startLauncher, stopLauncher, launcherStatus } from '../launcher/control.ts';
import { setAutostart } from '../launcher/autostart.ts';
import { invocation } from './options.ts';
import { setupWorker } from './setup.ts';
import { runWorker } from './run.ts';
import { showStatus } from './status.ts';

export async function executeCommand(args: string[], packageDirectory: string) {
  if (args[0] === '--help' || args.length === 0) {
    console.log(
      'ForgeCrew ' +
        workerVersion +
        '\n\n  forgecrew setup --dispatcher <https://...> --hostname <github-host> --engine <codex|claude|both> [--config <worker.json>]\n  forgecrew start | stop | status\n  forgecrew run [--config <worker.json>]\n  forgecrew autostart enable | disable\n  forgecrew doctor [--config <worker.json>]\n\n최초 등록에는 FORGECREW_REGISTRATION_TOKEN 환경변수를 지정합니다.\nsetup --autostart로 로그인 자동 시작을 등록할 수 있습니다.',
    );
    return;
  }
  if (!['setup', 'run', 'doctor', 'start', 'stop', 'status', 'autostart'].includes(args[0]!))
    throw new Error('unsupported_command');
  const command = invocation(args, packageDirectory);
  switch (args[0]) {
    case 'setup':
      return setupWorker(command);
    case 'start':
      await startLauncher(command.directory);
      console.log(JSON.stringify(await launcherStatus(command.directory), null, 2));
      return;
    case 'stop':
      await stopLauncher(command.directory);
      console.log('Worker stopped.');
      return;
    case 'status':
      return showStatus(command);
    case 'autostart':
      if (!['enable', 'disable'].includes(args[1] ?? ''))
        throw new Error('autostart_mode_required');
      await setAutostart(command.directory, args[1] === 'enable');
      console.log('Login autostart ' + args[1] + 'd.');
      return;
  }
  const config = LocalConfigSchema.parse(JSON.parse(await readFile(command.configPath, 'utf8')));
  if (args[0] === 'run') return runWorker(config, command.directory);
  const diagnostics = await doctor(config);
  console.log(JSON.stringify(diagnostics, null, 2));
  if (diagnostics.some((check) => check.status === 'blocked')) process.exitCode = 1;
}
