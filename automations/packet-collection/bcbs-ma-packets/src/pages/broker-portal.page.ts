import { SystemException } from '@rpa/core';
import type { Locator, Page } from 'playwright';

/**
 * Login to the BCBS MA broker portal (a Salesforce Experience Cloud site),
 * then hand off into the BlueQuote renewals app.
 *
 * Two things only a live run against the real portal revealed, not the
 * static XAML reading this was first ported from:
 *
 * 1. The Sign-in click triggers a SAML round trip back to this same site
 *    (via access.bluecrossma.com, a ForgeRock/OpenAM identity provider).
 *    It resolves in 6-10s - a 5s check reads as a failed login when it is
 *    really just still redirecting.
 * 2. The BlueQuote tile lives inside an <iframe> (Vlocity ConsoleCards,
 *    layout "bp-home-myonlinetools"), and clicking it opens a *second tab*
 *    carrying a fresh Salesforce SSO handoff (frontdoor.jsp with a live
 *    session token in the URL). Navigating straight to the BlueQuote URL
 *    has no token and never resolves - the click is what mints it.
 */
export class BrokerPortalPage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  /**
   * This portal keeps a previous screen's DOM mounted-but-hidden rather than
   * removing it, so several "single" landmarks actually resolve to more than
   * one match. `.isVisible()` on a multi-match locator throws (strict mode),
   * which a bare `.catch(() => false)` silently turns into "not found" -
   * confirmed live: this exact bug read a successful login as a failure.
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

  async open(url: string): Promise<void> {
    await this.#page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async signIn(username: string, password: string): Promise<void> {
    await this.#page.getByLabel('Username').fill(username);
    await this.#page.getByLabel('Password').fill(password);
    await this.#page.getByRole('button', { name: 'Sign-in to Broker Central' }).click();
    await this.#page.waitForLoadState('networkidle').catch(() => {});

    // AUTO-HEALING SEAM: this landmark is the most brittle assertion in the
    // whole flow - a fallback locator would slot in here, after this
    // deterministic one fails, never instead of it.
    //
    // "Home" in the nav bar is a bare <span> with no role/href - not a real
    // link, confirmed live - so it can never match getByRole('link'). Logout
    // is a real role=button that only exists once signed in.
    const loggedIn = await this.#firstVisible(this.#page.getByRole('button', { name: 'Logout' }), 15000);
    if (loggedIn === null) {
      // Login failing is an environment problem (wrong credential, portal
      // down, layout changed), not a business rule - so it must be retryable.
      throw new SystemException('Sign-in did not reach the broker portal home');
    }
  }

  /** Returns the second tab BlueQuote opens into - the caller stores it in ctx.state. */
  async openBlueQuote(): Promise<Page> {
    let tile = null;
    for (const frame of this.#page.frames()) {
      const count = await frame
        .getByText('BlueQuote', { exact: true })
        .count()
        .catch(() => 0);
      if (count > 0) {
        tile = frame.getByText('BlueQuote', { exact: true }).first();
        break;
      }
    }
    if (tile === null) {
      throw new SystemException('BlueQuote tile not found in any frame on the broker portal home');
    }

    const popupPromise = this.#page.context().waitForEvent('page');
    await tile.click();
    const quotePage = await popupPromise;
    await quotePage.waitForLoadState('networkidle').catch(() => {});
    return quotePage;
  }
}
