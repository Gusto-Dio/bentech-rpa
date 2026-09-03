import type { StepContext } from '@rpa/core';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import type { Payload } from '../payload.ts';

/**
 * UHC SAMx - the screens after owner assignment, mapped but not implemented.
 *
 * Follow the pattern in case-start.page.ts: every interaction wrapped in a
 * step() with a precondition and a transaction-specific postcondition.
 *
 * ⚠ Step numbers refer to a runbook written BEFORE this code. Treat them as a
 * map, not a specification. Re-map, then update process-steps.md.
 *
 * The constructor properties are `protected` only so strict unused-member
 * checking accepts classes whose methods are not written yet. Narrow them to
 * `private` as you implement.
 */

function notImplemented(method: string, stage: string): never {
  throw new Error(
    `${method} is not implemented. It is stage ${stage} of ` +
      'docs/poc/uhc-np-new-plans/PROMPT.md - re-map it against the live portal first.',
  );
}

/** Stage 3: employer information, locations, contact, products to quote (runbook 2.3 - 2.7). */
export class EmployerInformationPage {
  constructor(
    protected readonly page: Page,
    protected readonly steps: StepContext,
  ) {}

  async fillEmployerInformation(_payload: Payload): Promise<void> {
    // Franchise Code is deliberately left blank at this stage (runbook 2.4).
    notImplemented('fillEmployerInformation', '3');
  }

  /**
   * The zip must generate the county. If it does not, the location is not
   * accepted - and a silently missing county surfaces much later as a rating
   * error, so the postcondition must assert the county actually appeared.
   */
  async fillCompanyLocations(_payload: Payload): Promise<void> {
    notImplemented('fillCompanyLocations', '3');
  }

  /** Phone numbers must be digits only - SAMx rejects dashes and parentheses (runbook 3.3). */
  async fillPrimaryContact(_payload: Payload): Promise<void> {
    notImplemented('fillPrimaryContact', '3');
  }

  async selectProductsToQuote(_payload: Payload): Promise<void> {
    // SIC often needs typing before the dropdown offers a match.
    notImplemented('selectProductsToQuote', '3');
  }
}

/**
 * Stage 4: the SAMx bulk census (runbook 2.8 - 2.9).
 *
 * This is the SAMx_PortalBulkCensus macro port - see docs/poc/excel-macros.md
 * for the column mapping the runbook specifies (Col R medical coverage type,
 * S/AA waiver reason, Y waive all products, Z medical plan code, AQ SSN).
 *
 * Two behaviours the runbook calls out that the implementation must honour:
 *  - dependents who are WAIVING are removed from the census before transforming
 *  - no employee data loads at all if the template has any error, so the upload
 *    is all-or-nothing and the postcondition must count loaded employees
 */
export class EmployeeCensusPage {
  constructor(
    protected readonly page: Page,
    protected readonly steps: StepContext,
  ) {}

  /** Downloads the SAMx Portal Bulk Census template. Returns its path. */
  async downloadBulkCensusTemplate(_downloadDir: string): Promise<string> {
    notImplemented('downloadBulkCensusTemplate', '4');
  }

  async uploadBulkCensus(_templatePath: string, _expectedEnrollees: number): Promise<void> {
    // On error the portal shows a popup listing every problem. Read it and turn
    // it into a BusinessException carrying the portal's own wording - the census
    // data is wrong, and no retry fixes that.
    notImplemented('uploadBulkCensus', '4');
  }
}

/** Stage 5: plan selection, quote review, proposal (runbook 2.10 - 2.12). */
export class PlanSelectionPage {
  constructor(
    protected readonly page: Page,
    protected readonly steps: StepContext,
  ) {}

  /**
   * Rating method must be confirmed BEFORE and AFTER selecting plans - the
   * runbook is emphatic, which usually means it has silently reset on someone.
   * A perfect case for a postcondition that re-checks it.
   */
  async confirmRatingMethod(_payload: Payload): Promise<void> {
    notImplemented('confirmRatingMethod', '5');
  }

