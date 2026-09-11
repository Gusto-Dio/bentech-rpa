import {
  assertOwnershipTotals100,
  findBasePolicy,
  HippoCensusReader,
} from '@auto/group-submission-shared';
import { BusinessException, type WebTxContext } from '@rpa/core';
import path from 'node:path';
import { buildBulkCensusRows } from './census/bulk-census.ts';
import { writeBulkCensus } from './census/write-template.ts';
import type { AutomationConfig } from './config.ts';
import {
  contributionPercentage,
  employerContribution,
  totalApplying,
} from './derived.ts';
import { createStepContext, describeCurrentScreen } from './gate-evidence.ts';
import { AttestationPage } from './pages/attestation.page.ts';
import { CaseStartPage } from './pages/case-start.page.ts';
import { EmployeeCensusPage } from './pages/employee-census.page.ts';
import { EmployerApplicationPage } from './pages/employer-application.page.ts';
import { EmployerInformationPage } from './pages/employer-information.page.ts';
import { PlanSelectionPage } from './pages/plan-selection.page.ts';
import type { Payload } from './payload.ts';
import { resolveProducerIdentity } from './producer-identity.ts';

/**
 * One group's UHC new-plan submission.
 *
 * The PoC boundary is the END of the employer application (stage 8). Employee
 * enrollment, direct-debit billing, required-document upload and Finalize are
 * explicitly out of scope - see docs/poc/uhc-np-new-plans/README.md.
 *
 * Reads top to bottom as the runbook does, which is the point: this function is
 * the audit trail. The decisions live in derived.ts, the portal's words live in
 * pages/samx-options.ts, and the locators live in pages/. Nothing is computed
 * here that a unit test could not otherwise reach.
 */
export async function processTransaction(
  ctx: WebTxContext<Payload, AutomationConfig>,
): Promise<void> {
  const payload = ctx.item.payload;
  const config = ctx.config.automation;

  // ── Cheap payload rules first, before a browser does any work. ──
  assertOwnershipTotals100(payload.owners);
  const basePolicy = findBasePolicy(payload.policies);

  const steps = createStepContext(ctx);

  /**
   * A real licensed producer and agency, resolved from the environment rather
   * than read out of config. See producer-identity.ts and
   * docs/poc/sanitization.md.
   */
  const producer = await resolveProducerIdentity(ctx.secrets, config);

  /**
   * The census is read before the browser is touched. It is the input that
   * decides the headcounts typed on three separate screens, and a census that
   * cannot be read is a Business failure worth discovering in a second rather
   * than after a sign-in and an MFA code.
   */
  const reader = new HippoCensusReader();
  const censusFile = path.isAbsolute(payload.censusFile)
    ? payload.censusFile
    : path.join(ctx.paths.automationDir, payload.censusFile);
  const split = reader.splitByEnrollment(await reader.read(censusFile));
  const applying = totalApplying(split.enrolling);

  ctx.logger.info(
    {
      enrolling: split.enrolling.length,
      waiving: split.waiving.length,
      employeesApplying: applying,
      eligibleEEs: payload.eligibleEEs,
    },
    'Read the Hippo census',
  );

  // ── Stage 1-2: dashboard, resume-or-create, owner assignment ──
  const caseStart = new CaseStartPage(ctx.page, steps);
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

  await caseStart.assignOwner(producer);

  // ── Stage 3: employer information, locations, contact, products ──
  const employer = new EmployerInformationPage(ctx.page, steps);
  await employer.fillEmployerInformation(payload);
  await employer.fillCompanyLocations(payload, applying);
  await employer.fillPrimaryContact(payload);
  await employer.selectProductsToQuote(payload);
  await employer.openEmployeeCensus();

  // ── Stage 4: the bulk census. The upload is all-or-nothing. ──
  const census = new EmployeeCensusPage(ctx.page, steps);
  const templatePath = await census.downloadBulkCensusTemplate(ctx.paths.runArtifactsDir);
  const censusRows = buildBulkCensusRows(split);
  const filledCensus = path.join(ctx.paths.runArtifactsDir, 'samx-bulk-census-filled.xlsx');
  await writeBulkCensus(templatePath, filledCensus, censusRows);
  await census.uploadBulkCensus(filledCensus, applying);
  await census.openPlanSelection();

  // ── Stage 5: plan selection, contribution, TIN, proposal ──
  const plans = new PlanSelectionPage(ctx.page, steps);
  await plans.confirmRatingMethod(payload);
  await plans.selectPlansWithRiders(payload);
  // The runbook insists: before AND after. It has silently reset on somebody.
  await plans.confirmRatingMethod(payload);
  await plans.confirmPlansOnQuoteReview(payload);

  /**
   * Computed and logged before it is typed, so the log records WHICH rule
   * produced the number. Both of the runbook's overrides deliberately enter
   * something other than the quoted figure, and a log line carrying only the
   * result makes them impossible to audit afterwards.
   */
  const contribution = employerContribution(payload, basePolicy, applying);
  ctx.logger.info(
    {
      rule: contribution.rule,
      percentage: contribution.percentage,
      quoted: basePolicy.eeContribution,
      basePlanCode: basePolicy.planCode,
    },
    contribution.note ?? 'Employer contribution entered as quoted',
  );

  await plans.setEmployerContribution(
    contribution,
    contributionPercentage(basePolicy.dependentContribution, 'dependentContribution'),
  );
  const contributionEvidence = await plans.captureContributionEvidence(
    ctx.item.reference,
    ctx.paths.runArtifactsDir,
  );

  const proposalPdf = await plans.enterTinAndGenerateProposal(payload, ctx.paths.runArtifactsDir);
  await plans.moveToEnrollment();

  // ── Stage 6-7: the employer application ──
  const application = new EmployerApplicationPage(ctx.page, steps);
  await application.fillGeneralInformation(payload, new Date());
  await application.fillEligibilityInformation(payload);
  await application.fillWaitingPeriod(payload, basePolicy.waitingPeriod);
  await application.fillContributionAndParticipation(payload);
  await application.fillConsumerDrivenAndAdditionalEligibility(payload);
  await application.fillCurrentCarrierInformation();
  await application.fillProducer(producer, config.commissionPercentage);
  await application.waitForAttestationStep(payload);

  /**
   * The attestation screen has never been seen. Recording it costs nothing here
   * and this is the one chance to look at it - reaching this point takes a
   * sign-in, an MFA code and a real case on a production portal.
   */
  await describeCurrentScreen(ctx, ctx.page, 'attestation-screen');

  // ── Stage 8: attestation. Guarded, because it signs on the producer's behalf. ──
  if (!config.allowSubmit) {
    throw new BusinessException(
      'Reached the attestation step with allowSubmit=false, so stopping before signing. ' +
        'This is the PoC safety boundary: an attestation is signed on the producer\'s behalf ' +
        'against the production portal. Everything up to here completed.',
      {
        details: {
          companyName: payload.companyName,
          basePlanCode: basePolicy.planCode,
          employeesApplying: applying,
          contributionRule: contribution.rule,
          proposalPdf,
          contributionEvidence,
        },
      },
    );
  }

  const attestation = new AttestationPage(ctx.page, steps, config);
  await attestation.acknowledgeAttestations();
  await attestation.signAsProducer(producer);
  await attestation.submitAttestation();
  const applicationPdf = await attestation.downloadCompletedApplication(
    ctx.paths.runArtifactsDir,
    ctx.item.reference,
  );

  ctx.logger.info(
    { companyName: payload.companyName, proposalPdf, applicationPdf, contributionEvidence },
    'UHC employer application completed',
  );
}
