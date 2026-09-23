import { SecretResolver } from '@rpa/core';
import { chromium, type Page } from 'playwright';
import { BrokerPortalPage } from '../src/pages/broker-portal.page.ts';
import { RenewalsPage } from '../src/pages/renewals.page.ts';

/**
 * Walks the BCBS MA portal chain read-only, using the same page objects the
 * real run uses, and stops at the first step that does not behave as
 * expected - before any real transaction ever starts.
 *
 * This is deliberately not `rpa sentinel`: sentinel compares a DOM
 * fingerprint against a committed baseline and can file a healing task. This
 * only answers "is the chain reachable right now", for one automation, with
 * no baseline to maintain - a cheaper check for a single automation that
 * still has no Phase 2 wired up.
 *
 * Never downloads anything: this automation never writes to the carrier
 * either way, but there is no reason to pull a real file just to prove the
 * chain is reachable.
 *
 *   pnpm exec tsx automations/packet-collection/bcbs-ma-packets/scripts/preflight.ts
 *   pnpm exec tsx automations/packet-collection/bcbs-ma-packets/scripts/preflight.ts --group "Wysa Inc"
 */

type Level = 'pass' | 'fail' | 'skip';

interface Check {
  name: string;
  level: Level;
  detail?: string;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file. Expected in every deployed environment.
  }

  const sampleGroup = flag('group');
  const secrets = new SecretResolver();
  const username = await secrets.optional('BCBS_MA_USERNAME');
  const password = await secrets.optional('BCBS_MA_PASSWORD');

  if (username === undefined || password === undefined) {
    console.error('Missing BCBS_MA_USERNAME/BCBS_MA_PASSWORD - set them in .env first.');
    process.exitCode = 2;
    return;
  }

  const checks: Check[] = [];
  let broken = false;

  async function check(name: string, run: () => Promise<void>): Promise<void> {
    if (broken) {
      checks.push({ name, level: 'skip', detail: 'earlier step failed' });
      return;
    }
    try {
      await run();
      checks.push({ name, level: 'pass' });
    } catch (error) {
      broken = true;
      checks.push({ name, level: 'fail', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const portal = new BrokerPortalPage(page);
  let quotePage: Page | undefined;

  await check('open broker portal login page', () => portal.open('https://bluecrossma.my.site.com/s/'));
  await check('sign in', () => portal.signIn(username, password));
  await check('open BlueQuote (second tab)', async () => {
    quotePage = await portal.openBlueQuote();
  });

  if (quotePage !== undefined) {
    const renewals = new RenewalsPage(quotePage);
    await check('open Renewals tab (grid renders real rows)', () => renewals.openRenewals());

    if (sampleGroup !== undefined) {
      await check(`search for "${sampleGroup}"`, () => renewals.searchGroup(sampleGroup));
      await check(`open "${sampleGroup}" account`, () => renewals.openGroupAccount(sampleGroup));
      await check('open Quotes tab', () => renewals.openQuotesTab(sampleGroup));
    }
  }

  await browser.close();

  console.log('\npreflight: packet-collection/bcbs-ma-packets');
  console.log('='.repeat(60));
  for (const c of checks) {
    const mark = c.level === 'pass' ? 'ok  ' : c.level === 'fail' ? 'FAIL' : 'skip';
    console.log(`  ${mark}  ${c.name}${c.detail !== undefined ? ` - ${c.detail}` : ''}`);
  }
  console.log('='.repeat(60));

  const failed = checks.find((c) => c.level === 'fail');
  if (failed !== undefined) {
    console.log(`Stopped at: ${failed.name}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    sampleGroup === undefined
      ? 'Portal chain reachable. Run again with --group "<name>" to also check the per-group steps.'
      : 'All checks passed. Safe to run the real automation.',
  );
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

await main();
