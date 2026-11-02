import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dispatcher, ControlMessage } from '../dispatcher/protocol.ts';
import { atomicWrite } from '../local.ts';
import type { AttemptRunner } from './attempts.ts';
import { errorCode } from './errors.ts';
import type { RuntimeLog } from './errors.ts';

export class ControlProcessor {
  private readonly directory: string;
  private readonly dispatcher: Pick<Dispatcher, 'restartSteer' | 'acknowledgeControl'>;
  private readonly attempts: Pick<AttemptRunner, 'active' | 'interrupt' | 'start'>;
  private readonly log: RuntimeLog;
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    directory: string,
    dispatcher: Pick<Dispatcher, 'restartSteer' | 'acknowledgeControl'>,
    attempts: Pick<AttemptRunner, 'active' | 'interrupt' | 'start'>,
    log: RuntimeLog,
  ) {
    this.directory = directory;
    this.dispatcher = dispatcher;
    this.attempts = attempts;
    this.log = log;
  }
  dispatch(messages: ControlMessage[]) {
    for (const message of messages) {
      if (this.pending.has(message.id)) continue;
      const task = this.apply(message)
        .catch((error) => this.log('control_failed', errorCode(error)))
        .finally(() => this.pending.delete(message.id));
      this.pending.set(message.id, task);
    }
  }
  async settle() {
    await Promise.all([...this.pending.values()]);
  }
  private async apply(message: ControlMessage) {
    const active = this.attempts.active.get(message.attemptId);
    if (!active) return;
    const path = join(this.directory, 'controls', message.id + '.json');
    const applied = await readFile(path, 'utf8').then(
      () => true,
      () => false,
    );
    if (!applied) {
      if (message.control.kind === 'stop') await this.attempts.interrupt(active, 'stop');
      else if (active.claim.runConfig.engine === 'claude') {
        await this.attempts.interrupt(active, 'steer');
        const wall = Date.now(),
          mono = performance.now();
        const next = await this.dispatcher.restartSteer(
          { attemptId: active.claim.attemptId, generation: active.claim.generation },
          message.id,
        );
        this.attempts.start(next.claim, wall, mono);
      } else {
        if (!active.run) throw new Error('provider_not_started');
        await active.run.steer(message.control.text, message.id);
      }
      await atomicWrite(path, { applied: true });
    }
    await this.dispatcher.acknowledgeControl(message.id);
  }
}
