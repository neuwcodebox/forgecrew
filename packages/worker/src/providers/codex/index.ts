import { workerVersion } from '../../version.ts';
import { RpcClient } from '../../rpc.ts';
import type { RpcNotification } from '../../rpc.ts';
import { command, spawnProcess } from '../../process.ts';
import type { Model, Result } from '../../../../shared/src/types.ts';
import { instructions, userInput } from '../types.ts';
import type { Provider, ProviderRun, RunRequest } from '../types.ts';
import { codexModel } from './catalog.ts';
import type { CatalogEntry } from './catalog.ts';
import type { Opened, NotificationParams } from './protocol.ts';

export class CodexProvider implements Provider {
  readonly executable: string;
  constructor(executable: string) {
    this.executable = executable;
  }
  private open(cwd?: string) {
    return new RpcClient(
      spawnProcess(
        this.executable,
        [
          '-c',
          'approvals_reviewer="auto_review"',
          '-c',
          'approval_policy="on-request"',
          'app-server',
        ],
        cwd,
      ),
    );
  }
  private async initialize(rpc: RpcClient) {
    await rpc.request('initialize', {
      clientInfo: { name: 'forgecrew', version: workerVersion },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    const account = await rpc.request<{ account: { type: string } | null }>('account/read', {
      refreshToken: false,
    });
    if (!account.account || !['chatgpt', 'chatgptAuthTokens'].includes(account.account.type))
      throw new Error('codex_subscription_login_required');
  }
  async probe(): Promise<Model[]> {
    const rpc = this.open();
    try {
      await this.initialize(rpc);
      const effective = await rpc.request<{
        config: { approvals_reviewer?: string; approval_policy?: unknown; sandbox_mode?: string };
      }>('config/read', { includeLayers: false });
      if (
        effective.config.approvals_reviewer !== 'auto_review' ||
        effective.config.approval_policy === 'never' ||
        effective.config.sandbox_mode === 'danger-full-access'
      )
        throw new Error('codex_auto_review_unavailable');
      const version = await command(this.executable, ['--version']);
      if (version.code !== 0) throw new Error('codex_version_unavailable');
      const result: Model[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: CatalogEntry[]; nextCursor: string | null } = await rpc.request(
          'model/list',
          { limit: 100, includeHidden: false, cursor },
        );
        for (const entry of page.data) {
          const model = codexModel(entry, version.stdout.trim(), Date.now());
          if (model) result.push(model);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return result;
    } finally {
      await rpc.close();
    }
  }
  run(request: RunRequest): ProviderRun {
    const rpc = this.open(request.workspace);
    let threadId: string | undefined;
    let turnId: string | undefined;
    let cancelled = false;
    let interruptedForQuestion = false;
    let question = '';
    let output = '';
    let settled = false;
    let resolveResult!: (r: Result) => void;
    let rejectResult!: (e: Error) => void;
    const result = new Promise<Result>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const finish = (result: Result) => {
      if (!settled) {
        settled = true;
        resolveResult(result);
      }
    };
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        rejectResult(error);
      }
    };
    const interrupt = async () => {
      cancelled = true;
      if (threadId && turnId) await rpc.request('turn/interrupt', { threadId, turnId });
    };
    const handle = (event: RpcNotification) => {
      const p = event.params as NotificationParams;
      if (threadId && p.threadId && p.threadId !== threadId) return;
      if (event.method === 'turn/started') turnId = p.turn?.id;
      if (
        event.method === 'item/completed' &&
        p.item?.type === 'agentMessage' &&
        p.item.phase !== 'commentary'
      )
        output = p.item.text;
      if (event.method === 'model/rerouted') {
        fail(new Error('codex_model_rerouted'));
        void interrupt().catch(() => {});
      }
      if (event.id !== undefined) {
        if (event.method === 'item/tool/requestUserInput') {
          question = JSON.stringify(p.questions ?? p);
          interruptedForQuestion = true;
          // Interrupt resolves outstanding requests. Never fabricate choices or permission decisions.
          void interrupt().catch(() => fail(new Error('codex_question_interrupt_failed')));
        } else {
          rpc.rejectRequest(event.id);
          fail(new Error('codex_unattended_request_requires_human'));
          void interrupt().catch(() => {});
        }
      }
      if (event.method === 'turn/completed') {
        if (turnId && p.turn?.id !== turnId) return;
        if (interruptedForQuestion) finish({ kind: 'needs_reply', text: question });
        else if (cancelled || p.turn?.status === 'interrupted')
          fail(new Error('provider_interrupted'));
        else if (p.turn?.status !== 'completed') {
          const error = p.turn?.error?.codexErrorInfo;
          fail(
            new Error(
              error === 'usageLimitExceeded' || error === 'rateLimitExceeded'
                ? 'codex_rate_limited'
                : error === 'unauthorized'
                  ? 'codex_auth_required'
                  : 'codex_turn_failed',
            ),
          );
        } else if (!output.trim()) fail(new Error('codex_empty_result'));
        else finish({ kind: 'completed', text: output });
      }
    };
    rpc.on('notification', handle);
    rpc.on('closed', fail);
    const aborted = () => {
      void interrupt().catch(() => {});
    };
    request.signal.addEventListener('abort', aborted, { once: true });
    const start = (async () => {
      await this.initialize(rpc);
      if (request.signal.aborted) throw new Error('provider_interrupted');
      const existing = await rpc.request<{ config: { developer_instructions?: string | null } }>(
        'config/read',
        { includeLayers: false },
      );
      const developerInstructions = [existing.config.developer_instructions, instructions(request)]
        .filter(Boolean)
        .join('\n\n');
      const params = {
        cwd: request.workspace,
        model: request.claim.runConfig.model,
        approvalsReviewer: 'auto_review',
        approvalPolicy: 'on-request',
        developerInstructions,
        config: request.claim.runConfig.effort
          ? { model_reasoning_effort: request.claim.runConfig.effort }
          : {},
      };
      const opened = await rpc.request<Opened>(request.resume ? 'thread/resume' : 'thread/start', {
        ...params,
        ...(request.resume ? { threadId: request.resume.id } : {}),
      });
      if (
        opened.model !== request.claim.runConfig.model ||
        opened.approvalsReviewer !== 'auto_review' ||
        opened.approvalPolicy === 'never' ||
        ['dangerFullAccess', 'danger-full-access'].includes(opened.sandbox?.type)
      )
        throw new Error('codex_effective_settings_mismatch');
      if (
        request.claim.runConfig.effort !== null &&
        opened.reasoningEffort !== request.claim.runConfig.effort
      )
        throw new Error('codex_effective_effort_mismatch');
      threadId = opened.thread.id;
      await request.onSession({ id: threadId, engine: 'codex', workspace: request.workspace });
      if (request.signal.aborted) throw new Error('provider_interrupted');
      const started = await rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId,
        input: [{ type: 'text', text: userInput(request), text_elements: [] }],
        model: request.claim.runConfig.model,
        effort: request.claim.runConfig.effort,
        approvalsReviewer: 'auto_review',
        approvalPolicy: 'on-request',
      });
      turnId = started.turn.id;
      if (request.signal.aborted) await interrupt();
    })().catch((error) => fail(error instanceof Error ? error : new Error('codex_start_failed')));
    return {
      result,
      interrupt,
      steer: async (text, controlId) => {
        await start;
        if (!threadId || !turnId || settled) throw new Error('no_active_turn');
        await rpc.request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: controlId,
          input: [{ type: 'text', text, text_elements: [] }],
        });
      },
      close: async () => {
        request.signal.removeEventListener('abort', aborted);
        rpc.off('notification', handle);
        await rpc.close();
        await start;
      },
    };
  }
}
