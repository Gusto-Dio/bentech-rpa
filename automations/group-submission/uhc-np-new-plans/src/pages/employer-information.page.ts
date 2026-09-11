import { step, textVisible, valueIs, visible, type StepContext } from '@rpa/core';
import type { Page } from 'playwright';
import type { Payload } from '../payload.ts';
import { digitsOnly, readPortalValidationError } from './case-start.page.ts';
import {
  CANNABIS_INDUSTRY,
  FIELD_TIMEOUT_MS,
  PRIMARY_CONTACT_PHONE_TYPE,
  PRIMARY_CONTACT_PREFERENCE,
  PRIMARY_CONTACT_ROLE,
  samxDate,
  SCREEN_STEP_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
} from './samx-options.ts';

/**
 * Stage 3: employer information, locations, primary contact, products to quote.
 * Covers runbook stages 3.1 - 3.4.
 *
 * ⚠ EVERY LOCATOR IN THIS FILE IS AN UNVERIFIED HYPOTHESIS. The runbook names
 * the fields; nothing has confirmed what SAMx labels them or what order the
 * screens come in. Re-map with the recon harness (`pnpm tsx
 * tooling/scripts/uhc-serve.ts`), then record what differed in
 * docs/poc/uhc-np-new-plans/drift-log.md.
 */
