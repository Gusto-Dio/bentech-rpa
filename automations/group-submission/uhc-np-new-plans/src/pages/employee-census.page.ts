import { BusinessException, step, textVisible, visible, type StepContext } from '@rpa/core';
import path from 'node:path';
import type { Page } from 'playwright';
import { DOCUMENT_TIMEOUT_MS, FIELD_TIMEOUT_MS, SCREEN_STEP_TIMEOUT_MS, SCREEN_TIMEOUT_MS } from './samx-options.ts';

/**
 * Stage 4: the SAMx bulk census. Covers runbook stage 4.
 *
 * ── THE UPLOAD IS ALL-OR-NOTHING ─────────────────────────────────────────────
 * The runbook is explicit: if the template has any error, NO employee data
 * loads at all and the portal shows a popup listing every problem at once. That
 * shapes three things here:
 *
 *  - the postcondition counts LOADED employees rather than checking that an
 *    upload happened, because "uploaded" and "loaded" are different facts
 *  - the error popup becomes a BusinessException carrying the portal's own list,
 *    because the census data is wrong and no retry fixes wrong data
 *  - company-profile errors in that same popup are fixed from the Company
 *    Information page instead, which is why the message is passed through
 *    verbatim rather than summarised
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ EVERY LOCATOR IN THIS FILE IS AN UNVERIFIED HYPOTHESIS.
 */
export class EmployeeCensusPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  /**
   * Downloads the SAMx Portal Bulk Census template. Returns its path.
   *
   * The template is downloaded rather than reconstructed because it carries the
   * data validations and key sheets the upload validates against - a hand-built
   * workbook with the right headers is the classic way to get a file that
   * uploads "successfully" and renders an empty grid. See census/write-template.ts.
   */
  async downloadBulkCensusTemplate(downloadDir: string): Promise<string> {
    let saved: string | undefined;

    await step(this.#steps, {
      name: 'download the SAMx bulk census template',
      precondition: async () =>
        visible(this.#page.getByRole('link', { name: /bulk census|census template/i }), FIELD_TIMEOUT_MS),
      action: async () => {
        const download = this.#page.waitForEvent('download', { timeout: DOCUMENT_TIMEOUT_MS });
        await this.#page.getByRole('link', { name: /bulk census|census template/i }).click();
        const file = await download;
        saved = path.join(downloadDir, 'samx-bulk-census.template.xlsx');
        await file.saveAs(saved);
      },
      /**
       * `alwaysRun`, because the postcondition below can only ask "is there a
       * file on disk", and on a resumed run the file from the FIRST attempt is
       * already there - which would skip the download and then hand a stale
       * template to the transform. Re-downloading is cheap and reads nothing on
       * the portal, so there is no reason to take the skip.
       */
      postcondition: async () => saved !== undefined,
      alwaysRun: true,
      timeoutMs: DOCUMENT_TIMEOUT_MS + SCREEN_TIMEOUT_MS,
    });

    if (saved === undefined) {
      throw new BusinessException(
        'The SAMx bulk census template did not download, so there is nothing to fill in.',
      );
    }
    return saved;
  }

  /**
   * Uploads the filled template and confirms the employees actually loaded.
   *
   * `expectedEnrollees` is the number of ENROLLING EMPLOYEES the census
   * produced, not the payload's eligible count: the portal's counter reports
   * what it loaded, and comparing it against a number from a different source
   * would fail on every group with a waiver.
   */
  async uploadBulkCensus(templatePath: string, expectedEnrollees: number): Promise<void> {
    await step(this.#steps, {
      name: `upload the bulk census and confirm ${expectedEnrollees} employees loaded`,
      precondition: async () =>
        visible(this.#page.getByRole('button', { name: /upload/i }), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByRole('button', { name: /upload/i }).click();
        // The runbook's two-click path: UPLOAD, then the SAMx Template option.
        await this.#page.getByRole('button', { name: /samx template/i }).click();
        await this.#page.locator('input[type="file"]').setInputFiles(templatePath);
      },
      /**
       * The portal's own count, anchored on this group's number. A bare "the
       * grid has rows" would be satisfied by the previous group's census on a
       * resumed case - exactly the kind of vague postcondition that passes
       * while the screen is actually wrong.
       *
       * TODO(remap): the counter's wording is a guess. Anthem's equivalent reads
       * "N of M Employees Added"; read SAMx's during the re-map.
       */
      postcondition: async () =>
        textVisible(this.#page, new RegExp(`\\b${expectedEnrollees}\\b[^.]{0,40}employee`, 'i'), SCREEN_TIMEOUT_MS),
      businessCheck: async () => readCensusUploadErrors(this.#page),
      timeoutMs: SCREEN_STEP_TIMEOUT_MS,
    });
  }

  /** Stage 4 ends by moving on to plan selection. */
  async openPlanSelection(): Promise<void> {
    await step(this.#steps, {
      name: 'open plan selection',
      precondition: async () =>
        visible(this.#page.getByRole('button', { name: /plan selection/i }), FIELD_TIMEOUT_MS),
      action: async () => this.#page.getByRole('button', { name: /plan selection/i }).click(),
      postcondition: async () =>
        visible(this.#page.getByLabel(/rating (method|structure)/i), SCREEN_TIMEOUT_MS),
      timeoutMs: SCREEN_STEP_TIMEOUT_MS,
    });
  }
}

/**
 * Reads the census-upload error popup, which lists EVERY problem at once.
 *
 * Returned rather than thrown, so that `step()`'s businessCheck is the single
 * place that decides Business versus System - the same contract
 * `CarrierLoginFlow.readError` follows.
 *
 * The whole list is passed through verbatim. Summarising it would be actively
 * harmful: the operator's next move depends on which rows failed, and some of
 * these errors are fixed on the Company Information page rather than in the
 * census at all.
 *
 * TODO(remap): confirm the popup's container. `[role=dialog]` is the standards
 * answer and worth nothing until it has been seen.
 */
export async function readCensusUploadErrors(page: Page): Promise<string | undefined> {
  const popup = page.locator('[role="dialog"], [role="alertdialog"], .modal').first();
  if (!(await popup.isVisible().catch(() => false))) return undefined;

  const text = (await popup.textContent())?.replace(/\s+/g, ' ').trim();
  if (text === undefined || text.length === 0) return undefined;

  return `SAMx rejected the census upload, so no employee data loaded. The portal reported: ${text}`;
}
