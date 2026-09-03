import type { RunSummary, WebInitContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';

export async function endProcess(
  ctx: WebInitContext<AutomationConfig>,
  summary: RunSummary,
): Promise<void> {
  if (summary.business > 0) {
    ctx.logger.warn(
      { needsReview: summary.business },
      'Submissions were stopped by business rules and need a human - check the artifacts',
    );
  }

  ctx.logger.info(
    {
      submitted: summary.success,
      declined: summary.business,
      failed: summary.system,
      retries: summary.retries,
      allowSubmit: ctx.config.automation.allowSubmit,
    },
    'Anthem CA new-plan run complete',
  );
}
