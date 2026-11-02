import type { Control } from './types.ts';

export function parseControl(body: string): Control | null {
  const first = body.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  if (first === '/ai stop') return { kind: 'stop' };
  const steer = /^\/ai steer[ \t]+(.+)$/.exec(first ?? '');
  if (steer) return { kind: 'steer', text: [steer[1], ...body.trimStart().split(/\r?\n/).slice(1)].join('\n').trim() };
  return null;
}
export function canWrite(permission: { permission?: string; role_name?: string; user?: { permissions?: { push?: boolean; admin?: boolean; maintain?: boolean } } }): boolean {
  return ['write','maintain','admin'].includes(permission.permission ?? '') || permission.user?.permissions?.push === true || permission.user?.permissions?.admin === true || permission.user?.permissions?.maintain === true;
}
