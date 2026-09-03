import { assertHasRequestedItems, assertValidGroupId } from '@auto/group-submission-shared';
import { BusinessException, SystemException, withRetry, type WebTxContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';
import type { Payload } from './payload.ts';
import { PlanCatalogPage } from './pages/plan-catalog.page.ts';
import { SubmissionFormPage } from './pages/submission-form.page.ts';
import { SubmissionReviewPage } from './pages/submission-review.page.ts';
import { SubmissionSummaryPage } from './pages/submission-summary.page.ts';

/**
 * One group's submission, start to finish.
 *
 * The Business / System split is the thing to read for here:
 *   - a plan the carrier does not offer, or a total needing human approval,
 *     is a BusinessException -> failed immediately, no retry, next group.
 *   - a portal that stalls, a page that never renders, an unreadable total,
 *     is a SystemException -> screenshot, trace, browser relaunched,
 *     re-authenticated, and this same group tried again.
 */
export async function processTransaction(
  ctx: WebTxContext<Payload, AutomationConfig>,
): Promise<void> {
  const { groupId, groupName, contact, requestedPlans } = ctx.item.payload;
  const { approvalThresholdCents } = ctx.config.automation;

  // Cheap business rules first: no reason to drive a browser to discover that
  // the payload was never submittable.
  assertValidGroupId(groupId);
  assertHasRequestedItems(requestedPlans);

  const catalog = new PlanCatalogPage(ctx.page);
  const review = new SubmissionReviewPage(ctx.page);
  const form = new SubmissionFormPage(ctx.page);
  const summary = new SubmissionSummaryPage(ctx.page);

  // Start from a known page, every time. The previous transaction finished on
  // the confirmation screen, and a retry may have left a half-built draft
  // behind - neither is a safe place to begin.
  await catalog.open(ctx.config.automation.portalUrl);
  await catalog.resetDraftSubmission();

  /**
   * withRetry is REFramework's RetryScope: it retries ONE action. The catalog
   * is the slowest thing this portal renders, and a single slow render should
   * cost a few seconds - not one of the transaction's System-exception retries,
   * which would tear down and relaunch the whole browser.
   */
  const availablePlans = await withRetry(() => catalog.listAvailablePlans(), {
    attempts: 3,
    label: 'read carrier plan catalog',
    logger: ctx.logger,
    abortSignal: ctx.stop.abortSignal,
  });

  // BUSINESS: the carrier does not offer what was requested. Retrying cannot
  // change the catalog, so this group is done.
  const unavailable = requestedPlans.filter((plan) => !availablePlans.includes(plan));
  if (unavailable.length > 0) {
    throw new BusinessException(
      `Carrier does not offer: ${unavailable.join(', ')}`,
      { details: { groupId, unavailable, availablePlans } },
    );
  }

  for (const plan of requestedPlans) {
    await catalog.addPlan(plan);
  }

  // SYSTEM: the portal accepted the clicks but did not record them. Retrying
  // against a fresh session is exactly the right response.
  const draftLines = await catalog.draftLineCount();
  if (draftLines !== requestedPlans.length) {
    throw new SystemException(
      `Draft submission holds ${draftLines} lines but ${requestedPlans.length} were added`,
      { details: { groupId, draftLines, expected: requestedPlans.length } },
    );
  }

  await catalog.openDraftSubmission();

  const reviewedLines = await review.lineCount();
  if (reviewedLines !== requestedPlans.length) {
    throw new SystemException(
      `Review page shows ${reviewedLines} lines, expected ${requestedPlans.length}`,
    );
  }

  simulateInfrastructureFault(ctx);

  await review.beginSubmission();
  await form.fillContact(contact);
  await form.continue();

  // BUSINESS: the portal itself declined the contact details. Its answer will
  // be the same next time.
  const validationError = await form.validationError();
  if (validationError !== undefined) {
    throw new BusinessException(`Carrier rejected the submission contact: ${validationError}`, {
      details: { groupId },
    });
  }

  const totalCents = await summary.readTotalCents();

  // BUSINESS: a config-driven rule. Above the threshold this needs a human, so
  // the automation must stop short of submitting.
  if (totalCents > approvalThresholdCents) {
    throw new BusinessException(
      `Quoted total ${formatUsd(totalCents)} exceeds the ${formatUsd(approvalThresholdCents)} approval threshold`,
      { details: { groupId, totalCents, approvalThresholdCents } },
    );
  }

  await summary.submit();
  const confirmation = await summary.confirmation();

  ctx.logger.info(
    { groupId, groupName, plans: requestedPlans.length, totalCents, confirmation },
    'Submission accepted by the carrier',
  );
}

/**
 * DEMO SCAFFOLDING ONLY - delete this when copying the automation.
 *
 * Injected here, mid-flow, rather than at the top of the function: failing
 * after the draft is built means the screenshot and trace captured by the
 * framework show a real half-finished submission, which is what a genuine
 * system failure looks like when you open the artifacts the next morning.
 */
function simulateInfrastructureFault(ctx: WebTxContext<Payload, AutomationConfig>): void {
  const fault = ctx.item.payload.injectFault;
  if (fault === undefined) return;

  const failThisAttempt = fault === 'system-always' || ctx.attempt === 1;
  if (!failThisAttempt) {
    ctx.logger.info({ attempt: ctx.attempt }, 'Simulated fault cleared; proceeding');
    return;
  }

  throw new SystemException(
    `Simulated carrier portal outage (injectFault: ${fault}, attempt ${ctx.attempt})`,
    { details: { injectFault: fault, attempt: ctx.attempt } },
  );
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
