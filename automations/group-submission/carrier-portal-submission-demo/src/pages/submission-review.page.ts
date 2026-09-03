import type { Page } from 'playwright';

/** The draft submission, listing the plans about to be sent to the carrier. */
export class SubmissionReviewPage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async lineCount(): Promise<number> {
    return this.#page.locator('[data-test="inventory-item"], .cart_item').count();
  }

  async beginSubmission(): Promise<void> {
    await this.#page.getByRole('button', { name: 'Checkout' }).click();
  }
}
