import { BusinessException, SystemException } from '@rpa/core';
import type { Page } from 'playwright';

/**
 * Sign-in for the shared carrier portal.
 *
 * This lives in the domain's _shared package rather than in one automation
 * because every group-submission automation authenticates against the same
 * portal. When the carrier changes its login page - and they do - this is the
 * single file that changes, instead of twelve copies of it.
 */
export class PortalLoginPage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async open(url: string): Promise<void> {
    await this.#page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async signIn(username: string, password: string): Promise<void> {
    // This portal ships inputs with no <label>, so getByPlaceholder is the most
    // resilient locator available - it is tied to visible text rather than to
    // DOM structure or styling. getByRole covers the submit button, whose
    // accessible name comes from its value attribute.
    await this.#page.getByPlaceholder('Username').fill(username);
    await this.#page.getByPlaceholder('Password').fill(password);
    await this.#page.getByRole('button', { name: 'Login' }).click();

    const error = this.#page.locator('[data-test="error"]');
    if (await error.isVisible().catch(() => false)) {
      const message = (await error.textContent())?.trim() ?? 'unknown sign-in error';

      /**
       * A locked-out account is a business decision by the carrier, not a
       * transient fault: retrying it three times and relaunching the browser
       * each time would waste minutes and still fail. Everything else about a
       * failed sign-in (wrong host, portal down, MFA prompt) is environmental
       * and must stay retryable.
       */
      if (message.toLowerCase().includes('locked out')) {
        throw new BusinessException(`Portal account is locked out: ${message}`);
      }
      throw new SystemException(`Portal sign-in failed: ${message}`);
    }

    // AUTO-HEALING SEAM: the post-login landmark is the most brittle assertion
    // in any portal automation, because it breaks on a redesign that changes
    // nothing functional. If this portal churns, an LLM-assisted locator
    // ("find the signed-in landmark") belongs here as a FALLBACK after the
    // deterministic check below fails - never as a replacement for it.
    await this.#waitForSignedIn();
  }

  async #waitForSignedIn(): Promise<void> {
    const catalogTitle = this.#page.getByText('Products', { exact: true });
    try {
      await catalogTitle.waitFor({ state: 'visible' });
    } catch (cause) {
      throw new SystemException('Sign-in did not reach the carrier catalog', { cause });
    }
  }
}
