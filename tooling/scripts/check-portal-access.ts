import { existsSync } from 'node:fs';
import path from 'node:path';
import { BOT_REFUSAL_PATTERNS, chromiumLaunchOptions, findRepoRoot, loadConfig } from '@rpa/core';
import { chromium } from 'playwright';

/**
 * Can this runtime reach a carrier portal at all?
 *
 * Answers the one question `rpa doctor` cannot: doctor proves Chromium starts,
 * this proves the CARRIER accepts it. Anthem serves `Access Denied` to headless
 * Chromium, so the same image can pass every other check and still be unable to
 * load a login page - and finding that out during a real run costs an MFA code
 * and a half-built quote.
 *
 * Read-only and credential-free by design: it navigates to the login page and
 * reports what came back. Nothing is typed, nothing is submitted.
 *
 *   pnpm tsx tooling/scripts/check-portal-access.ts [url]
 *   pnpm tsx tooling/scripts/check-portal-access.ts --automation group-submission/uhc-np-new-plans
 *   HEADLESS=false pnpm tsx tooling/scripts/check-portal-access.ts
 *
 * `--automation` picks whose `config.<env>.json` supplies the default URL, so a
 * second carrier needs no second copy of this script. A positional URL still
 * wins over both.
 *
 * In the container, where the point is to prove the virtual display works. Note
 * `with-display.sh` rather than `pnpm` as the entrypoint: overriding the
 * entrypoint outright loses the display, and then this reports the 403 it exists
 * to rule out.
 *   docker compose run --rm -e HEADLESS=false \
 *     --entrypoint tooling/docker/with-display.sh rpa \
 *     pnpm tsx tooling/scripts/check-portal-access.ts
 */

/**
 * Wording carriers use when they have decided we are a bot.
 *
 * Moved into `@rpa/core` as `BOT_REFUSAL_PATTERNS` and imported back, because
 * the sentinel's known-cause catalog needs the same list. Two copies would
 * eventually disagree, and then this diagnostic and the monitor would give
 * different answers about the same page - which is the failure mode that makes
 * a diagnostic untrustworthy.
 */
const REFUSALS = BOT_REFUSAL_PATTERNS;

async function main(): Promise<void> {
  const repoRoot = findRepoRoot();

  /**
   * The CLI loads .env for us; a bare tsx script does not. Without this the
   * script reports `headless: true` while the automations run headed, which is
   * the opposite of a useful diagnostic.
   */
  const envFile = path.join(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const args = process.argv.slice(2);
  const flagAt = args.indexOf('--automation');
  const automationId =
    flagAt === -1 ? 'group-submission/anthem-ca-new-plans' : (args[flagAt + 1] ?? '');

  if (automationId === '') {
    console.error('--automation needs an id, e.g. group-submission/uhc-np-new-plans');
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig<{ portalUrl?: string }>({
    repoRoot,
    automationDir: path.join(repoRoot, 'automations', ...automationId.split('/')),
    env: process.env['APP_ENV'] ?? 'dev',
  });

  /**
   * A positional URL wins over the automation's configured one.
   *
   * The `flagAt === -1` guard is load-bearing: without it `flagAt + 1` is 0 and
   * the check skips index 0, which is exactly where the URL sits when no
   * --automation flag was passed.
   */
  const positional = args.find(
    (arg, i) => !arg.startsWith('--') && (flagAt === -1 || i !== flagAt + 1),
  );
  const url = positional ?? config.automation.portalUrl;
  if (url === undefined) {
    console.error('No URL to check. Pass one as an argument.');
    process.exitCode = 2;
    return;
  }


  console.log('check-portal-access');
  console.log(`  automation: ${automationId}`);
  console.log(`  url      : ${url}`);
  console.log(`  headless : ${config.browser.headless}`);
  console.log(`  display  : ${process.env['DISPLAY'] ?? '(none)'}`);
  console.log(`  platform : ${process.platform}/${process.arch}`);
  console.log();

  // One definition of config -> launch options, shared with BrowserSession, so
  // this really does launch the browser a run launches.
  const browser = await chromium.launch(chromiumLaunchOptions(config.browser));

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Settle briefly: an interstitial often replaces the document after load.
    await page.waitForTimeout(3_000);

    const status = response?.status() ?? 0;
    const title = await page.title();
    const body = await page.evaluate('document.body ? document.body.innerText : ""');
    const text = String(body).replace(/\s+/g, ' ').trim();

    console.log(`  status   : ${status}`);
    console.log(`  title    : ${title}`);

    const refusal = REFUSALS.find((pattern) => pattern.test(title) || pattern.test(text));
    if (refusal !== undefined) {
      console.log();
      console.log(`  REFUSED - the portal matched ${String(refusal)}`);
      console.log(`  first 200 chars: ${text.slice(0, 200)}`);
      console.log();
      console.log(
        config.browser.headless
          ? '  Carrier portals routinely block headless Chromium - Anthem serves Access Denied\n' +
              '  outright. Re-run with HEADLESS=false; in a container the\n' +
              '  entrypoint supplies a virtual display via xvfb.'
          : '  Headed and still refused. This is NOT the known headless block - capture the page\n' +
              '  and record it in the drift log before assuming the automation is at fault.',
      );
      process.exitCode = 1;
      return;
    }

    /**
     * A login form is the positive signal, not merely a 200: a bot-protection
     * interstitial also returns 200, and Anthem's own marketing page has no
     * username field at all.
     */
    const hasLogin = await page
      .locator('input[type=password], input[name*=user i], [aria-label*=username i]')
      .first()
      .isVisible()
      .catch(() => false);

    console.log(`  login UI : ${hasLogin ? 'present' : 'not found'}`);
    console.log();
    console.log(
      hasLogin
        ? '  OK - the portal served a sign-in page to this runtime.'
        : '  Loaded, but no sign-in field was found. Check the URL is the login page and not\n' +
            '  a marketing page - see the first entry in the Anthem drift log. UHC is a known\n' +
            '  case: its configured portalUrl is still the uhc.com marketing host.',
    );
    if (!hasLogin) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
