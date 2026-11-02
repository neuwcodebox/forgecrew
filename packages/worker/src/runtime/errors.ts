import type { Model } from '../../../shared/src/types.ts';

export type InterruptReason =
  'stop' | 'shutdown' | 'lease_lost' | 'steer' | 'refresh' | 'provider_blocked' | 'github_blocked';
export function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z_]+$/.test(error.message)
    ? error.message
    : 'worker_operation_failed';
}
export function providerAvailability(reason: string): Model['availability'] {
  if (/rate_limit|usage_limit/.test(reason)) return 'rate_limited';
  if (/auth|subscription|login/.test(reason)) return 'auth_required';
  return 'unavailable';
}
export function recoveryReason(
  reason: string,
): 'refresh' | 'github_blocked' | 'provider_blocked' | undefined {
  if (
    [
      'input_changed_before_start',
      'input_deleted',
      'requester_no_longer_has_write_access',
    ].includes(reason)
  )
    return 'refresh';
  if (
    [
      'github_request_failed',
      'github_pagination_failed',
      'workspace_clone_failed',
      'pull_checkout_failed',
    ].includes(reason)
  )
    return 'github_blocked';
  if (
    /rate_limit|usage_limit|auth_required|subscription_login_required|runtime_exited|exited_before_result|rpc_timeout/.test(
      reason,
    )
  )
    return 'provider_blocked';
  return undefined;
}
export type RuntimeLog = (
  event: string,
  reason?: string,
  details?: Record<string, unknown>,
) => void;
