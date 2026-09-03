import { BusinessException, SystemException, type AutomationError } from '../errors.ts';

/**
 * Maps Orchestrator HTTP responses onto the framework's Business / System
 * split. This mapping is the whole reason the rest of the framework needs no
 * Orchestrator awareness: by the time an error reaches the runner it is already
 * either "the data was rejected" or "the environment misbehaved".
 */

/** Orchestrator's error envelope. Both shapes are seen in the wild. */
export interface OrchestratorErrorBody {
  message?: string;
  errorCode?: number;
  traceId?: string;
  /** OData-style envelope, used by some endpoints. */
  error?: { code?: string; message?: string };
}

export interface OrchestratorHttpFailure {
  status: number;
  statusText: string;
  method: string;
  /** Path only, never the full URL with query - queries can carry identifiers. */
  path: string;
  body: OrchestratorErrorBody | undefined;
  rawBody: string | undefined;
  attempt: number;
  /** Present instead of a status when the request never completed. */
  networkError?: unknown;
}

/**
 * TODO(orchestrator): confirm the duplicate-reference error code on your
 * version. 1002 is the commonly reported value for "queue item already exists
 * with the same reference", but it has moved between releases. Until confirmed,
 * the status-based mapping below already routes 409 to BusinessException, so a
 * wrong code here degrades gracefully rather than misclassifying.
 */
export const DUPLICATE_REFERENCE_ERROR_CODES: ReadonlySet<number> = new Set([1002]);

/**
 * Retry only where a retry could plausibly succeed.
 *
 * 408 and 429 are explicitly transient; 5xx is the server's problem, not the
 * request's. Everything else is deterministic: the same request will be
 * rejected the same way, so retrying only wastes the queue's time.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Statuses that mean "Orchestrator looked at the payload and said no".
 *
 * Trade-off worth knowing: a 400 can also mean *this client* built a bad
 * request, which is a code defect rather than a business rule. Both are mapped
 * to BusinessException because both are non-retryable and must surface
 * immediately - but the log carries status and errorCode so a spike of these
 * reads as "we are sending bad requests", not "the business rejected work".
 * Unknown 4xx values deliberately fall through to SystemException instead.
 */
function isBusinessStatus(status: number): boolean {
  return status === 400 || status === 409 || status === 422;
}

export function mapOrchestratorError(failure: OrchestratorHttpFailure): AutomationError {
  const details: Record<string, unknown> = {
    method: failure.method,
    path: failure.path,
    attempt: failure.attempt,
  };

  if (failure.networkError !== undefined) {
    const cause = failure.networkError;
    return new SystemException(
      `Orchestrator request failed before a response: ${failure.method} ${failure.path}`,
      { cause, details },
    );
  }

  details['status'] = failure.status;
  if (failure.body?.errorCode !== undefined) details['errorCode'] = failure.body.errorCode;
  if (failure.body?.traceId !== undefined) details['traceId'] = failure.body.traceId;

  const summary = describeOrchestratorError(failure);

  if (isDuplicateReference(failure)) {
    return new BusinessException(`Queue item reference already exists in Orchestrator: ${summary}`, {
      details: { ...details, duplicateReference: true },
    });
  }

  if (isBusinessStatus(failure.status)) {
    return new BusinessException(`Orchestrator rejected the request: ${summary}`, { details });
  }

  return new SystemException(`Orchestrator request failed: ${summary}`, { details });
}

export function isDuplicateReference(failure: OrchestratorHttpFailure): boolean {
  if (failure.status !== 409 && failure.status !== 400) return false;
  const code = failure.body?.errorCode;
  if (code !== undefined && DUPLICATE_REFERENCE_ERROR_CODES.has(code)) return true;
  // Status 409 on a queue-item write is a conflict, which for AddQueueItem can
  // only be the unique-reference constraint.
  return failure.status === 409;
}

export function describeOrchestratorError(failure: OrchestratorHttpFailure): string {
  const message = failure.body?.message ?? failure.body?.error?.message;
  const parts = [`${failure.status} ${failure.statusText}`, `${failure.method} ${failure.path}`];
  if (message !== undefined && message.length > 0) parts.push(message);
  else if (failure.rawBody !== undefined && failure.rawBody.length > 0) {
    parts.push(failure.rawBody.slice(0, 300));
  }
  if (failure.body?.errorCode !== undefined) parts.push(`errorCode=${failure.body.errorCode}`);
  return parts.join(' - ');
}

export function parseErrorBody(raw: string | undefined): OrchestratorErrorBody | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as OrchestratorErrorBody) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Honours Retry-After on 429, capped. An uncapped server-supplied delay can
 * stall an unattended run past its scheduling window.
 */
export function parseRetryAfterMs(header: string | null, capMs: number): number | undefined {
  if (header === null) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, capMs);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 0), capMs);
}
