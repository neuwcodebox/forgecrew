import type { Config } from './config.ts';
import type { Effort, Family, Model, WorkerCapabilities } from './types.ts';
import { efforts, families, ContractError } from './types.ts';

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0); if (diff) return Math.sign(diff);
  }
  return 0;
}
export function resolveLabels(labels: string[], config: Config, repository: string): { family: Family; effort: Effort | null } {
  const repo = config.github.repositories.find(r => r.name.toLowerCase() === repository.toLowerCase());
  if (!repo) throw new ContractError('repository_not_allowed');
  const one = (prefix: string, allowed: readonly string[]) => {
    const found = labels.filter(l => l.startsWith(prefix));
    if (found.length > 1) throw new ContractError('conflicting_labels');
    const value = found[0]?.slice(prefix.length);
    if (value !== undefined && !allowed.includes(value)) throw new ContractError('invalid_label');
    return value;
  };
  return {
    family: (one(config.labels.modelPrefix, families) ?? repo.defaults?.model ?? config.defaults.model) as Family,
    effort: (one(config.labels.effortPrefix, efforts) ?? (repo.defaults?.effort === undefined ? config.defaults.effort : repo.defaults.effort)) as Effort | null,
  };
}
export type Candidate = { worker: WorkerCapabilities; active: number; seenAt: number };
export function selectWorker(candidates: Candidate[], repository: string, family: Family, effort: Effort | null, now: number, config: Config, previousWorker?: string): { worker: WorkerCapabilities; model: Model; effort: Effort | null } {
  const catalogue = candidates.flatMap(c => {
    if (!c.worker.schemaVersions.includes(1) || c.seenAt + config.runtime.leaseDuration <= now || !c.worker.repositories.some(r => r.toLowerCase() === repository.toLowerCase())) return [];
    return c.worker.models.filter(m => m.family === family && m.observedAt <= now && m.observedAt + config.runtime.modelCatalogMaxAge > now).map(model => ({ ...c, model }));
  });
  if (!catalogue.length) throw new ContractError('no_compatible_worker');
  const latest = catalogue.reduce((a, b) => compareVersions(a.model.version, b.model.version) >= 0 ? a : b).model;
  const matching = catalogue.filter(c => compareVersions(c.model.version, latest.version) === 0);
  const usable=matching.filter(c=>c.model.availability==='ready');
  if(!usable.length)throw new ContractError('latest_model_unavailable');
  const supported = usable.filter(c => c.model.autoReview && (effort === null || c.model.efforts.includes(effort)));
  if (!supported.length) throw new ContractError('unsupported_effort_or_auto_review');
  const available = supported.filter(c => !c.worker.draining && c.active < c.worker.maxConcurrentSessions);
  if (!available.length) throw new ContractError('latest_model_workers_busy');
  available.sort((a, b) => Number(b.worker.id === previousWorker) - Number(a.worker.id === previousWorker) || a.active - b.active || a.worker.id.localeCompare(b.worker.id));
  const selected = available[0]!;
  return { worker: selected.worker, model: selected.model, effort };
}
