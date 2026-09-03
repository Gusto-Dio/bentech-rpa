import type { RunSummary, WebInitContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';

/**
 * Runs once, after the queue drains or the run is stopped.
 *
 * The framework has already closed the browser, written run-summary.json and
 * logged the totals, so this is only for automation-specific finishing work.
 * In production this is where a "N groups submitted, M need review" notice
 * would go out to the team that owns the queue.
 */
export async function endProcess(
  ctx: WebInitContext<AutomationConfig>,
  summary: RunSummary,
): Promise<void> {
  if (summary.business > 0) {
    ctx.logger.warn(
      { needsReview: summary.business },
      'Submissions were declined by business rules and need a human review',
    );
  }

  ctx.logger.info(
    {
      submitted: summary.success,
      declined: summary.business,
      failed: summary.system,
      retries: summary.retries,
    },
    'Carrier portal submission run complete',
  );
}
