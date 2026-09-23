import type { RunSummary, WebInitContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';

/**
 * Runs once, after the queue is drained or the run is stopped.
 *
 * The framework already closes the browser, writes run-summary.json and logs
 * the totals - so this is for automation-specific finishing work: a
 * notification, an outbound report, a sign-out that the target system requires.
 */
export async function endProcess(
  ctx: WebInitContext<AutomationConfig>,
  summary: RunSummary,
): Promise<void> {
  ctx.logger.info(
    {
      success: summary.success,
      business: summary.business,
      system: summary.system,
    },
    'Finished Bcbs Ma Packets',
  );
}
