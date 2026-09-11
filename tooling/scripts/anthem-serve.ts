import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findRepoRoot } from '@rpa/core';
import { chromium, type Browser } from 'playwright';
import { PORTAL_HOST } from '../../automations/group-submission/anthem-ca-new-plans/src/pages/portal-origins.ts';

/**
 * Holds ONE signed-in Anthem browser open, for the whole re-mapping session.
 *
 * Why this exists: mapping a screen used to mean launching Chromium, restoring
 * the session, navigating, clicking, dumping and quitting - about a minute per
 * command, and every click threw away the state the previous one had reached.
 * Re-deriving a five-click path each time you want to look at the sixth screen
 * is not a workable way to map a twenty-screen process.
 *
 * So this launches the browser once and idles. `anthem-do.ts` attaches over CDP,
 * runs a command against the SAME page, and detaches without closing. A command
 * then costs a couple of seconds and, more importantly, the portal keeps its
 * place.
 *
 *   pnpm tsx tooling/scripts/anthem-serve.ts &        # once
 *   pnpm tsx tooling/scripts/anthem-do.ts "c Start Quote"
 *
 * Read-only by intent, same as before: never trigger a submit, an attestation or
 * a signature while mapping.
 */

/**
 * Fixed, and deliberately not overridable from argv.
 *
 * This process restores `data/sessions/anthem-ca.json` into a headed Chromium
 * and exposes it on a debugging port, so whatever URL it opens is loaded with a
 * live production broker session attached. A URL argument made that an egress
 * path for anything able to spawn the script. Navigation is the harness's job
 * and `anthem-do.ts "u <url>"` is fenced to `RECON_HOSTS`.
 */
const START_URL = `https://${PORTAL_HOST}/apps/ptb/`;

/** Anthem serves `Access Denied` to headless Chromium. Bot protection, not a bug. */
const HEADLESS = false;

/** Fixed, so anthem-do.ts does not need to be told where to attach. */
export const CDP_PORT = 9222;

async function main(): Promise<void> {
  const repoRoot = findRepoRoot();
  const statePath = path.join(repoRoot, 'data', 'sessions', 'anthem-ca.json');

  /**
   * Read and parsed rather than handed over as a path, so a missing session
   * fails here with something readable. The file is credential-equivalent:
   * never print it.
   */
  const storageState = JSON.parse(await readFile(statePath, 'utf8')) as Parameters<
    Browser['newContext']
  >[0] extends infer O
    ? O extends { storageState?: infer S }
      ? Exclude<S, string | undefined>
      : never
    : never;

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [`--remote-debugging-port=${CDP_PORT}`],
  });

  const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  console.log(`Anthem recon browser is up on CDP port ${CDP_PORT}.`);
  console.log(`   at: ${page.url()}`);
  console.log('   drive it with: pnpm tsx tooling/scripts/anthem-do.ts "<command>"');
  console.log('   stop it with:  pkill -f anthem-serve');

  /**
   * Closing on SIGINT/SIGTERM matters more than it looks. An orphaned Chromium
   * left holding a profile is what made twenty of them accumulate and every
   * later run fail for a reason unrelated to its actual problem.
   */
  const shutdown = (): void => {
    void browser.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

await main();
