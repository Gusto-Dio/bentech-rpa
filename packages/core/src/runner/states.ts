/**
 * REFramework's Main state machine, kept explicit so the mapping from a UiPath
 * process is obvious when reading the logs:
 *
 *   Initialize ──▶ GetTransactionData ──▶ ProcessTransaction ──┐
 *                        ▲                                     │
 *                        └─────────────── (next item) ─────────┘
 *                        │
 *                        └──▶ EndProcess   (queue drained, stop requested,
 *                                           or circuit breaker tripped)
 */
export type RunnerState =
  | 'Initialize'
  | 'GetTransactionData'
  | 'ProcessTransaction'
  | 'EndProcess';

/** Per-transaction outcome, in REFramework's vocabulary. */
export type TransactionOutcome = 'success' | 'business' | 'system';

export const TRANSACTION_LOG_STATUS: Readonly<Record<TransactionOutcome, string>> = {
  success: 'SUCCESS',
  business: 'BUSINESS_EXCEPTION',
  system: 'SYSTEM_EXCEPTION',
};
