import { probeStoredSession } from '@auto/group-submission-shared';
import {
  BOT_REFUSAL_PATTERNS,
  SystemException,
  createMfaProvider,
  findRepoRoot,
  loadConfig,
  step,
  visible,
  type Probe,
  type ProbeContext,
  type ProbeEvidence,
  type ProbeSet,
} from '@rpa/core';
import path from 'node:path';
import type { Page } from 'playwright';
import { automationConfigSchema, type AutomationConfig } from '../config.ts';
import { AnthemLoginPage } from '../pages/login.page.ts';
import { isPortalComplaint } from '../pages/portal-errors.ts';
import { PLATFORM_HOST } from '../pages/portal-origins.ts';
import { createAnthemSession } from '../session.ts';
import { ANTHEM_CAUSES } from './known-causes.ts';

/**
 * The three things we can watch on Anthem without writing anything.
 *
 * ── WHY EXACTLY THESE THREE ─────────────────────────────────────────────────
 * Rule 10a freezes Anthem production to signing in and navigating, and a run at
 * `allowSubmit: false` still creates a real account and a real quote. So the
 * monitorable surface is bounded by what the two permitted diagnostics already
 * do - and these probes are those two diagnostics, plus a cheap session check
 * that makes the expensive one affordable.
 *
 * Each one is deliberately the LARGEST observation that writes nothing:
 *
 *   portal-access      no credentials at all. Does the carrier serve us a login
 *                      page from this runtime, through this CA, headed?
 *   portal-session     cookies only. Is the stored session still accepted? This
 *                      is what decides whether looking costs an MFA code.
 *   portal-navigation  signs in and performs the SAML hop via the launchpad
 *                      tile - verified to create no account, no quote and no
 *                      application. `Create Quote` is the step that starts
 *                      writing and is deliberately never touched.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** The launchpad tile that performs the SSO hand-off without creating anything. */
const LAUNCHPAD_TILE = 'Small Group Quote & Enroll';

/**
 * Screen ids. Stable and human-chosen, because they name baseline FILES and a
 * rename re-files every finding on that screen.
 */
const SCREEN = {
  login: 'ptb-login',
  dashboard: 'ptb-dashboard',
  oktaPassword: 'okta-password',
  platform: 'fulcrum-home',
} as const;

/**
 * An alert that is not a complaint is not, by itself, drift.
 *
 * Reusing the automation's own classifier rather than a fresh string list is
 * load-bearing: this dashboard carries "We've redesigned your dashboard!" in
 * the SAME `role=alert` region as its validation errors, so without this the
 * access probe would report drift on every run from the day it is switched on.
 * `isPortalComplaint` also already carries the scar tissue from a success toast
 * once being read as a validation error.
 */
function isInformationalAlert(text: string): boolean {
  return !isPortalComplaint(text);
}

/**
 * Did the carrier refuse us as a bot?
 *
 * The patterns come from `@rpa/core` now rather than from a local `REFUSALS`
 * const. That move is what makes the known-cause catalog load-bearing instead
 * of decorative: the access probe's bot detection and the catalog's
 * `carrier-bot-block` row are the same list, so they cannot disagree.
 */
async function readRefusal(page: Page): Promise<string | undefined> {
  const title = await page.title().catch(() => '');
  const body = await page
    .evaluate('document.body ? document.body.innerText : ""')
    .catch(() => '');
  const text = String(body).replace(/\s+/g, ' ').trim();

  const matched = BOT_REFUSAL_PATTERNS.find(
    (pattern) => pattern.test(title) || pattern.test(text),
  );
  return matched === undefined ? undefined : `${String(matched)} matched: ${text.slice(0, 200)}`;
}

/** The automation's own directory, resolved once. */
function automationDir(repoRoot: string): string {
  return path.join(repoRoot, 'automations', 'group-submission', 'anthem-ca-new-plans');
}

/**
 * Loads the REAL automation config.
 *
 * A probe that hand-rolled a partial config would be testing its own literal
 * rather than the portalUrl a run actually uses - and `portalUrl` has already
 * been wrong once, pointing at a marketing page with no username field at all.
 */
