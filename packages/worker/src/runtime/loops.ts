import { setTimeout as delay } from 'node:timers/promises';

export const defaultReconnect = { initialDelay: 1000, maxDelay: 30000 };
type ReconnectPolicy = typeof defaultReconnect;
export async function runLoop(
  task: () => Promise<unknown> | void,
  interval: () => number,
  policy: () => ReconnectPolicy | undefined,
  signal: AbortSignal,
  onError: (error: unknown) => void,
) {
  let failureDelay = 0;
  while (!signal.aborted) {
    try {
      await task();
      failureDelay = 0;
    } catch (error) {
      onError(error);
      const reconnect = policy() ?? defaultReconnect;
      failureDelay = Math.min(
        failureDelay ? failureDelay * 2 : reconnect.initialDelay,
        reconnect.maxDelay,
      );
    }
    await delay(failureDelay || interval(), undefined, { signal }).catch(() => {});
  }
}
