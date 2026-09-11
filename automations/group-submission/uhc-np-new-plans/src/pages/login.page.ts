import type { CarrierLoginFlow } from '@auto/group-submission-shared';
import { visible } from '@rpa/core';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import { IDENTITY_HOST, SIGNED_IN_LANDMARK } from './portal-origins.ts';

/**
 * UHC eServices sign-in, via One Healthcare ID.
 *
 * The ORDER of a login lives in the domain's shared session helper; this file is
 * only what the UHC screens look like. The watermark that makes MFA retry-safe
 * is set between enterCredentials and submitCredentials by the caller, which is
 * why those are two methods rather than one.
 *
 * ── MAPPED AGAINST THE LIVE PORTAL, 2026-09-10 ───────────────────────────────
 * Everything below down to `submitCredentials` was read off the real screens
 * with the recon harness. What is verified, and what is not, is marked per
 * method - the distinction matters more here than usual, because the mapping run
 * was stopped by a credential rejection before it reached an authenticated
 * screen. See docs/poc/uhc-np-new-plans/drift-log.md.
 *
 * The shape that was NOT expected: sign-in crosses to a separate origin
 * (`identity.onehealthcareid.com`) and the password is on a SECOND screen. The
 * previous version filled a username and a password together on one form, which
 * could never have worked.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** How long a login screen is given to appear. Generous: the cost of "no" is a code. */
const LANDMARK_TIMEOUT_MS = 20_000;

/**
 * VERIFIED: the pre-login page's route to sign-in.
 *
 * A LINK, not a button - which is why the first screen reader written for this
 * automation could not see it at all and reported a page with no way in.
 */
export const PRELOGIN_LOGIN_LINK = /Log In with OneHealthcare ID/i;

/** VERIFIED: step 1 of 2. The password is not on this screen. */
export const IDENTITY_ID_FIELD = /One Healthcare ID or Email Address/i;

/** VERIFIED: both steps advance with a button named exactly `Continue`. */
export const IDENTITY_CONTINUE = /^Continue$/;

/** VERIFIED: the password screen's own URL fragment. */
export const PASSWORD_SCREEN_PATH = '#/signin/password';

export class UhcLoginPage implements CarrierLoginFlow {
  readonly #config: AutomationConfig;

  constructor(config: AutomationConfig) {
    this.#config = config;
  }

