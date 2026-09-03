export interface RunSummary {
  runId: string;
  automationId: string;
  env: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Transactions that reached a terminal status. Retries are not counted here. */
  processed: number;
  success: number;
  business: number;
  system: number;
  /** Total retry attempts consumed across all transactions. */
  retries: number;
  stopRequested: boolean;
  aborted: boolean;
  abortReason: string | undefined;
}

/**
 * Exit codes are the contract with whatever schedules this later (cron,
 * Kubernetes Job, Airflow, the future orchestrator), so they are deliberately
 * narrow and stable.
 */
export const EXIT_CODES = {
  /** Everything terminal, no system-level failures. Business failures are a normal outcome. */
  ok: 0,
  /** At least one transaction exhausted its retries. The queue needs attention. */
  systemFailures: 1,
  /** Initialize failed. No transaction was touched. */
  initFailed: 2,
  /** Circuit breaker tripped: the target system looks down. */
  abortedUnstable: 3,
} as const;

export function exitCodeFor(summary: RunSummary): number {
  if (summary.aborted) return EXIT_CODES.abortedUnstable;
  if (summary.system > 0) return EXIT_CODES.systemFailures;
  return EXIT_CODES.ok;
}

export function formatSummary(summary: RunSummary): string {
  const seconds = (summary.durationMs / 1000).toFixed(1);
  const lines = [
    `${summary.automationId}  (run ${summary.runId}, env ${summary.env})`,
    `  processed : ${summary.processed}`,
    `  success   : ${summary.success}`,
    `  business  : ${summary.business}`,
    `  system    : ${summary.system}`,
    `  retries   : ${summary.retries}`,
    `  duration  : ${seconds}s`,
  ];
  if (summary.stopRequested) lines.push('  stopped   : yes (graceful stop requested)');
  if (summary.aborted) lines.push(`  aborted   : ${summary.abortReason ?? 'unknown'}`);
  return lines.join('\n');
}
