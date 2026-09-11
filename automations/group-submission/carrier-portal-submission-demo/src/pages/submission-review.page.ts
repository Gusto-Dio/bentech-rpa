import type { Page } from 'playwright';

/** The draft submission, listing the plans about to be sent to the carrier. */
export class SubmissionReviewPage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  /**
   * One line per removable row.
   *
   * Counted by the Remove control rather than by a row container, because the
   * demo portal reuses `data-test="inventory-item"` on the draft page for the
   * WHOLE catalogue - it answers 6 there no matter how many lines the draft
   * holds - and the `.cart_item` class it used to carry was withdrawn upstream.
   * Both of those returned a confident wrong number rather than failing, which
   * is the worst shape a gate can have.
   *
   * `count()` does not auto-wait, so the caller must already be on the draft
   * page. `openDraftSubmission()` guarantees that.
   */
  async lineCount(): Promise<number> {
    return this.#page.getByRole('button', { name: 'Remove' }).count();
  }

  async beginSubmission(): Promise<void> {
    await this.#page.getByRole('button', { name: 'Checkout' }).click();
  }
}
