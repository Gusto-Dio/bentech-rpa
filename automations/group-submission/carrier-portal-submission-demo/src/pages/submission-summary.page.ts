import { SystemException } from '@rpa/core';
import type { Page } from 'playwright';

/** Step two: the carrier's quote, and the irreversible submit. */
export class SubmissionSummaryPage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  /**
   * Parses the quoted total into cents. Currency is read as text because that
   * is all the portal exposes; anything unparseable is treated as a System
   * problem, since submitting a group against a total we could not read would
   * be worse than retrying.
   */
  async readTotalCents(): Promise<number> {
    const label = this.#page.locator('[data-test="total-label"], .summary_total_label');
    await label.waitFor({ state: 'visible' });

    const text = (await label.textContent())?.trim() ?? '';
    const match = /([0-9]+(?:\.[0-9]{1,2})?)/.exec(text.replace(/,/g, ''));
    if (match?.[1] === undefined) {
      throw new SystemException(`Could not read the quoted total from "${text}"`);
    }

    return Math.round(Number(match[1]) * 100);
  }

  async submit(): Promise<void> {
    await this.#page.getByRole('button', { name: 'Finish' }).click();
  }

  /** The carrier's acknowledgement. Absent means the submission did not land. */
  async confirmation(): Promise<string> {
    const header = this.#page.locator('[data-test="complete-header"], .complete-header');
    try {
      await header.waitFor({ state: 'visible' });
    } catch (cause) {
      throw new SystemException('Portal did not acknowledge the submission', { cause });
    }
    return (await header.textContent())?.trim() ?? '';
  }
}
