import {
  HippoCensusReader,
  assertOwnershipTotals100,
  findBasePolicy,
} from '@auto/group-submission-shared';
import { BusinessException, type WebTxContext } from '@rpa/core';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AutomationConfig } from './config.ts';
import { createStepContext, describeCurrentScreen } from './gate-evidence.ts';
import type { Payload } from './payload.ts';
import { resolveProducerIdentity } from './producer-identity.ts';
import { CensusPage } from './pages/census.page.ts';
import { EmployerApplicationPage } from './pages/employer-application.page.ts';
import { GroupSetupPage } from './pages/group-setup.page.ts';
import { MedicalPlansPage } from './pages/medical-plans.page.ts';
import { PortfoliosPage } from './pages/portfolios.page.ts';
import { PostSignaturePage } from './pages/post-signature.page.ts';
import { QuoteReviewPage } from './pages/quote-review.page.ts';
import { QuoteStartPage } from './pages/quote-start.page.ts';
import { SignaturePage } from './pages/signature.page.ts';

/**
 * One group's Anthem CA new-plan submission.
 *
 * ── THE SHAPE OF THIS PROCESS CHANGED ON 2026-09-03 ──────────────────────────
 * Producer Toolbox is now only a launcher: its `Create Quote` opens a NEW TAB on
 * Anthem's Salesforce / Vlocity platform, and everything from the group details
 * onwards happens there. The runbook's stages 2.2-8 describe screens that no
 * longer exist. See docs/poc/anthem-ca-new-plans/drift-log.md.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The PoC boundary is ARRIVING at `Document Checklist`, the last step in the
 * rail. Attaching documents and pressing its Submit are out of scope, and both
 * are fronted by the `allowSubmit` guard - see post-signature.page.ts.
 */
