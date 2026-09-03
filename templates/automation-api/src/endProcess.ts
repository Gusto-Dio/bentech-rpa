import type { InitContext, RunSummary } from '@rpa/core';
import type { AutomationConfig } from './config.ts';

export async function endProcess(
  ctx: InitContext<AutomationConfig>,
  summary: RunSummary,
): Promise<void> {
  ctx.logger.info(
    { success: summary.success, business: summary.business, system: summary.system },
    'Finished __AUTOMATION_NAME__',
  );
}
