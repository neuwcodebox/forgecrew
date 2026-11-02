import { mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../../../shared/src/hash.ts';
import type { Result } from '../../../shared/src/types.ts';
import type { Dispatcher } from '../dispatcher/protocol.ts';
import { DispatcherError } from '../dispatcher/protocol.ts';
import { writeResult } from '../local.ts';

type PendingResult = {
  attemptId: string;
  result: { generation: number; result: Result };
  resultHash: string;
};
export class ResultReporter {
  private readonly directory: string;
  private readonly dispatcher: Pick<Dispatcher, 'complete'>;
  private flushing: Promise<void> | undefined;
  constructor(directory: string, dispatcher: Pick<Dispatcher, 'complete'>) {
    this.directory = directory;
    this.dispatcher = dispatcher;
  }

  async validate() {
    const root = join(this.directory, 'journal');
    for (const name of await readdir(root).catch(() => []))
      if (name.endsWith('.json')) await this.read(join(root, name));
  }
  record(attemptId: string, generation: number, result: Result) {
    return writeResult(this.directory, attemptId, { generation, result });
  }
  flush(): Promise<void> {
    if (!this.flushing)
      this.flushing = this.sendPending().finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }
  private async read(path: string): Promise<PendingResult> {
    const record = JSON.parse(await readFile(path, 'utf8')) as PendingResult;
    if (hash(record.result) !== record.resultHash) throw new Error('result_journal_corrupt');
    return record;
  }
  private async sendPending() {
    const root = join(this.directory, 'journal');
    for (const name of (await readdir(root).catch(() => [])).filter((name) =>
      /^[a-zA-Z0-9_-]+\.json$/.test(name),
    )) {
      const path = join(root, name),
        record = await this.read(path);
      try {
        await this.dispatcher.complete(
          { attemptId: record.attemptId, generation: record.result.generation },
          record.result.result,
        );
        await unlink(path).catch(() => {});
      } catch (error) {
        if (!(error instanceof DispatcherError) || error.status !== 409) throw error;
        const rejected = join(this.directory, 'rejected-results');
        await mkdir(rejected, { recursive: true });
        await rename(path, join(rejected, name)).catch(() => {});
      }
    }
  }
}
