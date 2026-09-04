import type { CarrierLoginFlow } from '@auto/group-submission-shared';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';

/**
 * Anthem CA Producer Toolbox - sign-in and MFA.
 *
 * ── MAPPED AGAINST THE LIVE PORTAL 2026-09-02 ────────────────────────────────
 * Steps 1 and 2 below are verified. Two things about this login are not
 * obvious and cost time to discover:
 *
 *  1. It is PROGRESSIVE, and it federates. Username goes to
 *     brokerportal.anthem.com, then the browser is redirected to OKTA at
 *     login.broker.anthem.com for the password. So the password field is
 *     Okta's, which is why it is addressed by Okta's own stable field name.
 *
 *  2. The first button's accessible name is "Login" - taken from its
 *     aria-label - while its visible text reads "Continue". Matching the
 *     visible text does not find it.
 *
 * The MFA screen is NOT mapped: the stored credential is currently rejected,
 * so the flow has never reached it. See docs/poc/anthem-ca-new-plans/drift-log.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */
/**
 * The dashboard renders slowly after the OAuth hand-back, and the default
 * action timeout (15s) is not enough. Failing here is expensive: the login has
 * already succeeded and consumed a real MFA code, so a premature timeout
 * throws away a code and forces another one.
 */
const LANDMARK_TIMEOUT_MS = 45_000;

/**
 * How long to wait before deciding whether Okta wants a code.
 *
 * Short on purpose. This is a fork in the road, not a wait for something slow -
 * both branches resolve in a couple of seconds, and a generous budget here is
 * paid in full on every login that does NOT get challenged.
 */
const MFA_DECISION_TIMEOUT_MS = 20_000;

/**
 * Is this URL actually ON the portal?
 *
 * Parsed, not pattern-matched, and that distinction cost a whole debugging
 * pass. Okta's authorize URL carries
 * `redirect_uri=https://brokerportal.anthem.com/apps/ptb/_codexch` **in its
 * query string**, so the obvious `/brokerportal\.anthem\.com\/apps\/ptb/`
 * regex MATCHES while the browser is still sitting on Okta.
 *
 * The damage was not cosmetic: `isMfaRequired` used that regex, concluded the
 * portal had already handed back, reported "no challenge needed" and skipped
 * requesting a code at all - leaving the run stuck on the Okta screen and
 * blaming a slow dashboard for it.
 *
 * Comparing the parsed host and pathname cannot be fooled by a query parameter.
 */
export function isPortalUrl(url: string, pathPrefix = '/apps/ptb'): boolean {
  try {
    const parsed = new URL(url);
    return parsed.host === 'brokerportal.anthem.com' && parsed.pathname.startsWith(pathPrefix);
  } catch {
    return false;
  }
}

/**
 * A signed-in-only landmark.
 *
 * "Book of Business" appears TWICE on the dashboard - once in the top nav and
 * once as a section heading - so a role-specific locator is both ambiguous and
 * dependent on which of the two renders first. `.first()` on a text match takes
 * whichever appears and is stable across that layout choice.
 *
 * It is a sound landmark because the string appears nowhere on the login or
 * Okta screens, so it cannot be satisfied by a signed-out page.
 */
function signedInLandmark(page: Page): ReturnType<Page['getByText']> {
  return page.getByText('Book of Business').first();
}

export class AnthemLoginPage implements CarrierLoginFlow {
  readonly #config: AutomationConfig;

  constructor(config: AutomationConfig) {
    this.#config = config;
  }