  /**
   * Select each plan WITH the domestic-partner rider, and never the "aged 29"
   * rider (shown in orange above the rate). Picking the wrong rider produces a
   * valid-looking quote for the wrong coverage, which is the worst kind of
   * failure - so the postcondition must assert the rider, not just the plan.
   */
  async selectPlansWithRiders(_payload: Payload): Promise<void> {
    notImplemented('selectPlansWithRiders', '5');
  }

  /**
   * Employer contribution. Two derived rules from the runbook:
   *  - a California group at 100% where not everyone enrols is entered as 99%
   *  - a flat-dollar contribution is entered as 50%
   * Both must be computed and logged explicitly, never silently applied.
   */
  async setEmployerContribution(_payload: Payload): Promise<void> {
    notImplemented('setEmployerContribution', '5');
  }

  async enterTinAndGenerateProposal(_payload: Payload, _downloadDir: string): Promise<string> {
    notImplemented('enterTinAndGenerateProposal', '5');
  }

  async moveToEnrollment(): Promise<void> {
    notImplemented('moveToEnrollment', '5');
  }
}

/**
 * Stage 6-7: the employer application (runbook 3.1 - 3.13).
 *
 * The longest stage. Several answers are DERIVED from payload counts rather
 * than copied, and the thresholds are easy to invert:
 *   continuation:  < 20 FTE -> State,    >= 20 FTE -> COBRA
 *   primary:       < 20 EEs -> Medicare, >= 20 EEs -> Plan Primary
 * Assert the derivation in code and log which branch was taken.
 */
export class EmployerApplicationPage {
  constructor(
    protected readonly page: Page,
    protected readonly steps: StepContext,
    protected readonly config: AutomationConfig,
  ) {}

  async fillGeneralInformation(_payload: Payload): Promise<void> {
    notImplemented('fillGeneralInformation', '6');
  }

  async fillEligibilityInformation(_payload: Payload): Promise<void> {
    notImplemented('fillEligibilityInformation', '6');
  }

  /**
   * Hippo's waiting-period vocabulary and UHC's do not match one-to-one. The
   * mapping has to be read off the portal's own dropdown during the re-map -
   * do not guess it, and record it in field-map.md when you have it.
   */
  async fillWaitingPeriod(_payload: Payload): Promise<void> {
    notImplemented('fillWaitingPeriod', '6');
  }

  async fillContributionAndParticipation(_payload: Payload): Promise<void> {
    notImplemented('fillContributionAndParticipation', '6');
  }

  async fillConsumerDrivenAndAdditionalEligibility(_payload: Payload): Promise<void> {
    notImplemented('fillConsumerDrivenAndAdditionalEligibility', '6');
  }

  async fillCurrentCarrierInformation(_payload: Payload): Promise<void> {
    notImplemented('fillCurrentCarrierInformation', '6');
  }

  /** Producer, general agent, franchise code, PCIS id, commission - all from config. */
  async fillProducer(): Promise<void> {
    notImplemented('fillProducer', '7');
  }
}

/**
 * Stage 8: attestation (runbook 3.14 - 3.15).
 *
 * ── THE RISKIEST STEP IN THIS POC ────────────────────────────────────────────
 * Submitting an attestation is signing on the producer's behalf against the
 * PRODUCTION portal. Every method here MUST check config.allowSubmit first and
 * throw a BusinessException naming the guard when it is false.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class AttestationPage {
  constructor(
    protected readonly page: Page,
    protected readonly steps: StepContext,
    protected readonly config: AutomationConfig,
  ) {}

  async submitAttestation(): Promise<void> {
    notImplemented('submitAttestation', '8');
  }

  /** Print Completed Form, for the evidence folder. */
  async downloadCompletedApplication(_downloadDir: string): Promise<string> {
    notImplemented('downloadCompletedApplication', '8');
  }
}
