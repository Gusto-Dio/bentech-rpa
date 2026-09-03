import { assertOwnershipTotals100, findBasePolicy } from '@auto/group-submission-shared';
import { BusinessException, type StepContext, type WebTxContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';
import type { Payload } from './payload.ts';
import { CaseStartPage } from './pages/case-start.page.ts';
import {
  AttestationPage,
  EmployeeCensusPage,
  EmployerApplicationPage,
  EmployerInformationPage,
  PlanSelectionPage,
} from './pages/remaining-screens.page.ts';

/**
 * One group's UHC new-plan submission.
 *
 * The PoC boundary is the END of the employer application (stage 8). Employee
 * enrollment, direct-debit billing, required-document upload and Finalize are
 * explicitly out of scope - see docs/poc/uhc-np-new-plans/README.md.
 *
 * Stages 1-2 are wired; 3-8 are mapped and throw, naming the stage to build.
 */
export async function processTransaction(
  ctx: WebTxContext<Payload, AutomationConfig>,
): Promise<void> {
  const payload = ctx.item.payload;

  // ── Cheap payload rules first, before a browser does any work. ──
  assertOwnershipTotals100(payload.owners);
  const basePolicy = findBasePolicy(payload.policies);

  const steps: StepContext = {
    logger: ctx.logger,
    onGateFailure: async ({ step: stepName, gate }) => {
      ctx.logger.warn({ step: stepName, gate }, 'Capturing evidence for a failed gate');
      // TODO(prompt): write to ctx.paths.runArtifactsDir named
      // `<reference>-<step>-<gate>.png`.
    },
  };

  const config = ctx.config.automation;

  // ── Stage 1-2: dashboard, resume-or-create, owner assignment ──
  const caseStart = new CaseStartPage(ctx.page, steps, config);
  await caseStart.openNewBusinessDashboard();

  /**
   * The resume path the runbook itself describes. Creating a second case for a
   * group that already has one is the single worst failure available here, so
   * the search result gates creation rather than relying on a skip-ahead.
   */
  const existing = await caseStart.findExistingCase(payload);
  if (existing) {
    ctx.logger.info(
      { companyName: payload.companyName },
      'A case already exists for this group; resuming it rather than creating a second one',
    );
  } else {
    await caseStart.createNewCase();
  }

  await caseStart.assignOwner();

  // ── Stage 3-7: mapped, not implemented ──
  const employer = new EmployerInformationPage(ctx.page, steps);
  await employer.fillEmployerInformation(payload);
  await employer.fillCompanyLocations(payload);
  await employer.fillPrimaryContact(payload);
  await employer.selectProductsToQuote(payload);

  const census = new EmployeeCensusPage(ctx.page, steps);
  const templatePath = await census.downloadBulkCensusTemplate(ctx.paths.runArtifactsDir);
  await census.uploadBulkCensus(templatePath, payload.eligibleEEs);

  const plans = new PlanSelectionPage(ctx.page, steps);
  await plans.confirmRatingMethod(payload);
  await plans.selectPlansWithRiders(payload);
  await plans.confirmRatingMethod(payload); // the runbook insists: before AND after
  await plans.setEmployerContribution(payload);
  const proposalPdf = await plans.enterTinAndGenerateProposal(payload, ctx.paths.runArtifactsDir);
  await plans.moveToEnrollment();

  const application = new EmployerApplicationPage(ctx.page, steps, config);
  await application.fillGeneralInformation(payload);
  await application.fillEligibilityInformation(payload);
  await application.fillWaitingPeriod(payload);
  await application.fillContributionAndParticipation(payload);
  await application.fillConsumerDrivenAndAdditionalEligibility(payload);
  await application.fillCurrentCarrierInformation(payload);
  await application.fillProducer();

  // ── Stage 8: attestation. Guarded, because it signs on the producer's behalf. ──
  if (!config.allowSubmit) {
    throw new BusinessException(
      'Reached the attestation step with allowSubmit=false, so stopping before signing. ' +
        'This is the PoC safety boundary: an attestation is signed on the producer\'s behalf ' +
        'against the production portal. Everything up to here completed.',
      { details: { companyName: payload.companyName, basePlanCode: basePolicy.planCode, proposalPdf } },
    );
  }

  const attestation = new AttestationPage(ctx.page, steps, config);
  await attestation.submitAttestation();
  const applicationPdf = await attestation.downloadCompletedApplication(ctx.paths.runArtifactsDir);

  ctx.logger.info(
    { companyName: payload.companyName, proposalPdf, applicationPdf },
    'UHC employer application completed',
  );
}
