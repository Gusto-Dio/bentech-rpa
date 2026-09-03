import { BusinessException, step, valueIs, visible, type StepContext } from '@rpa/core';
import type { HippoCensusRow } from '@auto/group-submission-shared';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import {
  assertContinuationMatches,
  eligibleDecliningCount,
  partTimeCount,
} from '../derived.ts';
import type { Payload } from '../payload.ts';
import {
  FIELD_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
  answer,
  answerIfPresent,
  button,
  isAnswered,
  isSelected,
  select,
  type as typeInto,
  field,
} from './lightning.ts';
import { readPortalValidationError } from './portal-errors.ts';

/**
 * The `Employer Enrollment Application for Small Groups` - stage 7.
 *
 * Its own wizard, at `/broker/s/enrollgroupca-co?c__ContextId=<quoteId>…`, with
 * twelve steps in the rail:
 *
 *   Company Information · Ownership · Medical Coverage · Eligibility ·
 *   LOA/COBRA/Medical Leave · Prior Coverage · Electronic Access ·
 *   General Terms & Agreements · Attestation · Signature Format ·
 *   Member Enrollment Type · Document Checklist
 *
 * The first seven are mapped against the live portal (2026-09-03). The last
 * five are NOT - they lead to the irreversible signature, and `allowSubmit`
 * stops the automation before them.
 */

/** `MM/DD/YYYY` - a third date format, distinct from the census and the quote. */
export function applicationDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (match === null) {
    throw new BusinessException(`Date "${isoDate}" is not an ISO date.`, { details: { value: isoDate } });
  }
  const [, year, month, day] = match;
  return `${month}/${day}/${year}`;
}

/** Hippo's entity types -> the portal's Organization Type picklist. */
const ORGANIZATION_TYPES: Readonly<Record<string, string>> = {
  llc: 'Limited Liability Company (LLC)',
  corporation: 'Corporation',
  partnership: 'Partnership',
  proprietorship: 'Proprietorship',
  lp: 'Limited Partnership (LP)',
  llp: 'Limited Liability Partnership (LLP)',
};

export function organizationType(entityType: string): string {
  const mapped = ORGANIZATION_TYPES[entityType.trim().toLowerCase()];
  if (mapped === undefined) {
    throw new BusinessException(
      `Entity type "${entityType}" does not map to one of Anthem's Organization Type options ` +
        `(${Object.values(ORGANIZATION_TYPES).join(', ')}). Choosing "Other" is a human decision.`,
      { details: { entityType } },
    );
  }
  return mapped;
}

/** The payload's waiting-period wording -> the portal's picklist. */
const WAITING_PERIODS: Readonly<Record<string, string>> = {
  '1st, on/following hire': 'First of month after hire date',
  '1st of month after hire': 'First of month after hire date',
};

export function waitingPeriodOption(waitingPeriod: string): string {
  const mapped = WAITING_PERIODS[waitingPeriod.trim().toLowerCase()] ?? WAITING_PERIODS[waitingPeriod.trim()];
  if (mapped === undefined) {
    throw new BusinessException(
      `Waiting period "${waitingPeriod}" does not map to one of Anthem's three options. ` +
        'Picking the nearest is a human judgement call, not something to guess on a signed application.',
      { details: { waitingPeriod, known: Object.keys(WAITING_PERIODS) } },
    );
  }
  return mapped;
}

export class EmployerApplicationPage {
  readonly #page: Page;
  readonly #steps: StepContext;
  readonly #config: AutomationConfig;

  constructor(page: Page, steps: StepContext, config: AutomationConfig) {
    this.#page = page;
    this.#steps = steps;
    this.#config = config;
  }

