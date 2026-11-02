import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { terminateTree } from '../../process.ts';

export type ClaudeMessage = {
  type: string;
  subtype?: string;
  model?: string;
  permissionMode?: string;
  session_id?: string;
  error?: string;
  modelUsage?: Record<string, unknown>;
  is_error?: boolean;
  result?: unknown;
};

export class ClaudeStream extends EventEmitter<{
  closed: [];
  invalid_message: [];
  unattended_request: [];
  message: [ClaudeMessage];
}> {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (r: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(child: ChildProcessWithoutNullStreams) {
    super();
    this.child = child;
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    const fail = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('claude_stream_closed'));
      }
      this.pending.clear();
      this.emit('closed');
    };
    child.on('error', fail);
    child.on('close', () => {
      lines.close();
      fail();
    });
    lines.on('line', (line) => {
      try {
        if (line.length > 8 * 1024 * 1024) throw new Error('large_message');
        const message = JSON.parse(line) as ClaudeMessage & {
          request_id?: string;
          response?: { request_id: string; subtype: string; response?: unknown };
        };
        if (message.type === 'control_response') {
          const r = message.response;
          if (!r) throw new Error('missing_control_response');
          const pending = this.pending.get(r.request_id);
          if (!pending) return;
          this.pending.delete(r.request_id);
          clearTimeout(pending.timer);
          if (r.subtype === 'error') pending.reject(new Error('claude_control_rejected'));
          else pending.resolve(r.response);
        } else if (message.type === 'control_request') {
          this.send({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: message.request_id,
              error: 'No human response is available.',
            },
          });
          this.emit('unattended_request');
        } else this.emit('message', message);
      } catch {
        this.emit('invalid_message');
      }
    });
  }
  send(value: unknown) {
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  control<T = unknown>(request: Record<string, unknown>): Promise<T> {
    const request_id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error('claude_control_timeout'));
      }, 15000);
      this.pending.set(request_id, { resolve: (value) => resolve(value as T), reject, timer });
      this.send({ type: 'control_request', request_id, request });
    });
  }
  async close() {
    await terminateTree(this.child);
  }
}