async function loadAnthemConfig(): Promise<{
  repoRoot: string;
  dataDir: string;
  automation: AutomationConfig;
}> {
  const repoRoot = findRepoRoot();
  const config = await loadConfig({
    repoRoot,
    automationDir: automationDir(repoRoot),
    env: process.env['APP_ENV'] ?? 'dev',
    automationSchema: automationConfigSchema,
  });

  return {
    repoRoot,
    dataDir: path.resolve(repoRoot, config.dataDir),
    automation: config.automation,
  };
}

/**
 * ── PROBE 1: can we load the login page at all? ─────────────────────────────
 * Credential-free, so it is the only probe cheap enough to run every fifteen
 * minutes - and the only one that can still answer when the account is locked.
 */
const portalAccess: Probe = {
  id: 'anthem-ca/portal-access',
  carrier: 'anthem-ca',
  title: 'Anthem serves a login page to this runtime',
  sets: ['access'],
  needsCredentials: false,
  maySpendMfa: false,
  screenIds: [SCREEN.login],
  knownCauses: ANTHEM_CAUSES,
  isInformationalAlert,

  async run(ctx: ProbeContext): Promise<void> {
    const { automation } = await loadAnthemConfig();
    const url = automation.portalUrl;

    await step(ctx.steps, {
      name: 'load the login page',
      /**
       * An explicit budget on the STEP, not just the gate. `step()` caps every
       * gate at the step's own `timeoutMs`, so a 45s gate inside a 60s-default
       * step silently becomes 45s - and a gate budget above the step budget is
       * silently truncated, which once cut a page off mid-render.
       */
      timeoutMs: 90_000,
      alwaysRun: true,
      action: async () => {
        await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        /**
         * Settle briefly: an interstitial often replaces the document after
         * load, so a reading taken at `domcontentloaded` can describe a page
         * that no longer exists. Three seconds is what the hand-run diagnostic
         * has always used.
         */
        await ctx.page.waitForTimeout(3_000);
      },
      /**
       * A 200 is not the signal - an interstitial returns 200 too. The positive
       * signal is a sign-in field actually being on screen, and it has to be a
       * WAITING question (rule 9b).
       */
      postcondition: () =>
        visible(
          ctx.page.locator('input[type=password], input[name*=user i], [aria-label*=username i]').first(),
          20_000,
        ),
    });

    await ctx.observe(SCREEN.login);

    const refusal = await readRefusal(ctx.page);
    if (refusal !== undefined) {
      throw new SystemException(`The carrier refused this runtime: ${refusal}`, {
        details: { probe: this.id, refusal },
      });
    }
  },

  explain(evidence: ProbeEvidence): readonly string[] {
    if (evidence.verdict === 'pass') {
      return ['  OK - the carrier served a login page to this runtime.'];
    }

    /**
     * The load-bearing wording from the hand-run script, moved here so the
     * script and the sentinel cannot come to disagree. The headless/headed
     * branch matters: one is an invocation mistake with a documented fix, the
     * other is a real problem.
     */
    return evidence.runtime.headless
      ? [
          '  REFUSED, and the browser was headless.',
          '',
          '  Carrier portals routinely block headless Chromium - Anthem serves Access Denied',
          '  outright. Re-run with HEADLESS=false; in a container the entrypoint supplies a',
          '  virtual display via xvfb. This is not a fault in the automation.',
        ]
      : [
          '  REFUSED, and the browser was HEADED.',
          '',
          '  This is NOT the known headless block. Capture the page and record it in the drift',
          '  log before assuming the automation is at fault - check whether the egress IP or the',
          '  user-agent changed. Do not retry in a loop; that is what escalates a block.',
        ];
  },
};

/**
 * ── PROBE 2: is the stored session still worth anything? ────────────────────
 * The cheapest useful question on this portal, and the input to every decision
 * about whether the expensive probe can afford to run.
 */
