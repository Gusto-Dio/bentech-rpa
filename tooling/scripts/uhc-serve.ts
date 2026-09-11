import { findRepoRoot } from '@rpa/core';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import {
  PORTAL_HOST,
  PRELOGIN_PATH,
} from '../../automations/group-submission/uhc-np-new-plans/src/pages/portal-origins.ts';
import { CDP_PORT, sessionPath } from './uhc-recon.ts';

/**
 * Holds ONE signed-in UHC browser open, for a whole re-mapping session.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Mapping SAMx means walking about twenty screens and reading each one. Doing
 * that by re-running the automation costs a sign-in and an MFA CODE every time,
 * and UHC's codes arrive as forwarded text messages - a rate-limited resource
 * that must not be spent on exploration: explore with the persisted session
 * instead of re-running the login. See AGENTS.md rule 10b.
 *
 * So this launches the browser once and idles. `uhc-do.ts` attaches over CDP,
 * runs a command against the SAME page and detaches without closing, so the
 * portal keeps its place and a command costs a couple of seconds.
 *
 *   pnpm tsx tooling/scripts/uhc-serve.ts &        # once
 *   pnpm tsx tooling/scripts/uhc-do.ts "c New Case"
 *
 * Read-only by intent: never trigger an attestation, a Finalize or a Submit
 * while mapping. See AGENTS.md rule 10.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Fixed, and deliberately not overridable from argv.
 *
 * This process restores a credential-equivalent session into a headed Chromium
 * and exposes it on a debugging port, so whatever URL it opens is loaded with a
 * live production session attached. A URL argument would make that an egress
 * path for anything able to spawn the script. Navigation is the harness's job,
 * and `uhc-do.ts "u <url>"` is fenced to `RECON_HOSTS`.
 *
 */
const START_URL = `https://${PORTAL_HOST}${PRELOGIN_PATH}`;

/**
 * Headed, and not configurable.
 *
 * Two reasons. Carrier portals routinely serve a bot interstitial to headless
 * Chromium - Anthem returns `Access Denied` outright - and, more importantly,
 * the FIRST session here has to be created by a human signing in, because no
 * stored UHC session has ever existed.
 */
const HEADLESS = false;


/**
 * The parsed shape `newContext({ storageState })` accepts.
 *
 * Derived from Playwright's own option type rather than redeclared, so a
 * Playwright upgrade that changes it fails the typecheck here instead of at
 * runtime. `string` is excluded because the file is read and parsed below - a
 * missing session has to fail as a readable absence, not as Playwright throwing
 * on a path that is not there.
 */
type StoredState = Exclude<
  NonNullable<Parameters<Browser['newContext']>[0]>['storageState'],
  string | undefined
>;

/**
 * Restores a stored session when there is one, and says so plainly when there
 * is not.
 *
 * Unlike Anthem's equivalent this must tolerate ABSENCE. No UHC session has ever
 * been created, so the first run of this script is expected to open a signed-out
 * browser - and failing on a missing file would make the tool unusable exactly
 * when it is needed most.
 */
async function restoreState(statePath: string): Promise<StoredState | undefined> {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as StoredState;
  } catch {
    return undefined;
  }
}

/**
 * The CLI loads `.env` for us; a bare tsx script does not.
 *
 * Without this every `secret` command reports the variable as unset, which looks
 * exactly like a missing credential rather than a missing env load - the same
 * trap `check-portal-access.ts` documents.
 */
function loadEnv(): void {
  const envFile = path.join(findRepoRoot(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

async function main(): Promise<void> {
  const repoRoot = findRepoRoot();
  loadEnv();
  const statePath = sessionPath(repoRoot);
  const storageState = await restoreState(statePath);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [`--remote-debugging-port=${CDP_PORT}`],
  });

  const context: BrowserContext = await browser.newContext({
    ...(storageState === undefined ? {} : { storageState }),
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

  console.log(`UHC recon browser is up on CDP port ${CDP_PORT}.`);
  console.log(`   at: ${page.url()}`);

  if (storageState === undefined) {
    console.log('\n   No stored session (data/sessions/uhc.json does not exist).');
    console.log('   Sign in BY HAND in the browser window that just opened, then run:');
    console.log('       pnpm tsx tooling/scripts/uhc-do.ts save');
    console.log('   That persists the session so the rest of the mapping spends no MFA codes.');
  } else {
    console.log('   Restored the stored session. If the portal shows a login screen it has');
    console.log('   lapsed server-side - sign in by hand again and re-run `uhc-do.ts save`.');
  }

  console.log('\n   drive it with: pnpm tsx tooling/scripts/uhc-do.ts "<command>"');
  console.log('   stop it with:  pkill -f uhc-serve');

  /**
   * Closing on SIGINT/SIGTERM matters more than it looks. An orphaned Chromium
   * left holding a profile is what made twenty of them accumulate on the Anthem
   * PoC and every later run fail for a reason unrelated to its actual problem.
   */
  const shutdown = (): void => {
    void browser.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

await main();
