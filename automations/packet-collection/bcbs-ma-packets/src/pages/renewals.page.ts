import { BusinessException, SystemException } from '@rpa/core';
import type { Locator, Page } from 'playwright';

/**
 * The Renewals -> Account -> Quote -> Proposal Documents drill-down.
 *
 * One page object for the whole chain, not one per screen: in the source
 * portal this is a single continuous flow a user reaches by clicking
 * forward, not a set of pages someone could land on independently.
 *
 * Confirmed against the live portal: several controls the UiPath original
 * treated as single elements resolve to TWO matches here (the app keeps a
 * previous tab's DOM mounted but hidden rather than removing it). Every
 * lookup below picks the first genuinely *visible* match rather than
 * assuming there is only one.
 */
export class RenewalsPage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  /**
   * `.count()` is a snapshot, not an auto-waiting query - calling it right
   * after a tab click, before the panel has rendered, reads as "nothing
   * here" even though the element appears a moment later. Poll until
   * timeoutMs instead of counting once.
   */
  async #firstVisible(locator: Locator, timeoutMs = 5000): Promise<Locator | null> {
    const deadline = Date.now() + timeoutMs;
    do {
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const candidate = locator.nth(i);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
      await this.#page.waitForTimeout(200);
    } while (Date.now() < deadline);
    return null;
  }

  /** Every transaction starts here - a known state, regardless of how the previous one ended. */
  async openRenewals(): Promise<void> {
    await this.#page.getByRole('tab', { name: 'Renewals' }).click();
    await this.#page.waitForLoadState('networkidle').catch(() => {});

    // The search box paints before the list view's controller has wired its
    // keyboard handlers - typing into it that early leaves the value visible
    // but never filters anything (confirmed live). There is no DOM signal for
    // "the controller finished initializing", but real row data only renders
    // once it has, so a data row appearing is the actual readiness condition -
    // not a guess at how long that takes.
    const firstRow = await this.#firstVisible(this.#page.getByRole('grid').getByRole('link'), 20000);
    if (firstRow === null) {
      throw new SystemException('Renewals list never rendered any rows');
    }
  }

  async searchGroup(groupName: string): Promise<void> {
    const search = await this.#firstVisible(this.#page.getByPlaceholder('Search this list...'));
    if (search === null) throw new SystemException('Renewals search box did not appear');
    // This list only reacts to real keystrokes, not a value set via .fill() -
    // confirmed live: .fill() left the value visible in the box but never
    // filtered the list at all.
    await search.click();
    await search.pressSequentially(groupName, { delay: 50 });
    await search.press('Enter');
    // No fixed pause here: openGroupAccount() polls for the filtered row
    // until it appears (or times out), which is the actual condition worth
    // waiting on rather than a guess at how long filtering takes.
  }

  async openGroupAccount(groupName: string): Promise<void> {
    const row = await this.#firstVisible(this.#page.getByRole('link', { name: groupName, exact: true }), 10000);
    if (row === null) {
      // The rule says no: this group has no row in the Renewals list at all.
      // Retrying finds the same nothing.
      throw new BusinessException(`Group not found in Renewals: ${groupName}`);
    }
    await row.click();
  }

  async openQuotesTab(groupName: string): Promise<void> {
    await this.#page.getByRole('tab', { name: 'Quotes' }).click();

    const quote = await this.#firstVisible(this.#page.getByRole('link', { name: new RegExp(groupName, 'i') }));
    if (quote === null) {
      throw new BusinessException('Group has no quote in Auto Renewed status');
    }
    await quote.click();
  }

  async downloadRenewalNotice(): Promise<Buffer> {
    await this.#page.getByRole('tab', { name: 'Proposal Documents' }).click();

    const notice = await this.#firstVisible(this.#page.getByText('BQR Renewal Notice', { exact: true }));
    if (notice === null) {
      // The carrier has not uploaded the packet yet. Nothing to retry -
      // this is checked again on the next scheduled run.
      throw new BusinessException('Renewal packet not yet available on the portal');
    }
    await notice.click();

    const downloadButton = await this.#firstVisible(this.#page.getByRole('button', { name: /download/i }));
    if (downloadButton === null) {
      throw new SystemException('Download control did not appear on the document preview');
    }

    const context = this.#page.context();
    const [result] = await Promise.all([
      Promise.race([
        context.waitForEvent('download', { timeout: 15000 }),
        context.waitForEvent('page', { timeout: 15000 }),
      ]),
      downloadButton.click(),
    ]);

    // Two ways this resolves, depending on whether Chromium treats the
    // document URL as an attachment (a real "download" event) or just
    // displays it (a new tab showing the raw PDF url) - confirmed live,
    // this portal takes the second path.
    if ('suggestedFilename' in result) {
      const filePath = await result.path();
      if (filePath === null) throw new SystemException('Download produced no file path');
      const { readFile } = await import('node:fs/promises');
      return readFile(filePath);
    }

    const newPage = result as Page;
    const response = await context.request.get(newPage.url());
    await newPage.close().catch(() => {});
    return response.body();
  }
}
