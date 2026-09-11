import { step, textVisible, visible, valueIs, type StepContext } from '@rpa/core';
import type { Page } from 'playwright';
import type { Payload } from '../payload.ts';
import type { ProducerIdentity } from '../producer-identity.ts';
import { SIGNED_IN_LANDMARK } from './portal-origins.ts';

/**
 * UHC SAMx - finding or creating the case, and assigning the owner.
 * Covers runbook stages 2.1 - 2.3.
 *
 * ── WHY THIS SCREEN MATTERS MOST ─────────────────────────────────────────────
 * The runbook already anticipates a partially-automated case:
 *
 *   "If automation started the submission: search for your group by clicking
 *    Case Name. Skip to the step that automation stopped at."
 *
 * So resumability is not a nice-to-have invented here - the process was designed
 * around it. That is exactly what step()'s check-the-postcondition-first
 * behaviour provides: `findExistingCase` is the resume entry point, and every
 * later step skips itself when it has already been done.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ EVERY LOCATOR BELOW IS AN UNVERIFIED HYPOTHESIS, derived from a runbook
 * written before this code. Re-map against the live portal with Playwright MCP,
 * and record what differed in docs/poc/uhc-np-new-plans/drift-log.md.
 */


export class CaseStartPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  /** Stage 2.1: Small Group Quoting & Renewals -> Samx One -> New Business Dashboard. */
  async openNewBusinessDashboard(): Promise<void> {
    await step(this.#steps, {
      name: 'open the new business dashboard',
      precondition: async () =>
        visible(this.#page.getByRole('link', { name: SIGNED_IN_LANDMARK })),
      action: async () => {
        await this.#page.getByRole('link', { name: SIGNED_IN_LANDMARK }).click();
        await this.#page.getByRole('link', { name: /Samx One/i }).click();
        await this.#page.getByRole('link', { name: /New Business Dashboard/i }).click();
      },
      // TODO(remap): confirm what the dashboard renders that nothing else does.
      // AUTO-HEALING SEAM: a fallback would look for the dashboard's own heading
      // rather than a control, since New Case may move into a menu.
      postcondition: async () => visible(this.#page.getByRole('button', { name: /New Case/i })),
    });
  }

  /**
   * Stage 2.2: the resume path. Returns true when a case for this group already
   * exists, in which case the caller must NOT create a second one.
   *
   * Searching by company name is what the runbook says; searching by FEIN would
   * be safer if the dashboard supports it - worth checking during the re-map,
   * because two groups can share a name and no two share a FEIN.
   */
  async findExistingCase(payload: Payload): Promise<boolean> {
    const caseLink = this.#page.getByRole('link', { name: payload.companyName });

    await step(this.#steps, {
      name: 'search the dashboard for an existing case',
      precondition: async () => visible(this.#page.getByRole('button', { name: /Case Name/i })),
      action: async () => {
        await this.#page.getByRole('button', { name: /Case Name/i }).click();
        await this.#page.getByRole('textbox').first().fill(payload.companyName);
        await this.#page.keyboard.press('Enter');
      },
      /**
       * The search having RUN is the postcondition, not the group being found -
       * "not found" is a legitimate outcome that means "create a new case".
       * Reading back the search box is what proves the search ran with this
       * group's name in it, which a bare "the button is still there" does not.
       */
      postcondition: async () =>
        valueIs(this.#page.getByRole('textbox').first(), payload.companyName),
      alwaysRun: true,
    });

    /**
     * Outside a gate, so isVisible() is the right call here: this is a question
     * whose "no" is a real answer, and waiting five seconds for the absence of a
     * link would slow every new group down for nothing. The search has already
     * been confirmed to have run.
     */
    return caseLink.isVisible().catch(() => false);
  }

  /**
   * Stage 2.2: New Case, only when the search found nothing.
   *
   * The one step in this file whose postcondition CANNOT be
   * transaction-specific: the group is not identified until the employer
   * information screen that follows, so there is nothing from the payload to
   * anchor on yet. That is exactly what `alwaysRun` exists for - and it is why
   * the caller must gate this behind findExistingCase(), rather than relying on
   * the skip-ahead to avoid creating a duplicate case.
   */
  async createNewCase(): Promise<void> {
    await step(this.#steps, {
      name: 'create a new case',
      precondition: async () => visible(this.#page.getByRole('button', { name: /New Case/i })),
      action: async () => this.#page.getByRole('button', { name: /New Case/i }).click(),
      postcondition: async () => visible(this.#page.getByRole('button', { name: /Edit Owners/i })),
      alwaysRun: true,
    });
  }

  /** Stage 2.3: owner assignment - search the producer by name and assign. */
  async assignOwner(producer: ProducerIdentity): Promise<void> {
    await step(this.#steps, {
      name: 'assign the producer as case owner',
      precondition: async () => visible(this.#page.getByRole('button', { name: /Edit Owners/i })),
      action: async () => {
        await this.#page.getByRole('button', { name: /Edit Owners/i }).click();
        await this.#page.getByRole('button', { name: /Search Producers/i }).click();
        await this.#page.getByLabel(/First name/i).fill(producer.firstName);
        await this.#page.getByLabel(/Last name/i).fill(producer.lastName);
        await this.#page.getByRole('button', { name: /^Search$/i }).click();
        await this.#page
          .getByRole('row', { name: new RegExp(producer.fullName, 'i') })
          .getByRole('button', { name: /Assign/i })
          .click();
        await this.#page.getByRole('button', { name: /Save & Continue/i }).click();
      },
      postcondition: async () => textVisible(this.#page, producer.fullName),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }
}

/**
 * Reads SAMx's own validation message, if one is showing.
 *
 * `isVisible()` is correct here and must stay: this is not a gate. A gate asks
 * "has the screen got there yet?" and has to wait; this asks "is the portal
 * complaining right now?", and waiting for an error that is legitimately absent
 * would add the gate timeout to every successful step in the automation.
 *
 * TODO(remap): confirm the error container. This is the highest-value locator in
 * the whole automation - it is what separates "the portal refused this group's
 * data" (Business) from "the portal is broken" (System).
 */
export async function readPortalValidationError(page: Page): Promise<string | undefined> {
  const error = page.locator('[role="alert"], .alert-danger, .error-text').first();
  if (!(await error.isVisible().catch(() => false))) return undefined;
  const text = (await error.textContent())?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

/** Strips the formatting SAMx refuses to accept in a phone field (runbook 3.3). */
export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, '');
}
