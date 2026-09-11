/**
 * The hosts this automation is allowed to touch, in one place.
 *
 * These were three literals in three files: `brokerportal.anthem.com` inside
 * `isPortalUrl`, `OKTA_HOST` in `login.page.ts`, and `PLATFORM_HOST` in
 * `tooling/scripts/check-portal-navigation.ts` - with the platform host
 * appearing nowhere else except a comment. `login.page.ts` already explains why
 * arrival and departure must not each own a copy of the Okta host, and
 * `login.page.test.ts` enforces it for `quote-start.page.ts`. This file applies
 * the same reasoning to all three, which is what the reconnaissance allow-list
 * below needs anyway.
 */

/** Producer Toolbox. Where sign-in starts and the dashboard lives. */
export const PORTAL_HOST = 'brokerportal.anthem.com';

/**
 * Okta, which fronts both the initial password screen and the SAML hand-off.
 *
 * `login.page.ts` re-exports this so `quote-start.page.ts` keeps importing it
 * from there: its copy detects that the hand-off ARRIVED on Okta, login's
 * detects that `resolveSamlChallenge` has LEFT it. Two halves of one protocol,
 * so two literals would let arrival and departure disagree if Anthem ever
 * moves the host.
 */
export const OKTA_HOST = 'login.broker.anthem.com';

/**
 * The Salesforce Experience Cloud / Vlocity quoting platform.
 *
 * `Create Quote` opens a NEW TAB here; Producer Toolbox is only the launcher
 * now. See the 2026-09-03 drift-log entries.
 */
export const PLATFORM_HOST = 'elevancehealthfulcrum.my.site.com';

/**
 * The only hosts the reconnaissance harness may navigate to.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `playwright-mcp.config.json`'s `network.allowedOrigins` fences the MCP
 * browser. The recon browser is NOT that browser: `anthem-serve.ts` calls
 * `chromium.launch()` itself and restores `data/sessions/anthem-ca.json`, so it
 * holds a live production broker session under a real licensed producer's
 * licence - and `anthem-do.ts "u <url>"` accepted any URL at all.
 *
 * For a human at a keyboard that was unremarkable. It stops being unremarkable
 * the moment anything unattended can issue harness commands, because it is then
 * an egress path with credentials already attached. The fence belongs on the
 * harness, not on the operator's good intentions.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const RECON_HOSTS = [PORTAL_HOST, OKTA_HOST, PLATFORM_HOST] as const;

/**
 * May the reconnaissance harness navigate here?
 *
 * Parsed, not pattern-matched, for the reason `isPortalUrl` documents at
 * length: Okta's authorize URL carries
 * `redirect_uri=https://brokerportal.anthem.com/apps/ptb/_codexch` in its
 * QUERY STRING, so a substring test says yes to the wrong page. Here the
 * mistake would be worse than a misread state - a substring test also says yes
 * to `https://evil.example/?x=brokerportal.anthem.com`, which is precisely the
 * navigation this is meant to refuse.
 *
 * The host must match EXACTLY. `endsWith` would accept
 * `evil-brokerportal.anthem.com.example`.
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
