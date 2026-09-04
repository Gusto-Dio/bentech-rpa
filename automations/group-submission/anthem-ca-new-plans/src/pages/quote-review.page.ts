import { step, textVisible, visible, type StepContext } from '@rpa/core';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Payload } from '../payload.ts';
import { DOCUMENT_TIMEOUT_MS, button } from './lightning.ts';
import { readApplicationMatchingError } from './portal-errors.ts';

/**
 * `Quote Review & Confirmation` - stage 6.
 *
 * Shows the quote number, group, effective date, employee count and the plan
 * list, and offers the Member-Rated quote as PDF and Excel. Takes 30-45s to
 * render; a shorter gate gives up on a screen that is merely slow.
 */
export class QuoteReviewPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  /**
   * Reads the quote number the portal assigned.
   *
   * Worth capturing for its own sake: it is the reference an operator uses to
   * find this submission again, and it is the most transaction-specific anchor
   * available on every screen after this one.
   */
  async readQuoteNumber(): Promise<string | undefined> {
    const body = await this.#page.locator('body').innerText().catch(() => '');
    return /Quote Number\s+(\d{6,})/.exec(body.replace(/\s+/g, ' '))?.[1];
  }

  async waitForQuote(payload: Payload): Promise<string | undefined> {
    await step(this.#steps, {
      name: 'wait for the quote documents',
      // MUST be set: step() caps EVERY gate at its own timeoutMs (60s by
      // default), so a generous locator budget below is silently truncated
      // without this - which is what cut the documents page off mid-render.
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      action: async () => undefined,
      alwaysRun: true,
      // Anchored on THIS group's name, so a stale review screen from a previous
      // transaction cannot satisfy it.
      postcondition: async () => textVisible(this.#page, payload.companyName, DOCUMENT_TIMEOUT_MS),
      /**
       * A reload, because that is what a human does to a page that has been
       * "Loading Documents" too long - and because the alternative is letting
       * the runner retry the whole transaction, which creates a SECOND real
       * quote for this group and abandons the one already built.
       */
      repair: async () => {
        await this.#page.reload({ waitUntil: 'domcontentloaded' });
      },
    });

    return this.readQuoteNumber();
  }

  /**
   * Saves the Member-Rated quote.
   *
   * The download cards carry no `href` - a JS handler opens a popup at
   * `/broker/apex/SG_ViewQuoteAttachment?quoteId=…&rtype=member&dtype=pdf`, and
   * no `download` event fires. So the popup is caught and its own response body
   * is taken.
   *
   * TODO(remap): confirm the popup's response is the PDF itself. Fetching that
   * URL out of band returns 401 from an API context and the Visualforce HTML
   * shell from an in-page fetch, so the bytes have to come from the popup's
   * navigation response.
   */
  async downloadMemberRatedPdf(downloadDir: string): Promise<string | undefined> {
    const result = await step<string | undefined>(this.#steps, {
      name: 'download the member-rated quote pdf',
      // MUST be set: step() caps EVERY gate at its own timeoutMs (60s by
      // default), so a generous locator budget below is silently truncated
      // without this - which is what cut the documents page off mid-render.
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () =>
        visible(this.#page.getByText('Download Quote (PDF)').first(), DOCUMENT_TIMEOUT_MS),
      action: async () => {
        /**
         * The whole action is best-effort. The quote already EXISTS by this
         * point - this is only the evidence copy, and losing it must not
         * abandon a real submission or, worse, make the runner retry and build
         * a second quote for the same group.
         */
        try {
          /**
           * Wait for the spinner to go. The card is "visible, enabled and
           * stable" while an `lightning-spinner` still covers it, so Playwright
           * retries the click for its whole budget and reports an interception
           * rather than "still loading" - the documents are simply not built
           * yet.
           */
          await this.#page
            .locator('lightning-spinner, .slds-spinner_container')
            .first()
            .waitFor({ state: 'hidden', timeout: DOCUMENT_TIMEOUT_MS })
            .catch(() => undefined);

          const pending = this.#page.waitForEvent('popup', { timeout: 60_000 });
          await this.#page
            .locator('.download-card')
            .filter({ hasText: 'Download Quote (PDF)' })
            .first()
            .click();

          const popup = await pending;
          const response = await popup.waitForResponse(
            (r) => r.url().includes('SG_ViewQuoteAttachment'),
            { timeout: 60_000 },
          );
          const body = await response.body();
          const to = path.join(downloadDir, 'anthem-member-rated-quote.pdf');
          await writeFile(to, body);
          await popup.close();
          return to;
        } catch (cause) {
          this.#steps.logger.warn(
            { err: cause },
            'Could not save the member-rated quote PDF; the quote itself is unaffected',
          );
          return undefined;
        }
      },
      alwaysRun: true,
      // Evidence capture must not fail the transaction: the quote exists on the
      // portal either way, and losing the PDF is an inconvenience, not a reason
      // to abandon a submission.
      postcondition: async () => true,
    });

    return result.value;
  }

  /** Leaves the quote and opens the employer application. */
  async startApplication(): Promise<void> {
    await step(this.#steps, {
      name: 'start the employer application',
      // MUST be set: step() caps EVERY gate at its own timeoutMs (60s by
      // default), so a generous locator budget below is silently truncated
      // without this - which is what cut the documents page off mid-render.
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () => visible(button(this.#page, 'Start Application'), DOCUMENT_TIMEOUT_MS),
      action: async () => button(this.#page, 'Start Application').first().click(),
      alwaysRun: true,
      /**
       * The URL, not the heading.
       *
       * `/enrollgroupca-co?c__ContextId=<quoteId>` is the application, full
       * stop. Waiting on the "Employer Enrollment Application for Small Groups"
       * text failed on a page that had already opened it - and the retry then
       * went back and built another quote from scratch.
       */
      postcondition: async () =>
        this.#page
          .waitForURL(/\/enrollgroupca/i, { timeout: DOCUMENT_TIMEOUT_MS })
          .then(() => true)
          .catch(() => false),
      /**
       * The one screen that can legitimately appear instead of the application.
       * Without this, a group that already has an application in progress fails
       * as a URL timeout - which reads like a broken locator and gets retried
       * three times for an answer that will never change.
       */
      businessCheck: async () => readApplicationMatchingError(this.#page),
    });
  }
}
