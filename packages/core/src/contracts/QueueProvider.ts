import type { FailureReason } from '../errors.ts';

/**
 * ── QUEUE BACKEND SEAM ───────────────────────────────────────────────────────
 * The runner talks only to this interface, so replacing the local JSON adapter
 * with Postgres, Redis, SQS or an Orchestrator-compatible service is a new class
 * and one line of wiring. No automation changes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type TransactionStatus =
  | 'new'
  | 'inProgress'
  | 'success'
  | 'failed'
  /** Left mid-flight by a crash. A real backend reclaims these via lease expiry. */
  | 'abandoned';

export type Priority = 'low' | 'normal' | 'high';

/** Mirrors an Orchestrator queue item. `payload` is REFramework's SpecificContent. */
export interface QueueItem<TPayload = unknown> {
  readonly id: string;
  /** Business key, e.g. "SUB-1001". Used in logs and artifact paths. */
  readonly reference: string;
  readonly priority: Priority;
  readonly payload: TPayload;
  status: TransactionStatus;
  /** REFramework's RetryNo. Incremented only by System exceptions. */
  retryCount: number;
  readonly createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /**
   * Seam for multi-worker backends. The local single-worker adapter sets it for
   * observability but never enforces expiry - there is no second worker to steal
   * the item from.
   */
  leaseUntil?: string;
  lastError?: { type: FailureReason; message: string; at: string };
}

export interface QueueStats {
  total: number;
  new: number;
  inProgress: number;
  success: number;
  failed: number;
  abandoned: number;
}

export interface QueueProvider {
  init(): Promise<void>;

  /**
   * REFramework's GetTransactionItem. Atomically leases the next item and marks
   * it inProgress. Returns null when the queue is drained, which is the runner's
   * signal to move to EndProcess.
   */
  getNext(): Promise<QueueItem | null>;

  /** SetTransactionStatus(Successful). */
  complete(item: QueueItem): Promise<void>;

  /** SetTransactionStatus(Failed, Business|System) - terminal, no further retry. */
  fail(item: QueueItem, reason: FailureReason, error: Error): Promise<void>;

  /**
   * Records one consumed System-exception attempt. Divergence from UiPath worth
   * knowing: Orchestrator would mint a NEW queue item here, carrying RetryNo.
   * This POC retries the same item in place, so the item stays inProgress and
   * only retryCount moves. A backend that wants Orchestrator's semantics
   * implements them behind this method.
   */
  requeue(item: QueueItem): Promise<QueueItem>;

  stats(): Promise<QueueStats>;

  close(): Promise<void>;
}
