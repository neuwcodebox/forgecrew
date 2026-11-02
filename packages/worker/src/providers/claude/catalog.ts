import { efforts } from '../../../../shared/src/types.ts';
import type { Effort, Model } from '../../../../shared/src/types.ts';

export type ClaudeModelInfo = {
  value: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
  supportsAutoMode?: boolean;
};
export function claudeModel(
  info: ClaudeModelInfo,
  runtimeVersion: string,
  now: number,
): Model | null {
  const id = info.resolvedModel ?? info.value;
  const match = /^claude-(opus|sonnet)-(\d+)(?:[.-](\d+))?(?:$|[-[])/.exec(id);
  if (!match || info.supportsAutoMode !== true) return null;
  return {
    family: match[1] as 'opus' | 'sonnet',
    id,
    version: [Number(match[2]), Number(match[3] ?? 0)],
    engine: 'claude',
    efforts: (info.supportedEffortLevels ?? []).filter((e): e is Effort =>
      efforts.includes(e as Effort),
    ),
    defaultEffort: null,
    autoReview: true,
    availability: 'ready',
    observedAt: now,
    runtimeVersion,
  };
}
