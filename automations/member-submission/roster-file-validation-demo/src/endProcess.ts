import type { InitContext, RunSummary } from '@rpa/core';
import type { AutomationConfig } from './config.ts';

export async function endProcess(
  ctx: InitContext<AutomationConfig>,
  summary: RunSummary,
): Promise<void> {
  if (summary.business > 0) {
    ctx.logger.warn(
      { rejected: summary.business },
      'Elections were rejected by eligibility rules and need correcting upstream',
    );
  }

  ctx.logger.info(
    {
      validated: summary.success,
      rejected: summary.business,
      failed: summary.system,
      retries: summary.retries,
    },
    'Roster validation run complete',
  );
}