const portalSession: Probe = {
  id: 'anthem-ca/portal-session',
  carrier: 'anthem-ca',
  title: 'The stored Anthem session is still accepted',
  sets: ['session'],
  needsCredentials: false,
  maySpendMfa: false,
  screenIds: [SCREEN.dashboard],
  knownCauses: ANTHEM_CAUSES,
  isInformationalAlert,

  async run(ctx: ProbeContext): Promise<void> {
    const { automation, dataDir } = await loadAnthemConfig();
    const storageStatePath = path.join(dataDir, 'sessions', 'anthem-ca.json');

    /**
     * `probeStoredSession` reaches `#signIn` on no path - that is the whole
     * point. It applies the state exactly as production does (addCookies plus
     * an init script, never `newContext({ storageState })`), so a healthy
     * verdict here means the same thing a run would see.
     */
    const liveness = await probeStoredSession({
      storageStatePath,
      context: ctx.context,
      page: ctx.page,
      login: new AnthemLoginPage(automation),
      logger: ctx.logger,
    });

    ctx.recordSession({
      storedSessionPresent: liveness.liveness !== 'absent',
      storedSessionAgeMs: liveness.ageMs,
      liveness: liveness.liveness,
      signedInVia: liveness.liveness === 'alive' ? 'reused' : 'not-attempted',
      mfaCodeSpent: false,
    });

    if (liveness.liveness === 'alive') await ctx.observe(SCREEN.dashboard);

    /**
     * A lapsed session is NOT a failure of this probe. The probe's job is to
     * report liveness, and "the session expired" is a normal, expected fact
     * about a portal whose sessions expire. Reporting it as a failure would
     * file an issue every time a weekend passed.
     */
  },

  explain(evidence: ProbeEvidence): readonly string[] {
    const { liveness, storedSessionAgeMs } = evidence.session;
    const age =
      storedSessionAgeMs === undefined
        ? '(no file)'
        : `${Math.round(storedSessionAgeMs / 60_000)} min old`;

    return [
      `  session  : ${liveness} ${age}`,
      liveness === 'alive'
        ? '  No MFA code is needed to look at this portal right now.'
        : '  A sign-in would cost a one-time code (measured 132-600s to arrive, expires on a',
      liveness === 'alive' ? '' : '  countdown, delivered primarily to a mailbox we cannot read).',
    ].filter((entry) => entry !== '');
  },
};

/**
 * ── PROBE 3: sign in and reach the quoting platform. Creates nothing. ───────
 *
 * The route matters and is not interchangeable. It uses the dashboard's
 * `Small Group Quote & Enroll` launchpad tile, which performs the SAME SAML
 * hand-off as `Create Quote` but lands on the platform HOME - verified during
 * reconnaissance to create no account, no quote and no application.
 * `Create Quote` is the step that starts writing, and it is deliberately not
 * touched here.
 */
