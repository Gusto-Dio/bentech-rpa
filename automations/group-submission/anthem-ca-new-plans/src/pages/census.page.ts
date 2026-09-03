import type { HippoCensusRow } from '@auto/group-submission-shared';
import { BusinessException, step, textVisible, visible, type StepContext } from '@rpa/core';
import path from 'node:path';
import type { Page } from 'playwright';
import { buildAnthemCensusRows } from '../census/quoting-tab.ts';
import { writeAnthemCensus } from '../census/write-template.ts';
import { FIELD_TIMEOUT_MS, SCREEN_TIMEOUT_MS, button, stepIs } from './lightning.ts';
import { readPortalValidationError } from './portal-errors.ts';

/**
 * `Employee Census` - download Anthem's template, fill it, upload it.
 *
 * The step also offers manual per-person entry (`Add Employee` /
 * `+ Add Dependent`). The template round-trip is used instead because it is the
 * documented process and because it scales past the two-person demo group.
 *
 * Verified end to end against the live portal 2026-09-03: a file produced by
 * `writeAnthemCensus` was accepted and parsed, and the grid showed both
 * enrolling employees with the right gender, DOB and coverage tier.
 */
export class CensusPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  /**
   * Downloads Anthem's own template, and returns where it landed.
   *
   * Anthem's file is filled rather than a lookalike being generated, because
   * the workbook carries data validations and a `Key` sheet that the upload
   * checks against. A hand-built workbook with the right headers is the classic
   * way to produce a file that uploads "successfully" into an empty grid.
   */
  async downloadTemplate(downloadDir: string): Promise<string> {
    const result = await step<string>(this.#steps, {
      name: 'download the Anthem census template',
      precondition: async () =>
        visible(button(this.#page, 'Download Template'), SCREEN_TIMEOUT_MS),
      action: async () => {
        const pending = this.#page.waitForEvent('download', { timeout: 60_000 });
        await button(this.#page, 'Download Template').first().click();
        const download = await pending;
        const to = path.join(downloadDir, download.suggestedFilename());
        await download.saveAs(to);
        return to;
      },
      // The file either arrived or the action threw; there is nothing on the
      // page to read back, so this cannot be transaction-specific.
      alwaysRun: true,
      postcondition: async () => true,
    });

    if (result.value === undefined) {
      throw new BusinessException('The census template download produced no file.');
    }
    return result.value;
  }

  /**
   * Fills the template from the Hippo census and uploads it.
   *
   * ENROLLING people only - the split is `Waiver Reason - Medical` being
   * populated, and it happens here, once, so exactly one place decides who is
   * enrolling.
   */
  /**
   * Fills the template from the already-parsed census and uploads it.
   *
   * The enrolling/waiving split is done ONCE by the caller and handed in, so
   * exactly one place decides who is enrolling - and so this does not have to
   * guess where the census file lives. It guessed before, from the artifacts
   * directory, and resolved to a path that does not exist.
   */
  async fillAndUpload(
    enrolling: readonly HippoCensusRow[],
    templatePath: string,
    outputDir: string,
  ): Promise<string> {
    if (enrolling.length === 0) {
      throw new BusinessException('Every person on the census is waiving, so there is nobody to quote.');
    }

    const filled = path.join(outputDir, 'anthem-census-filled.xlsx');
    await writeAnthemCensus(templatePath, filled, buildAnthemCensusRows(enrolling));

    await step(this.#steps, {
      name: 'upload the completed census',
      precondition: async () =>
        visible(button(this.#page, /Upload Completed Census/i), FIELD_TIMEOUT_MS),
      action: async () => {
        await button(this.#page, /Upload Completed Census/i).first().click();
        await this.#page.locator('input[type=file]').filter({ visible: true }).first().setInputFiles(filled);
      },
      /**
       * The portal's own counter, anchored on THIS group's enrolling count.
       *
       * "the grid is not empty" would be satisfied by the previous group's
       * census, and a malformed template uploads happily into an empty grid -
       * which is the failure actually worth catching here.
       */
      postcondition: async () =>
        textVisible(this.#page, new RegExp(`${enrolling.length} of \\d+ Employees Added`), SCREEN_TIMEOUT_MS),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    return filled;
  }

  async continueToPlans(): Promise<void> {
    await step(this.#steps, {
      name: 'complete the employee census',
      precondition: async () => visible(button(this.#page, 'Continue'), FIELD_TIMEOUT_MS),
      action: async () => button(this.#page, 'Continue').last().click(),
      alwaysRun: true,
      postcondition: async () => stepIs(this.#page, 'Employee Census', 'Completed'),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }
}
