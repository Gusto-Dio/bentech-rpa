import type { Logger } from 'pino';
import { BusinessException, isBusinessException, toError } from './errors.ts';

export interface BackoffPolicy {
  baseMs: number;
  factor: number;
  maxMs: number;
}

/** Exponential with full jitter. Jitter matters once several automations retry against the same portal. */
export function computeBackoff(policy: BackoffPolicy, retryNumber: number): number {
  const exponential = policy.baseMs * policy.factor ** Math.max(0, retryNumber - 1);
  const capped = Math.min(exponential, policy.maxMs);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

/** Resolves early when the stop signal fires, so SIGTERM is not held up by a backoff. */
export function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0 || abortSignal?.aborted === true) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    abortSignal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Wall-clock guard around one promise.
 *
 * Racing does not cancel the work behind it - Playwright has no cancellation
 * token. What makes it safe in this framework is what happens next: a timeout is
 * a SystemException, so the session is torn down and relaunched, which unblocks
 * anything still stuck in the old browser.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  describe: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(describe()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface WithRetryOptions {
  /** Total attempts, including the first. `attempts: 3` means 1 try + 2 retries. */
  attempts: number;
  label: string;
  delayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  logger?: Logger;
  abortSignal?: AbortSignal;
  /** Extra veto on top of the built-in "never retry BusinessException". */
  retryOn?: (error: Error) => boolean;
}

/**
 * REFramework's RetryScope: retries ONE action, not the transaction.
 *
 * This is the right tool for a single flaky step - a slow-rendering grid, a
 * portal that 502s on first contact - because it costs a few seconds instead of
 * burning one of the transaction's System-exception retries, which would also
 * tear down and relaunch the browser.
 *
 * Never retries a BusinessException: if the rule was violated, it stays violated.
 */
export async function withRetry<T>(action: () => Promise<T>, options: WithRetryOptions): Promise<T> {
  const policy: BackoffPolicy = {
    baseMs: options.delayMs ?? 500,
    factor: options.factor ?? 2,
    maxMs: options.maxDelayMs ?? 5_000,
  };

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await action();
    } catch (thrown) {
      const error = toError(thrown);

      if (isBusinessException(error)) throw error;
      if (options.retryOn !== undefined && !options.retryOn(error)) throw error;

      lastError = error;
      const isLast = attempt === options.attempts;

      options.logger?.warn(
        { action: options.label, attempt, attempts: options.attempts, err: error },
        isLast ? `Action "${options.label}" failed on the final attempt` : `Action "${options.label}" failed, retrying`,
      );

      if (isLast) break;
      if (options.abortSignal?.aborted === true) break;

      await sleep(computeBackoff(policy, attempt), options.abortSignal);
    }
  }

  throw lastError ?? new BusinessException(`Action "${options.label}" produced no result and no error`);
}