  /**
   * Loads eServices and looks for a landmark only a signed-in user sees.
   *
   * A page-level check, not a cookie check: a UHC session can expire
   * server-side while the cookie is still present, in which case this URL
   * serves the pre-login page instead and the landmark is absent.
   *
   * WAITS, rather than using `isVisible()`. `createCarrierPortalSession` uses
   * this as a step() POSTCONDITION, so a false negative does not merely fail -
   * it takes the full login branch and spends an MFA code on a session that was
   * alive. UHC's codes are forwarded text messages, the most rate-limited
   * resource here.
   *
   * TODO(remap): SIGNED_IN_LANDMARK is still a guess from the runbook - the
   * mapping run never reached an authenticated screen, so the eServices landing
   * page has not been seen. Until it is, this probe fails closed: it reports
   * "not signed in" and the automation logs in again. That is the safe
   * direction. The alternative - a probe that wrongly says yes - runs the whole
   * automation against a signed-out browser, and every later step then fails for
   * a reason that has nothing to do with its own locator.
   */
  async probeSignedIn(page: Page): Promise<boolean> {
    await page.goto(this.#config.portalUrl, { waitUntil: 'domcontentloaded' });
    return visible(page.getByRole('link', { name: SIGNED_IN_LANDMARK }), LANDMARK_TIMEOUT_MS);
  }

  /**
   * Walks pre-login -> One Healthcare ID -> the password screen, and stops.
   *
   * Deliberately does NOT submit: the caller sets the MFA watermark between this
   * and `submitCredentials`, and submitting here would send the code before
   * anything was watching for it.
   *
   * All three screens VERIFIED 2026-09-10, except that the password submit is
   * what triggers the code - which is inferred, because the credential rejection
   * meant no code was ever sent.
   */
  async enterCredentials(page: Page, username: string, password: string): Promise<void> {
    /**
     * The pre-login page carries no form at all. Guarded rather than
     * unconditional so a session that lands straight on the identity host - or
     * on a screen that already has the ID filled - does not fail here.
     */
    const loginLink = page.getByRole('link', { name: PRELOGIN_LOGIN_LINK });
    if (await visible(loginLink, LANDMARK_TIMEOUT_MS)) {
      await loginLink.click();
    }

    const idField = page.getByLabel(IDENTITY_ID_FIELD).first();
    await idField.waitFor({ state: 'visible', timeout: LANDMARK_TIMEOUT_MS });
    await idField.fill(username);
    await page.getByRole('button', { name: IDENTITY_CONTINUE }).first().click();

    /**
     * Step 2. Waited for by its own URL fragment as well as the field, because
     * the ID field is still present (read-only) on the password screen - so
     * "a field is visible" alone does not prove the step advanced.
     */
    await page.waitForURL((url) => url.hash.includes(PASSWORD_SCREEN_PATH.slice(1)), {
      timeout: LANDMARK_TIMEOUT_MS,
    });
    const passwordField = page.getByLabel(/password/i).first();
    await passwordField.waitFor({ state: 'visible', timeout: LANDMARK_TIMEOUT_MS });
    await passwordField.fill(password);
  }

  /** The action that sends the code. Nothing else may press this. */
  async submitCredentials(page: Page): Promise<void> {
    await page.getByRole('button', { name: IDENTITY_CONTINUE }).first().click();
  }

  /**
   * TODO(remap): unknown whether UHC needs an explicit request.
   *
   * A no-op is the right default: UHC delivers by SMS through Google Voice, and
   * a text is usually sent automatically on password submit. If eServices turns
   * out to show a "send code" control, it belongs here - and nowhere else,
   * because the watermark is set immediately before this call.
   */
  async requestMfaCode(_page: Page): Promise<void> {
    // Intentionally empty.
  }

  /**
   * TODO(remap): NOT VERIFIED. The mapping run was stopped by a credential
   * rejection before any MFA screen was reached, so neither the field label nor
   * the submit control has been seen. Worse, `rpa mfa check` found 400 messages
   * in the configured label and ZERO carrying a six-digit code, so the code's
   * FORMAT is unknown too - see session.ts and the drift log.
   */
  async enterMfaCode(page: Page, code: string): Promise<void> {
    await page.getByLabel(/(verification|security|one[- ]time|access|passcode) code/i).fill(code);
    await page.getByRole('button', { name: /verify|submit|continue/i }).click();
  }

  async waitForSignedIn(page: Page): Promise<void> {
    /**
     * Throws on failure, unlike the probe: here a missing landmark means the
     * login did not work, and the shared session helper turns that into a
     * classified failure.
     */
    await page
      .getByRole('link', { name: SIGNED_IN_LANDMARK })
      .waitFor({ state: 'visible', timeout: LANDMARK_TIMEOUT_MS });
  }

  /**
   * Returns the text rather than throwing, so the shared session helper can
   * decide Business vs System in one place. Account lockout and a wrong
   * password land in the same DOM node and must not land in the same class.
   *
   * VERIFIED: One Healthcare ID renders its rejection in a node this selector
   * set reaches - the mapping run read back, verbatim,
   * "The One Healthcare ID or password that you entered is incorrect."
   */
  async readError(page: Page): Promise<string | undefined> {
    const alert = page.locator('[role="alert"], [aria-invalid="true"], [class*="error"]').first();
    if (!(await alert.isVisible().catch(() => false))) return undefined;
    const text = (await alert.textContent())?.replace(/\s+/g, ' ').trim();
    return text === undefined || text.length === 0 ? undefined : text;
  }
}

/**
 * Is this a One Healthcare ID screen?
 *
 * Parsed, never substring-matched. An identity provider carries the portal host
 * inside its own `redirect_uri` query parameter, so a substring test says yes to
 * the wrong page - and `https://evil.example/?x=identity.onehealthcareid.com`
 * would pass one too.
 */
export function isIdentityUrl(url: string): boolean {
  try {
    return new URL(url).host === IDENTITY_HOST;
  } catch {
    return false;
  }
}

/**
 * Does this message mean the credentials were refused, rather than the portal
 * being broken?
 *
 * A wrong password and a lockout arrive in the same DOM node and must not arrive
 * in the same class: a refused password is worth one more attempt with corrected
 * secrets, and a lockout must never be retried because retrying is what deepens
 * it. Pure and exported so it can be tested against the real captured strings,
 * which is the only practical coverage - these appear on a screen that costs a
 * real login attempt against a shared production account to reach.
 */
export function isCredentialRejection(message: string): boolean {
  return /that you entered is incorrect|incorrect (?:id|password)|invalid (?:credentials|password)/i.test(
    message,
  );
}

/** Wording that means the account is locked or rate-limited. NEVER retry these. */
export function isLockout(message: string): boolean {
  return /locked|too many (?:failed )?(?:attempts|tries)|temporarily (?:disabled|unavailable)|try again later/i.test(
    message,
  );
}
