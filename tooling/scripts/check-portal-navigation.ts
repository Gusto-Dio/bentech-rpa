import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  SecretResolver,
  chromiumLaunchOptions,
  createLogger,
  createMfaProvider,
  findRepoRoot,
  loadConfig,
} from '@rpa/core';
import { chromium, type Page } from 'playwright';
import { automationConfigSchema } from '../../automations/group-submission/anthem-ca-new-plans/src/config.ts';
import { AnthemLoginPage } from '../../automations/group-submission/anthem-ca-new-plans/src/pages/login.page.ts';
import { createAnthemSession } from '../../automations/group-submission/anthem-ca-new-plans/src/session.ts';

/**
 * Signs in to Anthem and proves we can reach the quoting platform. Creates nothing.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Anthem production is frozen to login and navigation while the records the PoC
 * left behind are cleared - see rule 10a in AGENTS.md. `pnpm rpa run` is not
 * allowed under that freeze at ANY `allowSubmit` setting, because a run creates a
 * real account and a real quote before it parks on Attestation.
 *
 * That left no way to answer the question the container work actually turns on:
 * a container reusing a HOST-created session reaches the portal and then hits an
 * Okta SAML password challenge on the way to the platform, where the host passes
 * the same step with the same session file. This checks exactly that hop, and
 * nothing past it.
 *
 * The route matters. It uses the dashboard's **`Small Group Quote & Enroll`**
 * launchpad tile, which performs the same SAML hand-off as `Create Quote` but
 * lands on the platform HOME - verified during reconnaissance to create no
 * account, no quote and no application. `Create Quote` is the step that starts
 * writing, and it is deliberately not touched.
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   pnpm tsx tooling/scripts/check-portal-navigation.ts
 *
 * In the container, where the point is a session the container created itself:
 *   docker compose run --rm -e HEADLESS=false \
 *     --entrypoint tooling/docker/with-display.sh rpa \
 *     pnpm tsx tooling/scripts/check-portal-navigation.ts
 */

/** The launchpad tile that performs the SSO hand-off without creating anything. */
const LAUNCHPAD_TILE = 'Small Group Quote & Enroll';

const PLATFORM_HOST = 'elevancehealthfulcrum.my.site.com';

async function main(): Promise<void> {
  const repoRoot = findRepoRoot();
  const envFile = path.join(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const automationDir = path.join(repoRoot, 'automations', 'group-submission', 'anthem-ca-new-plans');
  const config = await loadConfig({
    repoRoot,
    automationDir,
    env: process.env['APP_ENV'] ?? 'dev',
    automationSchema: automationConfigSchema,
  });

  const logger = createLogger({ level: config.logLevel, pretty: config.logPretty, base: {} });
  const secrets = new SecretResolver();
  const auto = config.automation;

  console.log('check-portal-navigation');
  console.log(`  headless : ${config.browser.headless}`);
  console.log(`  display  : ${process.env['DISPLAY'] ?? '(none)'}`);
  console.log(`  mfa      : ${config.mfa.provider}`);
  console.log(`  session  : ${path.join(config.dataDir, 'sessions', 'anthem-ca.json')}`);
  console.log();

  const mfa = createMfaProvider({
    config: config.mfa,
    logger,
    secrets,
    repoRoot,
  });

  /**
   * The SAME builder `initialize.ts` uses. A diagnostic that reconstructs the
   * sign-in it is meant to verify proves less the moment the two drift.
   */
  const session = createAnthemSession({
    config: auto,
    secrets,
    mfa,
    logger,
    dataDir: path.resolve(repoRoot, config.dataDir),
  });

  const browser = await chromium.launch(chromiumLaunchOptions(config.browser));

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // ── 1. Sign in ────────────────────────────────────────────────────────────
    let outcome;
    try {
      outcome = await session.ensureSignedIn(page, context);
    } finally {
      // The mailbox provider holds a lock for as long as it lives, and it is
      // only needed while signing in.
      await mfa.close?.();
    }

    console.log(`  STEP 1 sign-in  : OK (${outcome.how}, stored session ${outcome.hadStoredSession ? 'found' : 'absent'})`);
    await session.saveSession(context);

    // ── 2. The SAML hop to the quoting platform ──────────────────────────────
    const popup = page.waitForEvent('popup', { timeout: 60_000 }).catch(() => undefined);
    await page
      .locator('div,span,a,button')
      .filter({ hasText: new RegExp(`^${LAUNCHPAD_TILE}$`) })
      .filter({ visible: true })
      .first()
      .click({ timeout: 45_000 });

    const platform: Page = (await popup) ?? page;
    await platform.waitForLoadState('domcontentloaded').catch(() => undefined);
    await platform.waitForTimeout(8_000);

    /**
     * The community session expires independently of the portal one, so this hop
     * can ask for the password again even when sign-in reported `reused`. The
     * login page knows how to answer it; this is the same recovery the
     * automation performs.
     */
    const login = new AnthemLoginPage(auto);
    const resolved = await login.resolveSamlChallenge(
      platform,
      await secrets.require(auto.passwordEnv),
    );
    if (resolved) {
      console.log('  STEP 2 saml     : re-authenticated (the community session had lapsed)');
      await platform.waitForTimeout(5_000);
      await session.saveSession(context);
    }

    const url = platform.url();
    const host = safeHost(url);
    const challenged = await platform
      .locator('input[type=password]')
      .filter({ visible: true })
      .first()
      .isVisible()
      .catch(() => false);

    console.log(`  STEP 2 platform : ${host}`);

    if (challenged) {
      console.log();
      console.log('  FAILED - the SAML hop asked for a password again.');
      console.log(`  url: ${url.slice(0, 160)}`);
      console.log();
      console.log(
        '  The community session had lapsed and re-authenticating it did not work, so\n' +
          '  this is NOT the ordinary lapse that resolveSamlChallenge handles - it was\n' +
          '  already tried a few lines above. Likely causes: a wrong ANTHEM_PORTAL_PASSWORD,\n' +
          '  or Okta showing an unexpected factor screen for this hop.\n' +
          '\n' +
          '  It is NOT a container-vs-host or device-token problem. That theory was tested\n' +
          '  and retracted - see the 2026-09-04 entries in the Anthem drift log. Only\n' +
          '  elapsed time decides whether the hop is challenged.',
      );
      process.exitCode = 1;
      return;
    }

    if (host !== PLATFORM_HOST) {
      console.log();
      console.log(`  FAILED - expected to land on ${PLATFORM_HOST}.`);
      console.log(`  url: ${url.slice(0, 160)}`);
      process.exitCode = 1;
      return;
    }

    console.log();
    console.log('  OK - signed in and reached the quoting platform, with nothing created.');
  } finally {
    await browser.close();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}

await main();
