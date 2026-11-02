import type { LocalConfig } from '../local.ts';
import type { Projection } from '../../../shared/src/config/index.ts';
import type { Result, WorkerCapabilities } from '../../../shared/src/types.ts';
import type { DeliveryClaim, WorkClaim } from '../../../shared/src/protocol.ts';
import { DispatcherError } from './protocol.ts';
import type {
  Dispatcher,
  AttemptIdentity,
  AttemptLease,
  HeartbeatResponse,
  WorkerStatus,
} from './protocol.ts';

export class DispatcherClient implements Dispatcher {
  readonly config: LocalConfig;
  readonly fetcher: typeof fetch;
  requestTimeout = 30000;
  constructor(config: LocalConfig, fetcher: typeof fetch = fetch) {
    const url = new URL(config.dispatcher);
    if (url.username || url.password || url.search || url.hash)
      throw new Error('invalid_dispatcher_url');
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
      throw new Error('dispatcher_requires_tls');
    this.config = config;
    this.fetcher = fetcher;
  }
  register(capabilities: WorkerCapabilities, token: string, registrationToken: string) {
    return this.request<{ configRevision: string }>(
      '/v1/register',
      { capabilities, token },
      { registrationToken },
    );
  }
  heartbeat(capabilities: WorkerCapabilities) {
    return this.request<HeartbeatResponse>('/v1/heartbeat', capabilities);
  }
  configuration(revision: string) {
    return this.request<Projection>('/v1/config/' + revision, undefined, { method: 'GET' });
  }
  claim(wait: boolean, signal?: AbortSignal) {
    return this.request<{ claim: WorkClaim | null }>(
      '/v1/claim' + (wait ? '?wait=1' : ''),
      undefined,
      signal ? { signal } : {},
    );
  }
  renewAttempt(attempt: AttemptIdentity) {
    return this.request<AttemptLease>('/v1/renew', attempt);
  }
  cancelAttempt(attempt: AttemptIdentity) {
    return this.request('/v1/cancel', attempt);
  }
  releaseAttempt(attempt: AttemptIdentity) {
    return this.request('/v1/release', attempt);
  }
  restartSteer(attempt: AttemptIdentity, controlId: string) {
    return this.request<{ claim: WorkClaim | null }>('/v1/steer-restart', {
      ...attempt,
      controlId,
    });
  }
  acknowledgeControl(id: string) {
    return this.request('/v1/controls/' + id + '/ack');
  }
  complete(attempt: AttemptIdentity, result: Result) {
    return this.request('/v1/complete', { ...attempt, result });
  }
  claimDelivery() {
    return this.request<{ delivery: DeliveryClaim | null }>('/v1/deliveries/claim');
  }
  renewDelivery(id: string) {
    return this.request<{ leaseDuration: number }>('/v1/deliveries/' + id + '/renew');
  }
  beginDelivery(id: string) {
    return this.request('/v1/deliveries/' + id + '/begin');
  }
  receipt(id: string, githubId: string) {
    return this.request('/v1/deliveries/' + id + '/receipt', { githubId });
  }
  status(timeout = 5000) {
    return this.request<WorkerStatus>('/v1/status', undefined, { method: 'GET', timeout });
  }
  private async request<T>(
    path: string,
    body?: unknown,
    options: {
      method?: string;
      registrationToken?: string;
      timeout?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const response = await this.fetcher(this.config.dispatcher.replace(/\/$/, '') + path, {
      method: options.method ?? 'POST',
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([
            options.signal,
            AbortSignal.timeout(options.timeout ?? this.requestTimeout),
          ])
        : AbortSignal.timeout(options.timeout ?? this.requestTimeout),
      headers: {
        'Content-Type': 'application/json',
        'X-ForgeCrew-Worker': this.config.id,
        Authorization: 'Bearer ' + (options.registrationToken ?? this.config.token),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new DispatcherError(response.status);
    return (await response.json()) as T;
  }
}