  /**
   * Loads a signed-in-only page and looks for a landmark.
   *
   * A page-level check, not a cookie check: when the session has expired
   * server-side the portal bounces to the Okta login instead, so the landmark
   * is absent even though the cookie is still present.
   *
   * TODO(remap): the landmark is still a guess - the flow has never signed in
   * successfully, so nothing here has been seen. Confirm against the dashboard
   * once the credential works.
   */
  async probeSignedIn(page: Page): Promise<boolean> {
    await page.goto(this.#config.signedInProbeUrl, { waitUntil: 'domcontentloaded' });

    /**
     * Not being on the portal is conclusive proof we are NOT signed in - a
     * stale session gets bounced to Okta. Checked by parsed host rather than by
     * matching "login.broker.anthem.com" as a substring, for the same reason
     * `isPortalUrl` exists: OAuth URLs quote each other in query parameters, so
     * substring tests on either host can be fooled in both directions.
     */
    if (!isPortalUrl(page.url())) return false;

    if (await signedInLandmark(page).isVisible().catch(() => false)) return true;

    // The dashboard is heavy; either proof is enough. See waitForSignedIn.
    const landmark = signedInLandmark(page)
      .waitFor({ state: 'visible', timeout: LANDMARK_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    const dashboard = page
      .waitForURL((url) => isPortalUrl(url.toString(), '/apps/ptb/dashboard'), {
        timeout: LANDMARK_TIMEOUT_MS,
      })
      .then(() => true)
      .catch(() => false);

    if (await Promise.race([landmark, dashboard])) return true;
    return (await landmark) || (await dashboard);
  }

  /**
   * Re-authenticates a SAML hand-off that asked for the password again.
   *
   * ── WHY THIS IS NEEDED ──────────────────────────────────────────────────────
   * The portal session and the Salesforce **community** session expire
   * independently. When the community one has lapsed, the SAML hop that
   * `Create Quote` performs lands back on
   * `login.broker.anthem.com/app/.../sso/saml` showing a single Password field -
   * while `signedInVia: "reused"` says the portal session is perfectly valid.
   *
   * It is intermittent, and that is what made it hard to read: the same session
   * file passed the hop on one machine and failed on another, then failed on the
   * first machine an hour later. Runtime and route were both red herrings; only
   * elapsed time matters. Observed 2026-09-04 on host and in a container.
   *
   * Okta reuses `credentials.passcode` and the `Next` submit here, exactly as on
   * the normal password screen, so no new locators are needed. MFA is not
   * re-requested for this hop - the device is already trusted; only the password
   * is asked for.
   *
   * Returns false when there was nothing to resolve, so a caller can treat the
   * happy path as the common one.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async resolveSamlChallenge(page: Page, password: string, timeoutMs = 45_000): Promise<boolean> {
    const passwordField = page.locator('input[name="credentials.passcode"]').filter({ visible: true });

    const challenged = await passwordField
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!challenged) return false;

    await passwordField.first().fill(password);
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    /**
     * Wait to leave Okta entirely rather than for a specific destination: the
     * hop can land on the community home or deep in the wizard depending on
     * where it was interrupted, and both are success.
     */
    await page.waitForURL((url) => !url.host.endsWith('login.broker.anthem.com'), {
      timeout: timeoutMs,
    });

    return true;
  }

  /**
   * Username, advance, then password - WITHOUT submitting.
   *
   * The two halves are split across enterCredentials and submitCredentials so
   * the MFA watermark lands between them, immediately before the submit that
   * actually triggers the code mail. See createCarrierPortalSession.
   */
  async enterCredentials(page: Page, username: string, password: string): Promise<void> {
    await page.getByLabel('Username', { exact: true }).fill(username);

    // Accessible name comes from aria-label="Login"; the visible text is
    // "Continue". Verified 2026-09-02.
    await page.getByRole('button', { name: 'Login', exact: true }).click();

    /**
     * Now on Okta. `credentials.passcode` is Okta's own field name and is far
     * more stable than the generated id (input60) or the placeholder text.
     */
    const passwordField = page.locator('input[name="credentials.passcode"]');
    await passwordField.waitFor({ state: 'visible' });
    await passwordField.fill(password);
  }

  async submitCredentials(page: Page): Promise<void> {
    // An input[type=submit] takes its accessible name from value="Next".
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  }

  /**
   * Does Okta actually want a one-time code this time?
   *
   * VERIFIED 2026-09-03: it does not always. With a remembered device Okta
   * hands straight back through `/apps/ptb/_codexch` to the dashboard and no
   * factor screen is ever shown. The run that discovered this died waiting 15s
   * for "Email me a code" on a page that had already navigated to
   * `brokerportal.anthem.com/apps/ptb/?utm_source=landing&login_hint=...` -
   * a successful login reported as a failure.
   *
   * So this races the two outcomes rather than assuming either. Landing back on
   * the portal host is conclusive proof no code is coming; the factor button
   * appearing is proof one is.
   */
  async isMfaRequired(page: Page): Promise<boolean> {
    const factorButton = page.getByRole('button', { name: 'Email me a code', exact: true });

    const outcome = await Promise.race([
      factorButton.waitFor({ state: 'visible', timeout: MFA_DECISION_TIMEOUT_MS }).then(() => 'mfa' as const),
      page
        .waitForURL((url) => isPortalUrl(url.toString()), { timeout: MFA_DECISION_TIMEOUT_MS })
        .then(() => 'signed-in' as const),
    ]).catch(() => 'unknown' as const);

    /**
     * `unknown` means neither happened inside the budget. Answering "yes, MFA"
     * is the safe reading: requestMfaCode then fails with a locator error
     * naming the missing button, which is a far better diagnostic than silently
     * proceeding to a landmark that will not appear either.
     */
    return outcome !== 'signed-in';
  }

  /**
   * Asks Okta to send the code. VERIFIED 2026-09-02.
   *
   * Okta does not send anything on password submit: it shows "For your
   * security, you need a one-time code to verify your identity" with a single
   * `input[type=submit][value="Email me a code"]`. Email is the only factor
   * offered, which is convenient - it is the mailbox GmailUiMfaProvider reads,
   * and Anthem's mail arrives from noreply@broker.anthem.com.
   *
   * The watermark is set immediately before this call, so this method must do
   * nothing except trigger the send.
   */
  async requestMfaCode(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Email me a code', exact: true }).click();
  }

  /**
   * Asks Anthem to send another code. VERIFIED 2026-09-02.
   *
   * The Email Verification screen shows a countdown ("This code expires in
   * m:ss") next to "Didn't get it? Resend Code". That countdown is why this
   * exists: the code reaches us through a forward whose latency was measured
   * between ~132s and over 600s, and once the countdown runs out the code is
   * dead on arrival. Waiting longer cannot help; a fresh code can.
   */
  async resendMfaCode(page: Page): Promise<void> {
    /**
     * Matched by text, not by role.
     *
     * `getByRole('link', ...)` times out here even though the control is
     * plainly visible: it is an anchor with no `href`, and an anchor without
     * one has NO link role at all. Screenshot evidence from a failed run
     * settled it. Exact text keeps this off the surrounding "Didn't get it?"
     * paragraph, whose full text does not match.
     */
    await page.getByText('Resend Code', { exact: true }).first().click();
  }

  /**
   * Enters the code. VERIFIED 2026-09-02 - a real code was accepted here.
   *
   * Okta reuses `credentials.passcode` for the one-time code on its own
   * screen, the same name as the password field, and renders it as a single
   * input labelled "One-Time Code" rather than six separate boxes.
   */
  async enterMfaCode(page: Page, code: string): Promise<void> {
    const codeField = page.locator('input[name="credentials.passcode"]');
    await codeField.waitFor({ state: 'visible' });
    await codeField.fill(code);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
  }

  /**
   * Waits for the producer dashboard. VERIFIED 2026-09-02.
   *
   * Okta hands back through /apps/ptb/_codexch?code=... before landing on
   * /apps/ptb/, so the URL has to settle first. The dashboard itself is heavy -
   * news carousel, commissions chart, quick links - and does not render inside
   * the default 15s action timeout, which is what made this fail the first time
   * even though the login had actually succeeded.
   */
  async waitForSignedIn(page: Page): Promise<void> {
    await page.waitForURL((url) => isPortalUrl(url.toString()), { timeout: 60_000 });

    if (await signedInLandmark(page).isVisible().catch(() => false)) return;

    /**
     * Two proofs, either of which is enough - and the URL is the better one.
     *
     * The landmark text is a heavy render on a heavy dashboard: news carousel,
     * commissions chart, quick links. It has now twice failed to paint inside
     * its budget AFTER a completely successful login, throwing the sign-in away
     * over a slow page. Meanwhile the URL settling on `/apps/ptb/dashboard/...`
     * is conclusive on its own: a signed-out request to that path is bounced to
     * Okta at `login.broker.anthem.com`, so being here at all means we are in.
     *
     * So: wait for the landmark, but accept the dashboard URL if it never
     * comes. Raising the timeout alone would only make the same failure slower.
     */
    const landmark = signedInLandmark(page)
      .waitFor({ state: 'visible', timeout: LANDMARK_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    const dashboardUrl = page
      .waitForURL(
        (url) =>
          isPortalUrl(url.toString(), '/apps/ptb/dashboard') ||
          isPortalUrl(url.toString(), '/apps/ptb/quotes'),
        { timeout: LANDMARK_TIMEOUT_MS },
      )
      .then(() => true)
      .catch(() => false);

    if (await Promise.race([landmark, dashboardUrl])) return;
    if ((await landmark) || (await dashboardUrl)) return;

    throw new Error(
      `Signed in but neither the dashboard landmark nor a dashboard URL appeared within ` +
        `${LANDMARK_TIMEOUT_MS}ms. Last URL: ${page.url()}`,
    );
  }

  /**
   * Okta renders its failures in a role=alert region - verified: a rejected
   * password produces "Unable to sign in. Please check your credentials."
   *
   * Returned rather than thrown so the shared session helper classifies it in
   * one place. That wording is System (the environment is wrong); a lockout
   * would be Business.
   */
  async readError(page: Page): Promise<string | undefined> {
    const alert = page.getByRole('alert');
    if (!(await alert.first().isVisible().catch(() => false))) return undefined;
    return (await alert.first().textContent())?.trim();
  }
}