export async function processTransaction(
  ctx: WebTxContext<Payload, AutomationConfig>,
): Promise<void> {
  const payload = ctx.item.payload;
  const config = ctx.config.automation;

  // ── Cheap payload rules first. No reason to drive a browser to discover the
  //    submission was never valid. ──
  assertOwnershipTotals100(payload.owners);
  const basePolicy = findBasePolicy(payload.policies);

  if (payload.owners.length > 3) {
    throw new BusinessException(
      `Group has ${payload.owners.length} owners. More than 3 requires an ownership letterhead, ` +
        'which is attached during document upload - outside this PoC boundary.',
      { details: { ownerCount: payload.owners.length } },
    );
  }

  const steps = createStepContext(ctx);

  /**
   * Who files this. Resolved from `.env` via ctx.secrets, never from config -
   * the values identify a real licensed producer and agency. See
   * producer-identity.ts.
   */
  const producer = await resolveProducerIdentity(ctx.secrets, config);

  // ── Producer Toolbox: reach the quoting platform ──
  const quoteStart = new QuoteStartPage(ctx.page, steps);
  const platform = await quoteStart.startNewSmallGroupQuote();

  /**
   * Everything below drives the NEW TAB. `platform` is that page - the original
   * Producer Toolbox tab stays open behind it and is never touched again.
   */
  // Evidence must come from the tab we are actually driving, not the launcher.
  steps.followPage(platform);

  const groupSetup = new GroupSetupPage(platform, steps, config, producer);
  await groupSetup.answerQualifyingQuestions();
  await groupSetup.enterGroupDetails(payload);
  // County renders only once the form is expanded, so it comes after.
  await groupSetup.expandForm();
  await groupSetup.selectCounty(payload);
  await groupSetup.enterContactInformation(payload);
  await groupSetup.selectWritingAgent();
  await groupSetup.continueToPortfolios();

  const portfolios = new PortfoliosPage(platform, steps);
  await portfolios.enterGroupSizeAndIndustry(payload);
  await portfolios.selectProducts();
  await portfolios.setCoveragePeriod(payload);
  await portfolios.continueToCensus();

  /**
   * The census is read ONCE, here, and the split handed to whoever needs it:
   * the template writer wants the enrolling people, the eligibility screen
   * wants the waiving employees. Two readers would eventually disagree about
   * who is enrolling, which is the one thing that must not happen.
   */
  const reader = new HippoCensusReader();
  const censusFile = path.isAbsolute(payload.censusFile)
    ? payload.censusFile
    : path.join(ctx.paths.automationDir, payload.censusFile);
  const { enrolling, waiving } = reader.splitByEnrollment(await reader.read(censusFile));

  const census = new CensusPage(platform, steps);
  const templatePath = await census.downloadTemplate(ctx.paths.runArtifactsDir);
  await census.fillAndUpload(enrolling, templatePath, ctx.paths.runArtifactsDir);
  await census.continueToPlans();

  const plans = new MedicalPlansPage(platform, steps);
  await plans.selectPlans(payload);
  await plans.generateQuote();

  const review = new QuoteReviewPage(platform, steps);
  const quoteNumber = await review.waitForQuote(payload);
  const quotePdf = await review.downloadMemberRatedPdf(ctx.paths.runArtifactsDir);
  ctx.logger.info({ quoteNumber, quotePdf }, 'Anthem quote generated');

  await review.startApplication();

  // ── Stage 7: the employer application ──
  const application = new EmployerApplicationPage(platform, steps, config, producer);
  await application.fillCompanyInformation(payload);
  await application.fillOwnership(payload);
  await application.fillMedicalCoverage(payload, basePolicy.planCode);
  await application.fillEligibility(payload, waiving);
  await application.fillLeaveAndCobra();
  await application.fillPriorCoverage();
  await application.fillElectronicAccess();
  await application.fillGeneralTerms();
  await application.fillAttestation();

  /**
   * ── THE POC BOUNDARY ────────────────────────────────────────────────────────
   * Every editable screen is now filled, and the automation is parked on
   * Attestation - the last one the portal lets you change. Its own banner says
   * so: "You won't be able to make changes to the application after this step."
   *
   * The next Continue locks the application, and the screens past it lead to
   * the signature that FILES it with the carrier under a real producer's
   * licence. The seed data being synthetic does not make that safe: the
   * submission itself would be real and Anthem may act on it.
   *
   * Reaching this exception IS the success condition for the PoC.
   * ────────────────────────────────────────────────────────────────────────────
   */
  if (!config.allowSubmit) {
    throw new BusinessException(
      'Parked on Attestation with allowSubmit=false. Every editable screen of the employer ' +
        'application is filled; the next Continue LOCKS the application, and the screens past it ' +
        'file it with the carrier. This is the PoC safety boundary and reaching it is success.',
      {
        details: {
          companyName: payload.companyName,
          basePlanCode: basePolicy.planCode,
          quoteNumber,
          quotePdf,
        },
      },
    );
  }

  /**
   * ── PAST THE POINT OF NO RETURN ─────────────────────────────────────────────
   * Only reachable with allowSubmit=true.
   *
   * `lockApplication` presses the Continue that makes the application
   * uneditable. Everything after it signs and FILES a real group application
   * with Anthem, under a real producer's licence.
   *
   * The signature locators WERE verified end to end on 2026-09-03 (run
   * 20260903T172508Z-d0d83a signed and filed the synthetic group's
   * application). What follows the signature was mapped afterwards, from the
   * filed application - see post-signature.page.ts for what is verified there
   * and what is not.
   * ───────────────────────────────────────────────────────────────────────────
   */
  await application.lockApplication();

  const signature = new SignaturePage(platform, steps, config);
  await signature.chooseElectronicSignature();
  await signature.enterSignatory(payload);

  // Finish. This is the filing.
  await signature.signAndFile();

  const applicationPdf = await signature.saveSignedApplication(ctx.paths.runArtifactsDir);

  ctx.logger.info(
    {
      companyName: payload.companyName,
      basePlanCode: basePolicy.planCode,
      quoteNumber,
      quotePdf,
      applicationPdf,
    },
    'Anthem CA group application SIGNED and FILED',
  );

  /**
   * ── THE LAST TWO WIZARD STEPS ───────────────────────────────────────────────
   * `Member Enrollment Type`, then `Document Checklist`, which is the last step
   * in the rail. Mapped 2026-09-03 by reopening the application the 17:25 run
   * signed, so no MFA code and no extra quote were spent learning them.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const post = new PostSignaturePage(platform, steps, config);
  await post.acknowledgeSignature();

  /**
   * `Print and Sign Now` and `Send EFT Via DocuSign`. Each screen is recorded
   * before it is answered, because it is only reachable here: once the
   * application is filed, re-entering the wizard is refused outright.
   */
  await post.crossPostSigningSteps((label) => describeCurrentScreen(ctx, platform, label));

  await post.selectMemberEnrollmentType();
  await post.reachDocumentChecklist(quoteNumber);

  /**
   * The checklist state IS the deliverable of the last step, so it is recorded
   * rather than merely reached: which documents Anthem already holds, and which
   * required one is still outstanding.
   *
   * Nothing is uploaded and nothing is submitted. The one outstanding required
   * slot is the Electronic Debit Form, which carries the group's banking
   * details - this payload deliberately carries references, not records.
   */
  const checklist = await post.readChecklist();
  const outstanding = checklist
    .filter((row) => row.required && row.fileName === '')
    .map((row) => row.name);

  await writeFile(
    path.join(ctx.paths.runArtifactsDir, 'anthem-document-checklist.json'),
    JSON.stringify({ quoteNumber, checklist }, null, 2),
    'utf8',
  );

  ctx.logger.info(
    {
      companyName: payload.companyName,
      quoteNumber,
      slots: checklist.length,
      attached: checklist.filter((row) => row.fileName !== '').map((row) => row.name),
      outstandingRequired: outstanding,
    },
    'Reached Document Checklist - the last step of the Anthem wizard',
  );

  await describeCurrentScreen(ctx, platform, 'document-checklist');
}
