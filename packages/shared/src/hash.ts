import { createHash, timingSafeEqual } from 'node:crypto';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map(k => JSON.stringify(k) + ':' + canonical(object[k])).join(',') + '}';
}
export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function secretEqual(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
export function sessionId(key: { host: string; repository: string; kind: string; number: number }): string {
  return hash([key.host.toLowerCase(), key.repository.toLowerCase(), key.kind, key.number]);
}
