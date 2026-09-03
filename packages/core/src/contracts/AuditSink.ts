import type { Logger } from 'pino';

/**
 * ── GOVERNANCE / AUDIT SEAM ──────────────────────────────────────────────────
 * Every state change an auditor would ask about is emitted here. Today it goes
 * to the structured log; later the same stream feeds an append-only store, so
 * "which automation touched this group, when, and what did it decide" is a
 * query rather than an archaeology project.
 *
 * `detail` must never carry credentials or PII. Emit identifiers, not records.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type AuditEventType =
  | 'run.started'
  | 'run.finished'
  | 'run.aborted'
  | 'transaction.started'
  | 'transaction.succeeded'
  | 'transaction.business_failed'
  | 'transaction.system_failed'
  | 'transaction.retry_scheduled'
  | 'session.recovered';

export interface AuditEvent {
  at: string;
  runId: string;
  automationId: string;
  type: AuditEventType;
  reference?: string;
  transactionId?: string;
  attempt?: number;
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

/** Default sink: audit events as structured log lines tagged `audit: true`. */
export class LoggerAuditSink implements AuditSink {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async emit(event: AuditEvent): Promise<void> {
    this.#logger.info({ audit: true, ...event }, `audit:${event.type}`);
  }

  async close(): Promise<void> {
    // Nothing buffered. A real sink flushes here.
  }
}