  #continue(name: string): Promise<unknown> {
    return step(this.#steps, {
      name,
      precondition: async () => visible(button(this.#page, 'Continue'), FIELD_TIMEOUT_MS),
      action: async () => button(this.#page, 'Continue').last().click(),
      alwaysRun: true,
      // The form repaints in place, so "the fields are gone" is not a signal.
      // A cleared validation region is the best available one here.
      postcondition: async () => (await readPortalValidationError(this.#page)) === undefined,
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /** 7.1 Company Information. Most fields carry over from Group Setup. */
  async fillCompanyInformation(payload: Payload): Promise<void> {
    const established = applicationDate(payload.dateEstablished);

    await step(this.#steps, {
      name: 'enter the type of business',
      precondition: async () =>
        visible(field(this.#page, '*Type of Business (Be Specific)'), SCREEN_TIMEOUT_MS),
      action: async () =>
        typeInto(this.#page, '*Type of Business (Be Specific)', this.#config.typeOfBusiness),
      postcondition: async () =>
        valueIs(field(this.#page, '*Type of Business (Be Specific)'), this.#config.typeOfBusiness),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'enter the date the business was established',
      precondition: async () =>
        visible(field(this.#page, '*Date Business Established'), FIELD_TIMEOUT_MS),
      action: async () => typeInto(this.#page, '*Date Business Established', established),
      postcondition: async () => valueIs(field(this.#page, '*Date Business Established'), established),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    const orgType = organizationType(payload.entityType);

    await step(this.#steps, {
      name: 'select the organization type',
      precondition: async () => visible(field(this.#page, '*Organization Type'), FIELD_TIMEOUT_MS),
      action: async () => select(this.#page, '*Organization Type', orgType),
      postcondition: async () => isSelected(this.#page, '*Organization Type', orgType),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    // The four policy answers. All are runbook defaults, none is derived.
    const answers: ReadonlyArray<readonly [RegExp, 'Yes' | 'No']> = [
      [/billing address the same as above/i, 'Yes'],
      [/member of an association plan/i, 'No'],
      [/Premium Only Plan/i, 'No'],
      [/Internal Revenue Code Section 414/i, 'No'],
    ];

    for (const [legend, value] of answers) {
      await step(this.#steps, {
        name: `answer: ${legend.source.slice(0, 40)}`,
        precondition: async () => visible(this.#page.locator('fieldset').filter({ hasText: legend }), FIELD_TIMEOUT_MS),
        action: async () => answer(this.#page, legend, value),
        postcondition: async () => isAnswered(this.#page, legend, value),
      });
    }

    await this.#continue('complete company information');
  }

  /**
   * 7.2 Ownership.
   *
   * More than three owners needs a letterhead PDF attached during document
   * upload, which is past this PoC's boundary - so it is a Business failure
   * rather than something to improvise.
   */
  async fillOwnership(payload: Payload): Promise<void> {
    if (payload.owners.length > 3) {
      throw new BusinessException(
        `Group has ${payload.owners.length} owners. More than 3 requires an ownership letterhead, ` +
          'attached during document upload - outside this PoC boundary.',
        { details: { ownerCount: payload.owners.length } },
      );
    }

    const [owner] = payload.owners;
    if (owner === undefined) throw new BusinessException('The payload carries no owners.');

    const percentage = String(owner.percentage);

    await step(this.#steps, {
      name: 'confirm the company has individual owners',
      precondition: async () =>
        visible(this.#page.locator('fieldset').filter({ hasText: /own all or part of this company/i }), SCREEN_TIMEOUT_MS),
      action: async () => answer(this.#page, /own all or part of this company/i, 'Yes'),
      postcondition: async () => isAnswered(this.#page, /own all or part of this company/i, 'Yes'),
    });

    await step(this.#steps, {
      name: 'enter the owner',
      precondition: async () => visible(field(this.#page, '*First Name'), FIELD_TIMEOUT_MS),
      action: async () => {
        await typeInto(this.#page, '*First Name', owner.firstName);
        await typeInto(this.#page, '*Last Name', owner.lastName);
        await typeInto(this.#page, '*Percentage of Ownership', percentage);
      },
      // Anchored on this owner's surname, not "an owner exists".
      postcondition: async () => valueIs(field(this.#page, '*Last Name'), owner.lastName),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'set owner eligibility',
      precondition: async () => visible(this.#page.locator('fieldset').filter({ hasText: /Eligible\?/i }), FIELD_TIMEOUT_MS),
      action: async () => answer(this.#page, /Eligible\?/i, owner.ownerEligible ? 'Yes' : 'No'),
      postcondition: async () => isAnswered(this.#page, /Eligible\?/i, owner.ownerEligible ? 'Yes' : 'No'),
    });

    await this.#continue('complete ownership');
  }

  /**
   * 7.3 Medical Coverage: contribution, then re-select the quoted plans.
   *
   * The plans have to be selected again here even though they were chosen for
   * the quote - the runbook says so and the portal agrees.
   */
  async fillMedicalCoverage(payload: Payload, basePlanCode: string): Promise<void> {
    const percent = String(Math.round(Number(payload.policies[0]?.eeContribution ?? '0')));

    await step(this.#steps, {
      name: 'choose percentage-of-plan contribution',
      precondition: async () =>
        visible(this.#page.locator('label').filter({ hasText: /Percentage of plan option/i }), SCREEN_TIMEOUT_MS),
      action: async () =>
        this.#page.locator('label.slds-radio__label').filter({ hasText: /Percentage of plan option/i })
          .filter({ visible: true }).first().click(),
      postcondition: async () => visible(field(this.#page, '*Enter %'), FIELD_TIMEOUT_MS),
    });

    await step(this.#steps, {
      name: 'enter the employer contribution percentage',
      precondition: async () => visible(field(this.#page, '*Enter %'), FIELD_TIMEOUT_MS),
      action: async () => typeInto(this.#page, '*Enter %', percent),
      postcondition: async () => valueIs(field(this.#page, '*Enter %'), percent),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'enter the base plan contract code',
      // A plain 4-character text input, not a picker - maxlength=4, and the
      // runbook's "enter the contract code of the base plan" is literal.
      precondition: async () => visible(field(this.#page, '*Select Medical Plan'), FIELD_TIMEOUT_MS),
      action: async () => typeInto(this.#page, '*Select Medical Plan', basePlanCode),
      postcondition: async () => valueIs(field(this.#page, '*Select Medical Plan'), basePlanCode),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'select the quoted plans on the application',
      precondition: async () => visible(button(this.#page, 'Select Plan'), FIELD_TIMEOUT_MS),
      action: async () => {
        for (let i = 0; i < payload.policies.length + 2; i += 1) {
          const remaining = button(this.#page, 'Select Plan');
          if ((await remaining.count()) === 0) break;
          await remaining.first().click();
        }
      },
      // Every card must have flipped; a leftover "Select Plan" means one did not.
      postcondition: async () => (await button(this.#page, 'Select Plan').count()) === 0,
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await this.#continue('complete medical coverage');
  }

  /**
   * 7.4 Eligibility - the densest screen, and the one where a quiet arithmetic
   * mistake does the most damage. Every derived number comes from `derived.ts`,
   * which refuses rather than guesses when the payload disagrees with itself.
   */
  async fillEligibility(payload: Payload, waiving: readonly HippoCensusRow[]): Promise<void> {
    const partTime = String(partTimeCount(payload));
    const declining = String(eligibleDecliningCount(waiving));
    assertContinuationMatches(payload);

    const numbers: ReadonlyArray<readonly [string, string]> = [
      ['*Total Number of Employees', String(payload.anteCount)],
      ['*Number Of Eligible Full-Time Employees', String(payload.fteCount)],
      ['*Number Of Part-Time Employees', partTime],
      ['*Number of Eligible Declining Employees', declining],
      ['*Number Of Ineligible Employees', partTime],
    ];

    for (const [label, value] of numbers) {
      await step(this.#steps, {
        name: `enter ${label.replace('*', '').toLowerCase()}`,
        precondition: async () => visible(field(this.#page, label), FIELD_TIMEOUT_MS),
        action: async () => typeInto(this.#page, label, value),
        postcondition: async () => valueIs(field(this.#page, label), value),
        businessCheck: async () => readPortalValidationError(this.#page),
      });
    }

    const answers: ReadonlyArray<readonly [RegExp, 'Yes' | 'No']> = [
      [/meet the definition of a small employer/i, 'Yes'],
      [/20.29 hours weekly to be covered/i, payload.partTimeCovered ? 'Yes' : 'No'],
      [/one-time waiver of employer waiting period/i, payload.waivedWP ? 'Yes' : 'No'],
      [/additional employees in another state/i, 'No'],
    ];

    for (const [legend, value] of answers) {
      await step(this.#steps, {
        name: `answer: ${legend.source.slice(0, 40)}`,
        precondition: async () => visible(this.#page.locator('fieldset').filter({ hasText: legend }), FIELD_TIMEOUT_MS),
        action: async () => answer(this.#page, legend, value),
        postcondition: async () => isAnswered(this.#page, legend, value),
      });
    }

    /**
     * The continuation pair, answered tolerantly and in the right order.
     *
     * They are mutually exclusive in practice: answering Cal-COBRA reveals an
     * enrollee count and can leave the federal COBRA question absent. Demanding
     * both failed a screen that was correctly filled, and the retry rebuilt the
     * whole quote. The one that APPLIES is answered first and asserted; the
     * other is best-effort.
     */
    const calCobra = payload.continuation === 'state';

    await step(this.#steps, {
      name: `answer: subject to ${calCobra ? 'Cal-COBRA' : 'COBRA'}`,
      precondition: async () =>
        visible(
          this.#page.locator('fieldset').filter({ hasText: /subject to (Cal-)?COBRA/i }),
          FIELD_TIMEOUT_MS,
        ),
      action: async () => {
        await answer(this.#page, calCobra ? /subject to Cal-COBRA/i : /subject to COBRA/i, 'Yes');
        // The other one, only if the portal still shows it.
        await answerIfPresent(
          this.#page,
          calCobra ? /subject to COBRA/i : /subject to Cal-COBRA/i,
          'No',
        );
      },
      postcondition: async () =>
        isAnswered(this.#page, calCobra ? /subject to Cal-COBRA/i : /subject to COBRA/i, 'Yes'),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    const waitingPeriod = waitingPeriodOption(payload.policies[0]?.waitingPeriod ?? '');

    await step(this.#steps, {
      name: 'select the waiting period',
      precondition: async () => visible(field(this.#page, '*Waiting Period for New Employees'), FIELD_TIMEOUT_MS),
      action: async () => select(this.#page, '*Waiting Period for New Employees', waitingPeriod),
      postcondition: async () => isSelected(this.#page, '*Waiting Period for New Employees', waitingPeriod),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    /**
     * Cal-COBRA reveals an enrollee count. The runbook defaults it to 0: a
     * NEW group has nobody already on state continuation.
     */
    await step(this.#steps, {
      name: 'enter the state-continuation enrollee count',
      precondition: async () => visible(field(this.#page, /Number of (Cal-)?COBRA Enrollees/i), FIELD_TIMEOUT_MS),
      action: async () => typeInto(this.#page, /Number of (Cal-)?COBRA Enrollees/i, '0'),
      postcondition: async () => valueIs(field(this.#page, /Number of (Cal-)?COBRA Enrollees/i), '0'),
    });

    const medicare =
      payload.fteCount >= 20
        ? 'Anthem is primary for groups that employ 20 or more employees if the employer has 20 or more employees for each working day in each of 20 or more calendar weeks in the current calendar year or the preceding calendar year.'
        : 'Medicare is primary for groups with less than 20 employees.';

    await step(this.#steps, {
      name: 'select the medicare secondary payer rule',
      precondition: async () => visible(field(this.#page, /Medicare Secondary Payer Rules/i), FIELD_TIMEOUT_MS),
      action: async () => select(this.#page, /Medicare Secondary Payer Rules/i, medicare),
      // The combobox stores a code (`MedicareIsPrimary`), not the label, so
      // this asserts only that something was committed.
      postcondition: async () => (await field(this.#page, /Medicare Secondary Payer Rules/i)
        .first().getAttribute('data-value').catch(() => null)) !== '',
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await this.#continue('complete eligibility');
  }

  /** 7.5 + 7.7: leave of absence and the two COBRA questions, on one screen. */
  async fillLeaveAndCobra(): Promise<void> {
    // Both are comboboxes ("6 months"), NOT number fields - typing a bare "6"
    // leaves data-value empty and the form still reports it as required.
    await step(this.#steps, {
      name: 'set the medical leave of absence maximum',
      precondition: async () => visible(field(this.#page, /Medical: Number of months/i), SCREEN_TIMEOUT_MS),
      action: async () => select(this.#page, /Medical: Number of months/i, '6 months'),
      postcondition: async () => isSelected(this.#page, /Medical: Number of months/i, '6 months'),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'set the personal leave of absence maximum',
      precondition: async () => visible(field(this.#page, /Personal: Number of months/i), FIELD_TIMEOUT_MS),
      action: async () => select(this.#page, /Personal: Number of months/i, '3 months'),
      postcondition: async () => isSelected(this.#page, /Personal: Number of months/i, '3 months'),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    for (const legend of [/exercise their Cal-COBRA\/COBRA option/i, /will this employee return to work/i]) {
      await step(this.#steps, {
        name: `answer: ${legend.source.slice(0, 40)}`,
        precondition: async () => visible(this.#page.locator('fieldset').filter({ hasText: legend }), FIELD_TIMEOUT_MS),
        action: async () => answer(this.#page, legend, 'No'),
        postcondition: async () => isAnswered(this.#page, legend, 'No'),
      });
    }

    await this.#continue('complete leave of absence and cobra');
  }

  /** 7.6 Prior coverage. */
  async fillPriorCoverage(): Promise<void> {
    await step(this.#steps, {
      name: 'answer: prior coverage within 12 months',
      precondition: async () =>
        visible(this.#page.locator('fieldset').filter({ hasText: /coverage within 12 months/i }), SCREEN_TIMEOUT_MS),
      action: async () => answer(this.#page, /coverage within 12 months/i, 'No'),
      postcondition: async () => isAnswered(this.#page, /coverage within 12 months/i, 'No'),
    });

    await this.#continue('complete prior coverage');
  }

  /**
   * 7.10 Attestation - the producer declaration. THE LAST EDITABLE SCREEN.
   *
   * The portal says so itself, in a banner on this step: *"You won't be able to
   * make changes to the application after this step. Please review carefully."*
   * So Continue here is a point of no return for edits, and it is deliberately
   * NOT part of this method - see `lockApplication` below.
   *
   * Most of the screen auto-populates from the writing agent chosen back in
   * Group Setup: agent name, agent TIN, agency name, agency TIN, commission
   * percentage. The runbook's "verify Section L names the agency" is exactly
   * that assertion, and it is worth making rather than assuming - a wrong
   * agency here is a misdirected commission on a signed application.
   */
  async fillAttestation(): Promise<void> {
    const enrollment = 'Online Census Enrollment (OCE)';

    await step(this.#steps, {
      name: 'select the employee enrollment indication',
      precondition: async () =>
        visible(field(this.#page, /how the enrollment will be submitted/i), SCREEN_TIMEOUT_MS),
      action: async () => select(this.#page, /how the enrollment will be submitted/i, enrollment),
      postcondition: async () =>
        isSelected(this.#page, /how the enrollment will be submitted/i, enrollment),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    /**
     * The runbook's Section L check. Nothing is typed - this asserts what the
     * portal derived, so that a wrong agency stops the submission here rather
     * than being discovered after it is signed.
     */
    await step(this.#steps, {
      name: 'verify the producer and agency on the application',
      action: async () => undefined,
      alwaysRun: true,
      postcondition: async () => {
        const agency = await field(this.#page, 'Agency Name').first().inputValue().catch(() => '');
        const agent = await field(this.#page, 'Agent/Producer/Broker Name')
          .first()
          .inputValue()
          .catch(() => '');
        return (
          agency.toLowerCase().includes(this.#config.paidAgencyCode.toLowerCase()) &&
          agent.toLowerCase().includes(this.#config.producerLastName.toLowerCase())
        );
      },
    });
  }

  /**
   * Presses the Continue that LOCKS the application.
   *
   * Separated from `fillAttestation` and never called while `allowSubmit` is
   * false. After this the application cannot be edited, and the screens beyond
   * it lead to the signature that files it with the carrier.
   */
  async lockApplication(): Promise<void> {
    if (!this.#config.allowSubmit) {
      throw new BusinessException(
        'lockApplication was called with allowSubmit=false. This is the guard that keeps the PoC ' +
          'from locking and filing a real application against the production portal.',
        { details: { guard: 'allowSubmit' } },
      );
    }
    await this.#continue('lock the application');
  }

  /**
   * 7.9 General Terms & Agreements - the ERISA declaration.
   *
   * The screen is mostly the carrier's terms as read-only text; the one thing
   * to answer is `*Is the group subject to ERISA?`. The runbook's default is
   * "Employer is subject to ERISA" unless the TTS notes say otherwise, and the
   * only alternative the picklist offers requires a written reason - which is a
   * human judgement call, so there is nothing to derive here.
   */
  async fillGeneralTerms(): Promise<void> {
    const erisa = 'Employer is subject to ERISA';

    await step(this.#steps, {
      name: 'declare the group subject to ERISA',
      precondition: async () =>
        visible(field(this.#page, /Is the group subject to ERISA/i), SCREEN_TIMEOUT_MS),
      action: async () => select(this.#page, /Is the group subject to ERISA/i, erisa),
      postcondition: async () => isSelected(this.#page, /Is the group subject to ERISA/i, erisa),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await this.#continue('complete general terms and agreements');
  }

  /**
   * 7.8 Electronic access.
   *
   * The box is left UNCHECKED, and that is the whole point of the step: ticking
   * it REVOKES the agency's authority to act for the group. The postcondition
   * asserts it is still clear, so a future "fill every checkbox" change fails
   * here rather than quietly removing Gusto's access.
   */
  async fillElectronicAccess(): Promise<void> {
    await step(this.#steps, {
      name: 'leave the electronic-access opt-out unchecked',
      precondition: async () =>
        visible(this.#page.locator('input[type=checkbox]').filter({ visible: true }).first(), SCREEN_TIMEOUT_MS),
      action: async () => undefined,
      alwaysRun: true,
      postcondition: async () =>
        !(await this.#page.locator('input[type=checkbox]').filter({ visible: true }).first().isChecked().catch(() => true)),
    });

    await this.#continue('complete electronic access');
  }
}
