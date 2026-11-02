import { efforts } from '../../../../shared/src/types.ts';
import type { Effort, Model } from '../../../../shared/src/types.ts';

export type CatalogEntry = {
  model: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
};
export function codexModel(entry: CatalogEntry, runtimeVersion: string, now: number): Model | null {
  const family = /(?:^|[-_])(sol|terra)(?:$|[-_])/.exec(entry.model)?.[1] as
    'sol' | 'terra' | undefined;
  const version = /\d+(?:\.\d+)*/.exec(entry.model)?.[0].split('.').map(Number);
  if (!family || !version) return null;
  return {
    family,
    id: entry.model,
    version,
    engine: 'codex',
    efforts: entry.supportedReasoningEfforts
      .map((e) => e.reasoningEffort)
      .filter((e): e is Effort => efforts.includes(e as Effort)),
    defaultEffort: efforts.includes(entry.defaultReasoningEffort as Effort)
      ? (entry.defaultReasoningEffort as Effort)
      : null,
    autoReview: true,
    availability: 'ready',
    observedAt: now,
    runtimeVersion,
  };
}
