export const families = ['sol', 'terra', 'opus', 'sonnet'] as const;
export const efforts = ['low', 'medium', 'high', 'xhigh'] as const;
export type Family = typeof families[number];
export type Effort = typeof efforts[number];
export type Engine = 'codex' | 'claude';
export type Model = {
  family: Family;
  id: string;
  version: number[];
  efforts: Effort[];
  defaultEffort: Effort | null;
  engine: Engine;
  autoReview: boolean;
  availability: 'ready' | 'auth_required' | 'rate_limited' | 'unavailable';
  observedAt: number;
  runtimeVersion: string;
};
export type WorkerCapabilities = {
  id: string;
  githubLogin: string;
  githubId: string;
  version: string;
  schemaVersions: number[];
  maxConcurrentSessions: number;
  repositories: string[];
  models: Model[];
  draining: boolean;
};
export type SessionKey = { host: string; repository: string; kind: 'issue' | 'pull'; number: number };
export type Control = { kind: 'stop' } | { kind: 'steer'; text: string };
export type Result = { kind: 'completed' | 'needs_reply' | 'failed'; text: string; links?: string[] | undefined;origin?:'ai'|'runtime'|undefined };

export class ContractError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
