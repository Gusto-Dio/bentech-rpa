import {
  assertFirstOfMonth,
  assertKnownPlanCode,
  assertWithinEnrollmentWindow,
} from '@auto/member-submission-shared';
import { SystemException, type TxContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';
import type { Payload } from './payload.ts';
import { getPlanCodes } from './state.ts';

/**
 * Validates one member's election.
 *
 * Every rule here throws BusinessException, because every one of them is a
 * decision about the data: the plan does not exist, the date is not the first
 * of a month, the date is too far out. None of those change on a retry, so the
 * transaction is marked failed and the run moves on immediately.
 *
 * The System path is reached only by the injected fault below and by genuine
 * infrastructure trouble - a locked file, an unreachable source system.
 */
export async function processTransaction(
  ctx: TxContext<Payload, AutomationConfig>,
): Promise<void> {
  const { memberRef, planCode, effectiveDate, coverageTier } = ctx.item.payload;
  const { maxMonthsAhead } = ctx.config.automation;

  simulateSourceSystemFault(ctx);

  assertKnownPlanCode(planCode, getPlanCodes(ctx), memberRef);
  assertFirstOfMonth(effectiveDate, memberRef);
  assertWithinEnrollmentWindow(effectiveDate, maxMonthsAhead, memberRef);

  ctx.logger.info(
    { memberRef, planCode, effectiveDate, coverageTier },
    'Election validated and accepted',
  );
}

/**
 * DEMO SCAFFOLDING ONLY - delete this when copying the automation.
 *
 * Proves the retry path works identically without a browser. `recover()` is a
 * no-op for sessionKind "none": there is no stateful application to relaunch,
 * so the backoff and the retry are themselves the recovery.
 */
function simulateSourceSystemFault(ctx: TxContext<Payload, AutomationConfig>): void {
  const fault = ctx.item.payload.injectFault;
  if (fault === undefined) return;

  const failThisAttempt = fault === 'system-always' || ctx.attempt === 1;
  if (!failThisAttempt) {
    ctx.logger.info({ attempt: ctx.attempt }, 'Simulated fault cleared; proceeding');
    return;
  }

  throw new SystemException(
    `Simulated source system timeout (injectFault: ${fault}, attempt ${ctx.attempt})`,
    { details: { injectFault: fault, attempt: ctx.attempt } },
  );
}
