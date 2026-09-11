import { BusinessException, step, visible, valueIs, type StepContext } from '@rpa/core';
import path from 'node:path';
import type { Page } from 'playwright';
import type { EmployerContribution } from '../derived.ts';
import type { Payload } from '../payload.ts';
import { readPortalValidationError } from './case-start.page.ts';
import {
  DOCUMENT_TIMEOUT_MS,
  FIELD_TIMEOUT_MS,
  SCREEN_STEP_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
} from './samx-options.ts';

/**
 * Stage 5: plan selection, contribution, TIN and the proposal.
 * Covers runbook stage 5.
 *
 * ── THE RIDER TRAP ───────────────────────────────────────────────────────────
 * Plans must be selected WITH the domestic-partner rider and NEVER with the
 * "aged 29" rider (shown in orange above the rate). Picking the wrong one
 * produces a valid-looking quote for the wrong coverage - the worst kind of
 * failure, because nothing errors and the group is rated correctly for coverage
 * it did not ask for.
 *
 * So the postcondition asserts the RIDER, not that a plan is selected, and it
 * asserts the aged-29 rider is NOT selected. A postcondition that only checks
 * the thing you wanted would pass on exactly the failure this guards against.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ EVERY LOCATOR IN THIS FILE IS AN UNVERIFIED HYPOTHESIS.
 */

/** TODO(remap): the runbook names these riders; SAMx's exact label text is unverified. */
export const DOMESTIC_PARTNER_RIDER = /domestic partner/i;
export const AGED_29_RIDER = /aged?\s*29/i;

