import { BusinessException, step, valueIs, visible, type StepContext } from '@rpa/core';
import type { Page } from 'playwright';
import type { Payload } from '../payload.ts';
import {
  FIELD_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
  button,
  check,
  isSelected,
  select,
  selected,
  stepIs,
  type as typeInto,
  typeahead,
  field,
} from '@auto/group-submission-shared';
import { readPortalValidationError } from './portal-errors.ts';

/**
 * `Select Portfolios` - the wizard's second step.
 *
 * Absorbs the runbook's stage 2.3 counts (SIC code, eligible employees), the
 * whole of stage 3 (products and coverage), and the "correspondence contact"
 * block from stage 6. Mapped live 2026-09-03.
 */

/** `MMM D YYYY`, no comma - the effective-date list's format. NOT the census's. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function effectiveDateOption(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (match === null) {
    throw new BusinessException(`Coverage effective date "${isoDate}" is not an ISO date.`, {
      details: { value: isoDate },
    });
  }
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)} ${year}`;
}

export class PortfoliosPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  async enterGroupSizeAndIndustry(payload: Payload): Promise<void> {
    const eligible = String(payload.eligibleEEs);

    await step(this.#steps, {
      name: 'enter the eligible employee count',
      precondition: async () =>
        visible(field(this.#page, '*# of Eligible Employees'), SCREEN_TIMEOUT_MS),
      action: async () => typeInto(this.#page, '*# of Eligible Employees', eligible),
      postcondition: async () => valueIs(field(this.#page, '*# of Eligible Employees'), eligible),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    /**
     * A TYPEAHEAD, not a text field. Typing `7311` leaves the box looking right
     * and the portal then refuses Continue with "That SIC code isn't valid.
     * Please double check it and try again." - the suggestion has to be
     * committed. Searching `7311` offers exactly `7311 Advertising Agencies`.
     */
    const sicOption = new RegExp(`^${payload.sicCode}\\b`);

    await step(this.#steps, {
      name: 'select the SIC code',
      precondition: async () =>
        visible(field(this.#page, 'SIC Code or Industry Name Search'), FIELD_TIMEOUT_MS),
      action: async () =>
        typeahead(this.#page, 'SIC Code or Industry Name Search', payload.sicCode, sicOption),
      /**
       * Reads back the committed suggestion, which starts with the payload's
       * own code - so it is anchored on this transaction, not on "something is
       * in the box".
       */
      postcondition: async () =>
        sicOption.test(await selected(this.#page, 'SIC Code or Industry Name Search')),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Products: ACA, then Medical Only.
   *
   * Progressive - the Medical Only / Medical + Specialty pair does not exist
   * until the ACA checkbox is ticked, so these cannot be one step.
   *
   * Note the split between what is clicked and what is asserted. The `input` is
   * 1x1 px behind its label so the LABEL has to be clicked, but `getByLabel`
   * resolves to the input itself - which is the only thing that can answer
   * "is it actually ticked?". Asserting on the label would assert nothing.
   */
  async selectProducts(): Promise<void> {
    await step(this.#steps, {
      name: 'select the ACA portfolio',
      precondition: async () =>
        visible(this.#page.getByText('Quote Eligible Portfolios').first(), FIELD_TIMEOUT_MS),
      action: async () => check(this.#page, 'Affordable Care Act (ACA)'),
      postcondition: async () =>
        field(this.#page, 'Affordable Care Act (ACA)').first().isChecked().catch(() => false),
    });

    await step(this.#steps, {
      name: 'select medical only',
      // Not `^Medical Only$`: an SLDS label wraps its text in nested spans, so
      // an anchored match against the element's full text content misses it.
      precondition: async () => visible(field(this.#page, /Medical Only/), FIELD_TIMEOUT_MS),
      action: async () => check(this.#page, /Medical Only/),
      postcondition: async () =>
        field(this.#page, /Medical Only/).first().isChecked().catch(() => false),
    });
  }

  /**
   * Benefit period and effective date.
   *
   * `*Benefit Period` is readonly, `aria-disabled`, and already `Calendar Year`
   * - clicking it times out because the element is never enabled. So it is
   * ASSERTED, not set, and the assertion reads `data-value`.
   */
  async setCoveragePeriod(payload: Payload): Promise<void> {
    await step(this.#steps, {
      name: 'confirm the benefit period is calendar year',
      action: async () => undefined,
      alwaysRun: true,
      postcondition: async () => (await selected(this.#page, '*Benefit Period')) === 'Calendar Year',
    });

    const option = effectiveDateOption(payload.coverageEffectiveDate);

    await step(this.#steps, {
      name: 'select the coverage effective date',
      precondition: async () =>
        visible(field(this.#page, '*Coverage Effective Date'), FIELD_TIMEOUT_MS),
      action: async () => select(this.#page, '*Coverage Effective Date', option),
      // Anchored on the payload's own date, so a resumed run cannot inherit
      // the previous group's.
      postcondition: async () => isSelected(this.#page, '*Coverage Effective Date', option),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * The quote-contact block stays BLANK.
   *
   * This is the runbook's "individual receiving all correspondence for this
   * quote". Asserting it is empty is worth a step: it is the kind of field a
   * well-meaning change would start populating.
   */
  async continueToCensus(): Promise<void> {
    await step(this.#steps, {
      name: 'leave the quote correspondence contact blank',
      action: async () => undefined,
      alwaysRun: true,
      postcondition: async () =>
        (await field(this.#page, 'Quote Contact Name').first().inputValue().catch(() => '')) === '',
    });

    await step(this.#steps, {
      name: 'complete portfolio selection',
      precondition: async () => visible(button(this.#page, 'Continue'), FIELD_TIMEOUT_MS),
      action: async () => button(this.#page, 'Continue').last().click(),
      alwaysRun: true,
      postcondition: async () => stepIs(this.#page, 'Select Portfolios', 'Completed'),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }
}
