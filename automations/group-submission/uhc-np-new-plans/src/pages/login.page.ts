import type { CarrierLoginFlow } from '@auto/group-submission-shared';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';

/**
 * UHC SAMx portal - sign-in and MFA.
 *
 * The ORDER of a login lives in the domain's shared session helper; this file
 * is only what the UHC screens look like. The watermark that makes MFA
 * retry-safe is set between enterCredentials and submitCredentials by the
 * caller, which is why those are two methods rather than one.
 *
 * ⚠ EVERY LOCATOR BELOW IS AN UNVERIFIED HYPOTHESIS, derived from a runbook
 * written before this code. Re-map against the live portal with Playwright MCP,
 * and record what differed in docs/poc/uhc-np-new-plans/drift-log.md.
 */
export class UhcLoginPage implements CarrierLoginFlow {
  readonly #config: AutomationConfig;

  constructor(config: AutomationConfig) {
    this.#config = config;
  }

  /**
   * Loads the employer shell and looks for a landmark only a signed-in user
   * sees.
   *
   * A page-level check, not a cookie check: a UHC session can expire
   * server-side while the cookie is still present, in which case this URL
   * serves the login form instead and the landmark is absent.
   *
   * TODO(remap): prefer the Samx One dashboard deep link once the real URL is
   * known.
   */
  async probeSignedIn(page: Page): Promise<boolean> {
    await page.goto(this.#config.portalUrl, { waitUntil: 'domcontentloaded' });
    return page.getByRole('link', { name: /Small Group Quoting & Renewals/i }).isVisible();
  }

  async enterCredentials(page: Page, username: string, password: string): Promise<void> {
    // TODO(remap): confirm the field labels.
    await page.getByLabel(/user ?id|username|email/i).fill(username);
    await page.getByLabel(/password/i).fill(password);
  }

  async submitCredentials(page: Page): Promise<void> {
    await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  }

  /**
   * TODO(remap): unknown whether UHC needs an explicit request.
   *
   * A no-op is the right default: UHC delivers by SMS through Google Voice, and
   * a text is usually sent automatically on password submit. If SAMx turns out
   * to show a "send code" control, it belongs here - and nowhere else, because
   * the watermark is set immediately before this call.
   */
  async requestMfaCode(_page: Page): Promise<void> {
    // Intentionally empty.
  }

  async enterMfaCode(page: Page, code: string): Promise<void> {
    // TODO(remap): if UHC asks how to deliver the code, that choice belongs
    // here and must pick email - that is the mailbox the MFA provider reads.
    await page.getByLabel(/(verification|security|one[- ]time|access) code/i).fill(code);
    await page.getByRole('button', { name: /verify|submit|continue/i }).click();
  }

  async waitForSignedIn(page: Page): Promise<void> {
    await page
      .getByRole('link', { name: /Small Group Quoting & Renewals/i })
      .waitFor({ state: 'visible' });
  }

  /**
   * Returns the text rather than throwing, so the shared session helper can
   * decide Business vs System in one place. Account lockout and a wrong
   * password land in the same DOM node and must not land in the same class.
   */
  async readError(page: Page): Promise<string | undefined> {
    // TODO(remap): confirm the error region.
    const alert = page.getByRole('alert');
    if (!(await alert.first().isVisible().catch(() => false))) return undefined;
    return (await alert.first().textContent())?.trim();
  }
}