export class EmployerInformationPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  /** Stage 3.1: company name and effective date. Franchise code stays blank here. */
  async fillEmployerInformation(payload: Payload): Promise<void> {
    const effectiveDate = samxDate(payload.coverageEffectiveDate);

    await step(this.#steps, {
      name: 'enter the company name and coverage effective date',
      precondition: async () =>
        visible(this.#page.getByLabel(/company name/i), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByLabel(/company name/i).fill(payload.companyName);
        await this.#page.getByLabel(/effective date/i).fill(effectiveDate);
        /**
         * Franchise Code is deliberately left blank at this stage (runbook 3.1).
         * It belongs to the general agent and is entered on the producer screen
         * at stage 7.1; filling it here attaches the case to the agency before
         * the quote exists, which the runbook explicitly does not do.
         */
      },
      /**
         Read back both, because the effective date is the one the portal is most
         likely to reformat and a wrong effective date re-rates the whole group.
       */
      postcondition: async () =>
        (await valueIs(this.#page.getByLabel(/company name/i), payload.companyName)) &&
        (await valueIs(this.#page.getByLabel(/effective date/i), effectiveDate)),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Stage 3.2: company locations and headcounts.
   *
   * `totalApplying` is derived from the census, not carried in the payload - see
   * derived.ts. It is passed in rather than computed here so the arithmetic
   * stays testable without a browser.
   */
  async fillCompanyLocations(payload: Payload, totalApplying: number): Promise<void> {
    await step(this.#steps, {
      name: 'enter the group zip and confirm the county resolved',
      precondition: async () => visible(this.#page.getByLabel(/zip/i), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByLabel(/zip/i).fill(payload.zip);
        // AUTO-HEALING SEAM: the county is derived on blur on most portals. A
        // fallback would look for a Search or Lookup control beside the field.
        await this.#page.getByLabel(/zip/i).blur();
      },
      /**
       * NOT "the zip is filled". The COUNTY is what the portal has to derive,
       * and a silently missing county surfaces much later as a rating error - so
       * the consequence is what gets read back, never the input.
       */
      postcondition: async () => textVisible(this.#page, payload.county, SCREEN_TIMEOUT_MS),
      /**
       * A zip the portal cannot place is a Business failure: the address is not
       * serviceable as given and no retry changes that.
       */
      businessCheck: async () => readPortalValidationError(this.#page),
      timeoutMs: SCREEN_STEP_TIMEOUT_MS,
    });

    await step(this.#steps, {
      name: 'enter the employee counts for the location',
      precondition: async () =>
        visible(this.#page.getByLabel(/total.*(employees )?applying/i), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByLabel(/total.*(employees )?applying/i).fill(String(totalApplying));
        await this.#page.getByLabel(/total.*eligible/i).fill(String(payload.eligibleEEs));
        await this.#page.getByLabel(/full.?time|fte/i).fill(String(payload.fteCount));
      },
      postcondition: async () =>
        valueIs(this.#page.getByLabel(/total.*(employees )?applying/i), String(totalApplying)),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /** Stage 3.3: the primary contact. Phone numbers must be digits only. */
  async fillPrimaryContact(payload: Payload): Promise<void> {
    const phone = digitsOnly(payload.companyPhoneNumber);

    await step(this.#steps, {
      name: 'enter the primary contact',
      precondition: async () =>
        visible(this.#page.getByLabel(/first name/i).first(), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByLabel(/first name/i).first().fill(payload.benefitsAdmin.firstName);
        await this.#page.getByLabel(/last name/i).first().fill(payload.benefitsAdmin.lastName);
        await this.#page.getByLabel(/email/i).first().fill(payload.benefitsAdmin.email);
        // SAMx rejects dashes and parentheses in a phone field (runbook 3.3).
        await this.#page.getByLabel(/phone/i).first().fill(phone);

        await this.#page.getByLabel(/phone type/i).selectOption(PRIMARY_CONTACT_PHONE_TYPE);
        await this.#page.getByLabel(/role/i).selectOption(PRIMARY_CONTACT_ROLE);
        await this.#page.getByLabel(/preferred (method of )?contact/i).selectOption(PRIMARY_CONTACT_PREFERENCE);
      },
      /**
       * The phone is read back because it is the field most likely to be
       * reformatted, and because a reformat is the signal that digitsOnly() was
       * needed. Compared on digits so the portal adding its own punctuation does
       * not fail a step that actually succeeded.
       */
      postcondition: async () => {
        const actual = await this.#page
          .getByLabel(/phone/i)
          .first()
          .inputValue()
          .catch(() => '');
        return digitsOnly(actual) === phone;
      },
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /** Stage 3.4: products to quote, the SIC code and the cannabis question. */
  async selectProductsToQuote(payload: Payload): Promise<void> {
    const products = [...new Set(payload.policies.map((policy) => policy.benefitType))];

    await step(this.#steps, {
      name: 'select every product the group is quoting',
      precondition: async () => visible(this.#page.getByLabel(/sic/i), FIELD_TIMEOUT_MS),
      action: async () => {
        for (const product of products) {
          // TODO(remap): the runbook says "check every product offered". Whether
          // these are checkboxes named for the benefit type is unverified.
          await this.#page.getByRole('checkbox', { name: new RegExp(product, 'i') }).check();
        }
      },
      postcondition: async () =>
        this.#page
          .getByRole('checkbox', { name: new RegExp(products[0] ?? 'medical', 'i') })
          .isChecked()
          .catch(() => false),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'enter the SIC code',
      precondition: async () => visible(this.#page.getByLabel(/sic/i), FIELD_TIMEOUT_MS),
      /**
       * A typeahead, not a text field: the runbook notes the SIC "may need
       * typing before the dropdown offers a match". Typing alone leaves the
       * field looking filled while the portal holds no selection, so the
       * suggestion has to be clicked.
       */
      action: async () => {
        const field = this.#page.getByLabel(/sic/i);
        await field.click();
        await field.pressSequentially(payload.sicCode, { delay: 50 });
        // AUTO-HEALING SEAM: a fallback would look for a listbox option whose
        // text merely CONTAINS the code, in case SAMx renders "7311 - Advertising".
        await this.#page.getByRole('option', { name: new RegExp(payload.sicCode) }).first().click();
      },
      postcondition: async () => {
        const actual = await this.#page
          .getByLabel(/sic/i)
          .inputValue()
          .catch(() => '');
        return actual.includes(payload.sicCode);
      },
      /**
       * An invalid SIC is a Business failure. Anthem's portal rejects one with
       * "That SIC code isn't valid" - the same class of answer here, and the
       * kind of message that must not be retried three times as a system error.
       */
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'answer the cannabis-industry question',
      precondition: async () =>
        visible(this.#page.getByRole('group', { name: /cannabis/i }), FIELD_TIMEOUT_MS),
      action: async () =>
        this.#page
          .getByRole('group', { name: /cannabis/i })
          .getByRole('radio', { name: new RegExp(`^${CANNABIS_INDUSTRY}$`, 'i') })
          .check(),
      postcondition: async () =>
        this.#page
          .getByRole('group', { name: /cannabis/i })
          .getByRole('radio', { name: new RegExp(`^${CANNABIS_INDUSTRY}$`, 'i') })
          .isChecked()
          .catch(() => false),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /** Stage 3 ends by opening the census screen (bottom right of the form). */
  async openEmployeeCensus(): Promise<void> {
    await step(this.#steps, {
      name: 'open the employee census screen',
      precondition: async () =>
        visible(this.#page.getByRole('button', { name: /employee census/i }), FIELD_TIMEOUT_MS),
      action: async () => this.#page.getByRole('button', { name: /employee census/i }).click(),
      // TODO(remap): confirm what the census screen renders that nothing else does.
      postcondition: async () =>
        visible(this.#page.getByRole('button', { name: /upload/i }), SCREEN_TIMEOUT_MS),
      timeoutMs: SCREEN_STEP_TIMEOUT_MS,
    });
  }
}
