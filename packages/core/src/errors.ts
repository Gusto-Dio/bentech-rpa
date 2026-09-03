/**
 * The Business / System split is the single most important contract in this
 * framework, exactly as it is in UiPath's REFramework:
 *
 *   BusinessException -> the data or the business rules say "no". Retrying will
 *                        produce the identical answer, so the transaction is
 *                        marked failed immediately and the run moves on.
 *   SystemException   -> the environment misbehaved (app down, timeout, stale
 *                        session). A retry might succeed, so the runner retries
 *                        after recovering the session.
 *
 * Anything thrown that is NOT a BusinessException is treated as a System error.
 * That default is deliberate: an unrecognised failure is far more likely to be a
 * broken environment than a business rule, and retrying a business rule is
 * merely wasteful whereas failing a recoverable transaction loses work.
 */

export type FailureReason = 'business' | 'system';

export interface AutomationErrorOptions {
  cause?: unknown;
  /** Structured context for logs and artifacts. Must not contain secrets or PII. */
  details?: Record<string, unknown>;
}

export abstract class AutomationError extends Error {
  abstract readonly reason: FailureReason;

  readonly details: Record<string, unknown>;

  constructor(message: string, options: AutomationErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details ?? {};
  }
}

/** A business rule was violated. Never retried. */
export class BusinessException extends AutomationError {
  override readonly reason = 'business';
}

/** The environment failed. Retried up to maxRetries, with session recovery. */
export class SystemException extends AutomationError {
  override readonly reason = 'system';
}

/**
 * `instanceof` is sound here because the workspace enforces a single version of
 * @rpa/core (`workspace:*`), so there is exactly one class identity in the
 * process. If core is ever published and pinned per automation, this needs a
 * `Symbol.for()` brand instead.
 */
export function isBusinessException(value: unknown): value is BusinessException {
  return value instanceof BusinessException;
}

export function isSystemException(value: unknown): value is SystemException {
  return value instanceof SystemException;
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  return new Error(`Non-error value thrown: ${safeStringify(value)}`);
}

/** The runner's only classification point. */
export function classifyError(value: unknown): { reason: FailureReason; error: Error } {
  const error = toError(value);
  return { reason: isBusinessException(error) ? 'business' : 'system', error };
}

export interface SerializedError {
  name: string;
  message: string;
  reason: FailureReason;
  stack: string | undefined;
  details: Record<string, unknown> | undefined;
  cause: string | undefined;
}

/** Shape written to artifacts/<run>/<tx>/error.json. */
export function serializeError(value: unknown): SerializedError {
  const { reason, error } = classifyError(value);
  const details = error instanceof AutomationError ? error.details : undefined;
  const cause = error.cause === undefined ? undefined : safeStringify(error.cause);
  return { name: error.name, message: error.message, reason, stack: error.stack, details, cause };
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
