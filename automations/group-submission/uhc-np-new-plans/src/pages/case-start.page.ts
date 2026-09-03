import { step, type StepContext } from '@rpa/core';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import type { Payload } from '../payload.ts';

/**
 * UHC SAMx - finding or creating the case, and assigning the owner.
 * Covers process-steps.md stages 2.1 - 2.2.
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
  readonly #config: AutomationConfig;

  constructor(page: Page, steps: StepContext, config: AutomationConfig) {
    this.#page = page;
    this.#steps = steps;
    this.#config = config;
  }

  /** Step 2.1.1: Small Group Quoting & Renewals -> Samx One -> New Business Dashboard. */
  async openNewBusinessDashboard(): Promise<void> {
    await step(this.#steps, {
      name: 'open the new business dashboard',
      precondition: async () =>
        this.#page.getByRole('link', { name: /Small Group Quoting & Renewals/i }).isVisible(),
      action: async () => {
        await this.#page.getByRole('link', { name: /Small Group Quoting & Renewals/i }).click();
        await this.#page.getByRole('link', { name: /Samx One/i }).click();
        await this.#page.getByRole('link', { name: /New Business Dashboard/i }).click();
      },
      // TODO(remap): confirm what the dashboard renders that nothing else does.
      postcondition: async () => this.#page.getByRole('button', { name: /New Case/i }).isVisible(),
    });
  }

  /**
   * Step 2.1.2: the resume path. Returns true when a case for this group already
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
      precondition: async () => this.#page.getByRole('button', { name: /Case Name/i }).isVisible(),
      action: async () => {
        await this.#page.getByRole('button', { name: /Case Name/i }).click();
        await this.#page.getByRole('textbox').first().fill(payload.companyName);
        await this.#page.keyboard.press('Enter');
      },
      // The search having *run* is the postcondition, not the group being found -
      // "not found" is a legitimate outcome that means "create a new case".
      postcondition: async () =>
        this.#page.getByRole('button', { name: /Case Name/i }).isVisible(),
      alwaysRun: true,
    });

    return caseLink.isVisible().catch(() => false);
  }

  /**
   * Step 2.1.3: New Case, only when the search found nothing.
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
      precondition: async () => this.#page.getByRole('button', { name: /New Case/i }).isVisible(),
      action: async () => this.#page.getByRole('button', { name: /New Case/i }).click(),
      postcondition: async () =>
        this.#page.getByRole('button', { name: /Edit Owners/i }).isVisible(),
      alwaysRun: true,
    });
  }

  /** Step 2.2: owner assignment - search the producer by name and assign. */
  async assignOwner(): Promise<void> {
    const fullName = `${this.#config.producerFirstName} ${this.#config.producerLastName}`;

    await step(this.#steps, {
      name: 'assign the producer as case owner',
      precondition: async () => this.#page.getByRole('button', { name: /Edit Owners/i }).isVisible(),
      action: async () => {
        await this.#page.getByRole('button', { name: /Edit Owners/i }).click();
        await this.#page.getByRole('button', { name: /Search Producers/i }).click();
        await this.#page.getByLabel(/First name/i).fill(this.#config.producerFirstName);
        await this.#page.getByLabel(/Last name/i).fill(this.#config.producerLastName);
        await this.#page.getByRole('button', { name: /^Search$/i }).click();
        await this.#page
          .getByRole('row', { name: new RegExp(fullName, 'i') })
          .getByRole('button', { name: /Assign/i })
          .click();
        await this.#page.getByRole('button', { name: /Save & Continue/i }).click();
      },
      postcondition: async () => this.#page.getByText(fullName).isVisible(),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }
}

/**
 * Reads SAMx's own validation message, if one is showing.
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
