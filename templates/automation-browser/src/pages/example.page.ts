import { SystemException } from '@rpa/core';
import type { Page } from 'playwright';

/**
 * Page object: the ONLY place selectors are allowed to live.
 *
 * That rule is enforced by convention and reviewed by `rpa validate`'s
 * boundaries, and it exists so that when a vendor redesigns their portal the
 * blast radius is this directory rather than every transaction step.
 *
 * Locator preference, most resilient first:
 *   1. getByRole    - survives styling and DOM restructuring
 *   2. getByLabel / getByPlaceholder - tied to visible, translated text
 *   3. getByTestId  - only if the app ships stable test attributes
 *   4. CSS          - last resort, and only inside a page object
 * XPath is not used anywhere in this repo.
 */
export class ExamplePage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async open(url: string): Promise<void> {
    await this.#page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async signIn(username: string, password: string): Promise<void> {
    await this.#page.getByLabel('Username').fill(username);
    await this.#page.getByLabel('Password').fill(password);
    await this.#page.getByRole('button', { name: 'Sign in' }).click();

    // AUTO-HEALING SEAM: a post-login landmark is the single most brittle
    // assertion in any portal automation. If this app's shell changes often,
    // this is where an LLM-assisted locator (Stagehand or similar) would be
    // asked "find the signed-in landmark" as a fallback - after the
    // deterministic locator below has failed, never instead of it.
    const landmark = this.#page.getByRole('heading', { name: 'Dashboard' });
    if (!(await landmark.isVisible().catch(() => false))) {
      // Login failing is an environment problem (wrong credential, portal
      // down, MFA prompt), not a business rule - so it must be retryable.
      throw new SystemException('Sign-in did not reach the dashboard');
    }
  }

  async submitRecord(recordId: string): Promise<string> {
    await this.#page.getByLabel('Record id').fill(recordId);
    await this.#page.getByRole('button', { name: 'Submit' }).click();

    const confirmation = this.#page.getByRole('status');
    await confirmation.waitFor({ state: 'visible' });
    return (await confirmation.textContent())?.trim() ?? '';
  }
}