const portalNavigation: Probe = {
  id: 'anthem-ca/portal-navigation',
  carrier: 'anthem-ca',
  title: 'Sign-in works and the SAML hop reaches the quoting platform',
  sets: ['navigation'],
  needsCredentials: true,
  maySpendMfa: true,
  screenIds: [SCREEN.dashboard, SCREEN.oktaPassword, SCREEN.platform],
  knownCauses: ANTHEM_CAUSES,
  isInformationalAlert,

  async run(ctx: ProbeContext): Promise<void> {
    const repoRoot = findRepoRoot();
    const config = await loadConfig({
      repoRoot,
      automationDir: automationDir(repoRoot),
      env: process.env['APP_ENV'] ?? 'dev',
      automationSchema: automationConfigSchema,
    });
    const auto = config.automation;

    const mfa = createMfaProvider({ config: config.mfa, logger: ctx.logger, secrets: ctx.secrets, repoRoot });

    /**
     * The SAME builder `initialize.ts` uses. A diagnostic that reconstructs the
     * sign-in it is meant to verify proves less the moment the two drift, and
     * the copy most likely to be forgotten is the one outside the automation.
     */
    const session = createAnthemSession({
      config: auto,
      secrets: ctx.secrets,
      mfa,
      logger: ctx.logger,
      dataDir: path.resolve(repoRoot, config.dataDir),
    });

    let outcome;
    try {
      outcome = await session.ensureSignedIn(ctx.page, ctx.context);
    } finally {
      /**
       * The mailbox provider holds a lock for as long as it lives and is only
       * needed while signing in. Leaving it open wedges the next run with "the
       * profile is already in use" - a failure with nothing to do with the
       * portal, and one that accumulated twenty orphaned browsers once.
       */
      await mfa.close?.();
    }

    ctx.recordSession({
      storedSessionPresent: outcome.hadStoredSession,
      liveness: outcome.how === 'reused' ? 'alive' : 'lapsed',
      signedInVia: outcome.how,
      mfaCodeSpent: outcome.how === 'password-and-mfa',
    });

    await session.saveSession(ctx.context);
    await ctx.observe(SCREEN.dashboard);

    // ── The SAML hop, via the tile that creates nothing. ──
    const popup = ctx.page.waitForEvent('popup', { timeout: 60_000 }).catch(() => undefined);
    await ctx.page
      .locator('div,span,a,button')
      .filter({ hasText: new RegExp(`^${LAUNCHPAD_TILE}$`) })
      .filter({ visible: true })
      .first()
      .click({ timeout: 45_000 });

    const platform: Page = (await popup) ?? ctx.page;
    ctx.followPage(platform);
    await platform.waitForLoadState('domcontentloaded').catch(() => undefined);
    await platform.waitForTimeout(8_000);

    /**
     * The community session expires independently of the portal one, so this
     * hop can ask for the password again even when sign-in reported `reused`.
     * That costs the password only - Okta does not ask for a factor, because
     * the device is trusted - so it is recovery, not MFA spend.
     */
    const login = new AnthemLoginPage(auto);
    const resolved = await login.resolveSamlChallenge(
      platform,
      await ctx.secrets.require(auto.passwordEnv),
    );

    if (resolved) {
      ctx.recordSession({ samlReauthenticated: true });
      await ctx.observe(SCREEN.oktaPassword, platform);
      await platform.waitForTimeout(5_000);
      await session.saveSession(ctx.context);
    }

    const host = safeHost(platform.url());

    const stillChallenged = await platform
      .locator('input[type=password]')
      .filter({ visible: true })
      .first()
      .isVisible()
      .catch(() => false);

    if (stillChallenged) {
      throw new SystemException(
        'The SAML hop asked for a password again, and re-authenticating it did not work. ' +
          'This is NOT the ordinary community-session lapse, which resolveSamlChallenge already ' +
          'attempted. Likely a wrong ANTHEM_PORTAL_PASSWORD, or Okta showing an unexpected ' +
          'factor screen for this hop.',
        { details: { probe: this.id, host } },
      );
    }

    if (host !== PLATFORM_HOST) {
      throw new SystemException(
        `Expected to land on ${PLATFORM_HOST}, but the hand-off settled on ${host}.`,
        { details: { probe: this.id, host } },
      );
    }

    await ctx.observe(SCREEN.platform, platform);
  },

  explain(evidence: ProbeEvidence): readonly string[] {
    const lines: string[] = [
      `  sign-in  : ${evidence.session.signedInVia}` +
        (evidence.session.mfaCodeSpent ? ' (spent an MFA code)' : ' (no code spent)'),
      `  saml     : ${evidence.session.samlReauthenticated ? 're-authenticated' : 'not challenged'}`,
    ];

    if (evidence.verdict === 'pass') {
      lines.push('  OK - signed in and reached the quoting platform, with nothing created.');
      return lines;
    }

    /**
     * Pre-empts a diagnosis that was tested and retracted. Leaving this out is
     * how the same wrong theory gets re-derived at 03:00 by whoever reads the
     * failure next.
     */
    lines.push(
      '',
      '  FAILED before reaching the platform.',
      '',
      '  It is NOT a container-vs-host or device-token problem. That theory was tested and',
      '  retracted - see the 2026-09-04 entries in the Anthem drift log. Only elapsed time',
      '  decides whether the hop is challenged, and resolveSamlChallenge answers that with the',
      '  password alone.',
    );
    return lines;
  },
};

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}

const probeSet: ProbeSet = { probes: [portalAccess, portalSession, portalNavigation] };

export default probeSet;
