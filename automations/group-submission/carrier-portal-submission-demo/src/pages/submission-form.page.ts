import type { Page } from 'playwright';

/** Step one: the contact the carrier will correspond with about this group. */
export class SubmissionFormPage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async fillContact(contact: {
    firstName: string;
    lastName: string;
    postalCode: string;
  }): Promise<void> {
    await this.#page.getByPlaceholder('First Name').fill(contact.firstName);
    await this.#page.getByPlaceholder('Last Name').fill(contact.lastName);
    await this.#page.getByPlaceholder('Zip/Postal Code').fill(contact.postalCode);
  }

  async continue(): Promise<void> {
    await this.#page.getByRole('button', { name: 'Continue' }).click();
  }

  /**
   * Returns the portal's own validation message, or undefined if it accepted
   * the form. The caller decides what that means - a rejected contact is a
   * business failure, and only the caller knows that.
   */
  async validationError(): Promise<string | undefined> {
    const error = this.#page.locator('[data-test="error"]');
    if (!(await error.isVisible().catch(() => false))) return undefined;
    return (await error.textContent())?.trim() ?? 'unknown validation error';
  }
}
