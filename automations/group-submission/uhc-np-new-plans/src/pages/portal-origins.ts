/**
 * The hosts this automation is allowed to touch, in one place.
 *
 * ── THE HOST ────────────────────────────────────────────────────────────────
 * `www.uhceservices.com` - UHC eServices, confirmed reachable and serving a
 * page titled "Pre-login Page" (HTTP 200). It replaced `www.uhc.com`, which was
 * a scaffold placeholder pointing at a consumer marketing page; see the drift
 * log for the evidence.
 *
 * This is the ONLY copy of the host in the codebase. Anthem needed three
 * constants because its sign-in crosses an Okta hop into a separate Salesforce
 * platform host; whether eServices does anything similar is still being mapped,
 * which is why RECON_HOSTS is a list rather than a single value.
 *
 * TODO(remap): add any identity or application host the sign-in crosses, and add
 * each one to `playwright-mcp.config.json`'s `network.allowedOrigins` too.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** UHC eServices. Where sign-in starts. */
export const PORTAL_HOST = 'www.uhceservices.com';

/** The pre-login landing page. The sign-in form is NOT on it. */
export const PRELOGIN_PATH = '/en/prelogin';

/**
 * One Healthcare ID - UHC's identity provider, and a SEPARATE origin.
 *
 * Verified 2026-09-10: the `Log In with OneHealthcare ID` link on the pre-login
 * page navigates to `https://identity.onehealthcareid.com/oneapp/index.html#/login`.
 * So UHC's sign-in crosses hosts the same way Anthem's crosses into Okta, which
 * had been an open question.
 *
 * Two consequences worth stating, because both have bitten Anthem:
 *  - anything that decides "are we on the portal?" must PARSE the URL, never
 *    substring-match it: an identity provider carries the portal host inside its
 *    own `redirect_uri` query parameter
 *  - this host needs to be in `playwright-mcp.config.json` as well as in
 *    RECON_HOSTS, or the MCP browser refuses the login page mid-flow
 */
export const IDENTITY_HOST = 'identity.onehealthcareid.com';

/**
 * The only hosts the reconnaissance harness may navigate to.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `playwright-mcp.config.json`'s `network.allowedOrigins` fences the MCP
 * browser. The recon browser is NOT that browser: `uhc-serve.ts` calls
 * `chromium.launch()` itself and restores `data/sessions/uhc.json`, so it holds
 * a live production session under a real licensed producer's licence - and a
 * harness that accepts `u <url>` for any url at all is an egress path with
 * credentials already attached.
 *
 * For a human at a keyboard that is unremarkable. It stops being unremarkable
 * the moment anything unattended can issue harness commands. The fence belongs
 * on the harness, not on the operator's good intentions.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const RECON_HOSTS = [PORTAL_HOST, IDENTITY_HOST] as const;

/**
 * May the reconnaissance harness navigate here?
 *
 * Parsed, not pattern-matched. A substring test says yes to
 * `https://evil.example/?x=www.uhc.com`, which is precisely the navigation this
 * is meant to refuse - and identity providers routinely carry the portal host
 * inside a `redirect_uri` query parameter, so the wrong page really does contain
 * the right string.
 *
 * The host must match EXACTLY. `endsWith` would accept
 * `evil-www.uhc.com.example`.
 */
export function isReconOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!(parsed.protocol === 'https:' || parsed.protocol === 'http:')) return false;
    return (RECON_HOSTS as readonly string[]).includes(parsed.host);
  } catch {
    return false;
  }
}

/**
 * The one landmark that means "signed in", shared rather than copied.
 *
 * Three places ask the question: `probeSignedIn` (is the STORED session still
 * alive?), `waitForSignedIn` (did the login just succeed?) and
 * `CaseStartPage.openNewBusinessDashboard` (are we on the shell?). Anthem's
 * `portal-origins.ts` documents why these must share a literal: two copies let
 * arrival and departure disagree the moment the carrier renames it, and the
 * failure then looks like a broken locator in whichever half was not updated.
 *
 * TODO(remap): taken from the runbook's navigation path, never seen rendered.
 */
export const SIGNED_IN_LANDMARK = /Small Group Quoting & Renewals/i;