export class PlanSelectionPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  /**
   * Confirms the rating method matches the payload.
   *
   * Called BEFORE and AFTER plan selection, deliberately. The runbook insists on
   * both, and that phrasing usually means it has silently reset on somebody - so
   * the second call is not redundant defensiveness, it is the only thing that
   * catches a reset. `alwaysRun` is required for the same reason: the default
   * skip-ahead would see the method already correct from the first call and skip
   * the check that exists to detect it changing.
   */
  async confirmRatingMethod(payload: Payload): Promise<void> {
    await step(this.#steps, {
      name: `confirm the rating method is ${payload.ratingStructure}`,
      precondition: async () =>
        visible(this.#page.getByLabel(/rating (method|structure)/i), FIELD_TIMEOUT_MS),
      action: async () =>
        this.#page.getByLabel(/rating (method|structure)/i).selectOption({ label: ratingMethodLabel(payload) }),
      postcondition: async () =>
        valueIs(this.#page.getByLabel(/rating (method|structure)/i), ratingMethodLabel(payload)),
      businessCheck: async () => readPortalValidationError(this.#page),
      alwaysRun: true,
    });
  }

  /**
   * Selects every plan in the payload, each with the domestic-partner rider.
   *
   * One step per plan rather than one step for all of them, so the log names
   * which plan failed and so a resumed run skips only the plans already done.
   */
  async selectPlansWithRiders(payload: Payload): Promise<void> {
    for (const policy of payload.policies) {
      const planRow = this.#page.getByRole('row', { name: new RegExp(escapeRegExp(policy.planName), 'i') });

      await step(this.#steps, {
        name: `select ${policy.planName} with the domestic-partner rider`,
        precondition: async () => visible(this.#page.getByLabel(/filter|search plans/i), FIELD_TIMEOUT_MS),
        action: async () => {
          // The runbook filters by pasting the plan name, which is why the whole
          // name is used rather than the plan code.
          await this.#page.getByLabel(/filter|search plans/i).fill(policy.planName);
          await planRow.getByRole('checkbox', { name: DOMESTIC_PARTNER_RIDER }).check();
        },
        /**
         * Both halves matter. Asserting only that the domestic-partner rider is
         * on would pass a row that ALSO carries aged-29, which is the exact
         * mis-selection this stage exists to avoid.
         */
        postcondition: async () => {
          const wanted = await planRow
            .getByRole('checkbox', { name: DOMESTIC_PARTNER_RIDER })
            .isChecked()
            .catch(() => false);
          const forbidden = await planRow
            .getByRole('checkbox', { name: AGED_29_RIDER })
            .isChecked()
            .catch(() => false);
          return wanted && !forbidden;
        },
        /**
         * A plan the portal does not offer is a Business failure - UHC does not
         * sell it to this group, and no retry changes that.
         */
        businessCheck: async () => {
          if (await visible(planRow, FIELD_TIMEOUT_MS)) return readPortalValidationError(this.#page);
          return (
            `Plan "${policy.planName}" (${policy.planCode}) is not offered in the SAMx plan list for ` +
            'this group, so it cannot be quoted.'
          );
        },
        timeoutMs: SCREEN_STEP_TIMEOUT_MS,
      });
    }
  }

  /**
   * Re-selects the plans on the Quote Review screen.
   *
   * The runbook has them selected twice - once to quote, once on review - which
   * reads like a portal quirk rather than a mistake in the runbook. Kept as its
   * own step so that if the re-map finds the selection carries over, deleting
   * one call is a one-line change rather than untangling a loop.
   */
  async confirmPlansOnQuoteReview(payload: Payload): Promise<void> {
    for (const policy of payload.policies) {
      const planRow = this.#page.getByRole('row', { name: new RegExp(escapeRegExp(policy.planName), 'i') });

      await step(this.#steps, {
        name: `confirm ${policy.planName} on the quote review`,
        precondition: async () => visible(planRow, FIELD_TIMEOUT_MS),
        action: async () => planRow.getByRole('checkbox').first().check(),
        postcondition: async () =>
          planRow
            .getByRole('checkbox')
            .first()
            .isChecked()
            .catch(() => false),
        businessCheck: async () => readPortalValidationError(this.#page),
      });
    }
  }

  /**
   * Enters the employer contribution percentages.
   *
   * `contribution` is computed and logged by the caller - see
   * `employerContribution` in derived.ts. The runbook's two overrides (a
   * flat-dollar contribution entered as 50%, a California group at 100% entered
   * as 99%) are decisions, so they are made and recorded in one tested place
   * rather than inlined at the point of typing.
   */
  async setEmployerContribution(
    contribution: EmployerContribution,
    dependentPercentage: number,
  ): Promise<void> {
    const employee = String(contribution.percentage);
    const dependent = String(dependentPercentage);

    await step(this.#steps, {
      name: `set the employer contribution to ${employee}% (${contribution.rule})`,
      precondition: async () =>
        visible(this.#page.getByLabel(/employee contribution/i), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByLabel(/employee contribution/i).fill(employee);
        await this.#page.getByLabel(/dependent contribution/i).fill(dependent);
      },
      postcondition: async () =>
        valueIs(this.#page.getByLabel(/employee contribution/i), employee),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /** The employer-contribution screenshot the runbook asks for by name. */
  async captureContributionEvidence(reference: string, artifactsDir: string): Promise<string> {
    const file = path.join(artifactsDir, `${reference}-employer-contribution.png`);
    await this.#page.screenshot({ path: file, fullPage: true });
    return file;
  }

  /** Enters the TIN, saves, then generates and keeps the proposal PDF. */
  async enterTinAndGenerateProposal(payload: Payload, downloadDir: string): Promise<string> {
    await step(this.#steps, {
      name: 'enter the TIN and save the quote',
      precondition: async () => visible(this.#page.getByLabel(/tin|tax id/i), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByLabel(/tin|tax id/i).fill(payload.fein);
        await this.#page.getByRole('button', { name: /^save$/i }).click();
      },
      /**
       * Read back the FEIN, which is this group's own value - a bare "Saved"
       * toast would be satisfied by any group's save on a resumed case.
       */
      postcondition: async () => valueIs(this.#page.getByLabel(/tin|tax id/i), payload.fein),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    let saved: string | undefined;

    await step(this.#steps, {
      name: 'generate the proposal PDF',
      precondition: async () =>
        visible(this.#page.getByRole('button', { name: /generate proposal/i }), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByRole('button', { name: /generate proposal/i }).click();
        const download = this.#page.waitForEvent('download', { timeout: DOCUMENT_TIMEOUT_MS });
        await this.#page.getByRole('button', { name: /^generate$/i }).click();
        await this.#page.getByRole('button', { name: /pdf/i }).click();
        const file = await download;
        saved = path.join(downloadDir, `${payload.companyID}-uhc-proposal.pdf`);
        await file.saveAs(saved);
      },
      postcondition: async () => saved !== undefined,
      // The proposal is regenerated rather than skipped on a resumed run: the
      // file from a previous attempt may predate a plan or contribution change.
      alwaysRun: true,
      timeoutMs: DOCUMENT_TIMEOUT_MS + SCREEN_TIMEOUT_MS,
    });

    if (saved === undefined) {
      throw new BusinessException('The SAMx proposal did not download, so there is no quote to keep.');
    }
    return saved;
  }

  async moveToEnrollment(): Promise<void> {
    await step(this.#steps, {
      name: 'move the case to enrollment',
      precondition: async () =>
        visible(this.#page.getByRole('button', { name: /move to enrollment/i }), FIELD_TIMEOUT_MS),
      action: async () => this.#page.getByRole('button', { name: /move to enrollment/i }).click(),
      // TODO(remap): confirm the first employer-application screen's landmark.
      postcondition: async () =>
        visible(this.#page.getByLabel(/group name.*id card|years in business/i), SCREEN_TIMEOUT_MS),
      businessCheck: async () => readPortalValidationError(this.#page),
      timeoutMs: SCREEN_STEP_TIMEOUT_MS,
    });
  }
}

/**
 * `age_banded` -> the portal's own words for it.
 *
 * TODO(remap): the two labels are the runbook's ("Age-banded" and "Composite").
 * Confirm the exact casing and hyphenation against the dropdown, because
 * `selectOption({ label })` matches exactly.
 */
export function ratingMethodLabel(payload: Payload): string {
  return payload.ratingStructure === 'age_banded' ? 'Age-banded' : 'Composite';
}

/**
 * Plan names carry regex metacharacters - "Choice Plus Silver 5000-4 (EPHE)".
 *
 * Without escaping, those parentheses become a capture group and the row locator
 * silently stops matching the plan it was built for, which would present as
 * "UHC does not offer this plan".
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
