import { BusinessException, step, textVisible, valueIs, visible, type StepContext } from '@rpa/core';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import type { ProducerIdentity } from '../producer-identity.ts';
import type { Payload } from '../payload.ts';
import {
  FIELD_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
  answer,
  button,
  isAnswered,
  sameDigits,
  stepIs,
  type as typeInto,
  field,
} from '@auto/group-submission-shared';
import { readPortalValidationError } from './portal-errors.ts';

/**
 * `Group Setup` - the first step of Anthem's Salesforce quoting wizard.
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
 * The runbook's stage 2.2 (license & contract validation), 2.3 (group account)
 * and part of stage 6 (group contact) were three separate Producer Toolbox
 * screens. On the new platform they are ONE form with three sections:
 * Group Details, Group & Contact Information, and Agent Details.
 *
 * Mapped against the live portal 2026-09-03. See drift-log.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class GroupSetupPage {
  readonly #page: Page;
  readonly #steps: StepContext;
  readonly #config: AutomationConfig;
  readonly #producer: ProducerIdentity;

  constructor(
    page: Page,
    steps: StepContext,
    config: AutomationConfig,
    producer: ProducerIdentity,
  ) {
    this.#page = page;
    this.#steps = steps;
    this.#config = config;
    this.#producer = producer;
  }

  /**
   * The two qualifying questions, which gate everything below them.
   *
   * Both are "No" for a new-plan group: it is not already an Anthem client, and
   * we have not quoted it before. They are answered one at a time because the
   * second only renders once the first is answered.
   */
  async answerQualifyingQuestions(): Promise<void> {
    await step(this.#steps, {
      name: 'answer: is the group currently covered by Anthem',
      precondition: async () =>
        visible(this.#page.getByText('Group Details').first(), SCREEN_TIMEOUT_MS),
      action: async () => answer(this.#page, /currently covered by Anthem/i, 'No'),
      postcondition: async () => isAnswered(this.#page, /currently covered by Anthem/i, 'No'),
    });

    await step(this.#steps, {
      name: 'answer: have you quoted this group before',
      precondition: async () =>
        visible(this.#page.locator('fieldset').filter({ hasText: /quoted this group/i }), FIELD_TIMEOUT_MS),
      action: async () => answer(this.#page, /quoted this group with us before/i, 'No'),
      postcondition: async () => isAnswered(this.#page, /quoted this group with us before/i, 'No'),
    });
  }

  /**
   * Commits the county.
   *
   * The ZIP lookup fills `*Group County` so it LOOKS answered - the box reads
   * "SAN FRANCISCO" - but nothing is committed and Continue refuses with
   * "Error: Please select a county." That is the Vlocity combobox trap in its
   * purest form: `value` is populated for display while `data-value` is empty.
   *
   * The option text is the portal's, not the payload's: it comes back uppercase
   * and without the word "County" (`SAN FRANCISCO` for `San Francisco County`),
   * so the payload value is normalised rather than matched verbatim.
   */
  async selectCounty(payload: Payload): Promise<void> {
    const county = payload.county.replace(/\s+county$/i, '').trim();
    const asShown = new RegExp(`^${county.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

    /**
     * The county is a BUTTON showing the value the ZIP lookup found, not a
     * labelled input - `getByLabel` finds nothing, because the only county in
     * the field list is the READONLY mirror further down the form.
     *
     * It is usually already committed: a full pass through Group Setup
     * completes without touching it. But it is NOT always - the portal has been
     * seen refusing Continue with "Error: Please select a county", presumably
     * when the lookup had not settled. So this confirms rather than assumes,
     * and opening a picker that turns out to have no list is a no-op rather
     * than a failure. Failing here would abandon a submission over a field the
     * portal had already filled in correctly.
     */
    await step(this.#steps, {
      name: 'confirm the group county',
      precondition: async () => visible(button(this.#page, asShown), FIELD_TIMEOUT_MS),
      action: async () => {
        await button(this.#page, asShown).first().click().catch(() => undefined);
        await this.#page
          .locator('[role=option], li, label[role=option]')
          .filter({ hasText: asShown })
          .filter({ visible: true })
          .first()
          .click({ timeout: 4_000 })
          .catch(() => undefined);
      },
      // The button reads the same before and after committing, so there is
      // nothing for the skip-ahead check to distinguish.
      alwaysRun: true,
      postcondition: async () => visible(button(this.#page, asShown), FIELD_TIMEOUT_MS),
    });
  }

  /**
   * Reveals the rest of the form.
   *
   * `Group Setup` opens showing only the two qualifying questions; the contact
   * and agent sections are not in the DOM until the form is expanded. Observed
   * live: answering both questions and pressing Continue expands it in place
   * rather than advancing the wizard - the step rail still reads
   * `Group Setup In Progress` afterwards.
   *
   * The Continue is conditional, because on a resumed run the form is already
   * expanded and pressing it again WOULD advance past a half-filled screen.
   */
  async expandForm(): Promise<void> {
    await step(this.#steps, {
      name: 'expand the group setup form',
      action: async () => {
        if (await visible(field(this.#page, 'Main Phone Number'), 3_000)) return;
        await button(this.#page, 'Continue').last().click();
      },
      alwaysRun: true,
      postcondition: async () => visible(field(this.#page, 'Main Phone Number'), SCREEN_TIMEOUT_MS),
      /**
       * NO businessCheck here, deliberately. Pressing Continue on a form that
       * is empty by design makes the portal shout "Group Contact Name is
       * required" - which is true, expected, and about to be fixed by the very
       * next steps. Treating it as a Business failure would abandon a perfectly
       * healthy submission over a message we caused on purpose.
       */
    });
  }

  /** Group Details: name, tax id, ZIP. The rest of the form derives from these. */
  async enterGroupDetails(payload: Payload): Promise<void> {
    if (payload.companyName.length > this.#config.maxGroupNameLength) {
      throw new BusinessException(
        `Group name is ${payload.companyName.length} characters; Anthem accepts at most ` +
          `${this.#config.maxGroupNameLength}. Shortening it is a judgement call for a human, not this automation.`,
        { details: { companyName: payload.companyName, limit: this.#config.maxGroupNameLength } },
      );
    }

    await step(this.#steps, {
      name: 'enter the group name',
      precondition: async () => visible(field(this.#page, '*Group Name'), FIELD_TIMEOUT_MS),
      action: async () => typeInto(this.#page, '*Group Name', payload.companyName),
      postcondition: async () => valueIs(field(this.#page, '*Group Name'), payload.companyName),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'enter the employer tax id',
      precondition: async () => visible(field(this.#page, 'Employer Tax ID'), FIELD_TIMEOUT_MS),
      action: async () => typeInto(this.#page, 'Employer Tax ID', payload.fein),
      postcondition: async () => valueIs(field(this.#page, 'Employer Tax ID'), payload.fein),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'enter the group zip code',
      precondition: async () => visible(field(this.#page, '*Group ZIP Code'), FIELD_TIMEOUT_MS),
      action: async () => typeInto(this.#page, '*Group ZIP Code', payload.zip),
      postcondition: async () => valueIs(field(this.#page, '*Group ZIP Code'), payload.zip),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Group & Contact Information.
   *
   * `Group Name`, `State`, `Group ZIP code` and `Group County` are READONLY -
   * the portal derives them from Group Details plus a ZIP lookup, and County
   * comes back uppercase without the word "County". They are deliberately not
   * filled and not asserted against the payload.
   */
  async enterContactInformation(payload: Payload): Promise<void> {
    const contactName = `${payload.benefitsAdmin.firstName} ${payload.benefitsAdmin.lastName}`;

    await step(this.#steps, {
      name: 'enter the main phone number',
      precondition: async () => visible(field(this.#page, 'Main Phone Number'), FIELD_TIMEOUT_MS),
      action: async () => typeInto(this.#page, 'Main Phone Number', payload.companyPhoneNumber),
      // The portal reformats to (303) 555-1234, so compare digits.
      postcondition: async () =>
        sameDigits(
          await field(this.#page, 'Main Phone Number').first().inputValue(),
          payload.companyPhoneNumber,
        ),
    });

    await step(this.#steps, {
      name: 'enter the group contact',
      precondition: async () => visible(field(this.#page, '*Group Contact Name'), FIELD_TIMEOUT_MS),
      action: async () => {
        await typeInto(this.#page, '*Group Contact Name', contactName);
        await typeInto(this.#page, 'Title', payload.benefitsAdmin.title);
        await typeInto(this.#page, 'Contact Phone Number', payload.companyPhoneNumber);
        await typeInto(this.#page, 'Contact Email Address', payload.benefitsAdmin.email);
      },
      postcondition: async () => valueIs(field(this.#page, '*Group Contact Name'), contactName),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    const address = [payload.streetAddress1, payload.streetAddress2].filter(Boolean).join(' ');
    if (address.length > this.#config.maxAddressLength) {
      throw new BusinessException(
        `Group address is ${address.length} characters; Anthem's limit is ${this.#config.maxAddressLength} ` +
          'including spaces. See the FAQ in process-steps.md for the two accepted workarounds.',
        { details: { address, limit: this.#config.maxAddressLength } },
      );
    }

    await step(this.#steps, {
      name: 'enter the group address',
      precondition: async () => visible(field(this.#page, 'Street Address'), FIELD_TIMEOUT_MS),
      action: async () => {
        await typeInto(this.#page, 'Street Address', address);
        await typeInto(this.#page, 'City', payload.city);
      },
      postcondition: async () => valueIs(field(this.#page, 'Street Address'), address),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Agent Details.
   *
   * The writing agent is a typeahead over `li` results and it matches BOTH
   * people and agencies. The producer's FULL name is typed, because the first
   * name alone returns seven unrelated agencies. The portal resolves the
   * producer WITH a middle initial, so the displayed string is not the
   * configured `first last` and the postcondition anchors on the surname.
   *
   * Paid Agency auto-populates from the writing agent, and General Agency stays
   * `--None--` - which is what triggers the modal below.
   */
  async selectWritingAgent(): Promise<void> {
    const producer = `${this.#producer.firstName} ${this.#producer.lastName}`;

    await step(this.#steps, {
      name: 'select the writing agent',
      precondition: async () =>
        // filter({visible}) for the same reason field() exists: the hidden
        // pre-rendered branches include their own search inputs, and .first()
        // lands on one of those.
        visible(this.#page.locator('input[type=search]').filter({ visible: true }), FIELD_TIMEOUT_MS),
      action: async () => {
        const search = this.#page.locator('input[type=search]').filter({ visible: true }).first();
        await search.click();
        await search.fill('');
        await search.pressSequentially(producer, { delay: 60 });
        await this.#page
          .getByRole('listitem')
          .filter({ hasText: this.#producer.lastName })
          .first()
          .click();
      },
      /**
       * The chosen agent lands in the search input's VALUE, not as text on
       * the page - a `getByText` on the surname finds nothing and the step
       * reports "did not take effect" on a selection that worked. Matched on
       * the surname because the portal returns the producer with a middle
       * initial, so the configured full name is not the displayed string.
       */
      postcondition: async () => {
        const shown = await this.#page
          .locator('input[type=search]')
          .filter({ visible: true })
          .first()
          .inputValue()
          .catch(() => '');
        return shown.toLowerCase().includes(this.#producer.lastName.toLowerCase());
      },
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'confirm the paid agency auto-populated',
      // Nothing to do: selecting the writing agent fills this. The step exists
      // so a change in that behaviour fails here, naming the agency, rather
      // than surfacing three screens later as a wrong commission split.
      action: async () => undefined,
      alwaysRun: true,
      postcondition: async () =>
        textVisible(this.#page, this.#producer.agencyCode, FIELD_TIMEOUT_MS),
    });
  }

  /**
   * Leaves Group Setup.
   *
   * Blank General Agency - which the runbook REQUIRES - pops "No General Agency
   * Selected… Do you want to select a GA?". Answering `No, Continue` is the
   * runbook's intent. An automation that does not expect it hangs on a Continue
   * that appears to do nothing.
   */
  async continueToPortfolios(): Promise<void> {
    await step(this.#steps, {
      name: 'complete group setup',
      precondition: async () => visible(button(this.#page, 'Continue'), FIELD_TIMEOUT_MS),
      action: async () => {
        await button(this.#page, 'Continue').last().click();
        await dismissGeneralAgencyPrompt(this.#page);
      },
      alwaysRun: true,
      postcondition: async () => stepIs(this.#page, 'Group Setup', 'Completed'),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }
}

/** Exported for the resume path, where the modal can appear on its own. */
export async function dismissGeneralAgencyPrompt(page: Page): Promise<void> {
  const modal = page.locator('section.slds-modal.slds-fade-in-open');
  if (!(await visible(modal, 8_000))) return;
  await button(page, 'No, Continue').first().click().catch(() => undefined);
}
