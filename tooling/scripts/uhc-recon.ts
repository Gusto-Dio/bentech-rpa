import path from 'node:path';
import type { Page } from 'playwright';
import {
  isReconOrigin,
  RECON_HOSTS,
} from '../../automations/group-submission/uhc-np-new-plans/src/pages/portal-origins.ts';
import { readScreen } from '../../automations/group-submission/uhc-np-new-plans/src/pages/read-screen.ts';

/**
 * The shared half of the UHC re-mapping harness.
 *
 * ── WHY IT REUSES THE AUTOMATION'S OWN READER ───────────────────────────────
 * `dump()` prints whatever `readScreen()` returns - the same function
 * `gate-evidence.ts` calls when a gate fails. Two readers would be worse than
 * useless: the screen you map would be described slightly differently from the
 * screen the automation reports when it breaks, so a locator could look
 * confirmed and still fail, or fail and look confirmed. One reader, two
 * consumers.
 *
 * It deliberately does NOT reuse `anthem-recon.ts`. That module's fence is
 * bound to Anthem's hosts, and its describe functions walk Salesforce Lightning
 * shadow roots for a wizard rail SAMx has no reason to have.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Where `uhc-serve.ts` listens, and where the session is kept.
 *
 * They live in this module rather than in `uhc-serve.ts` because `uhc-do.ts`
 * needs both and `uhc-serve.ts` ends in a top-level `await main()` - importing
 * it to read a constant would LAUNCH a second idling browser. Anthem's pair
 * avoids that by duplicating the port number in both files; one shared module
 * is better than two literals that can drift apart.
 *
 * 9223, not Anthem's 9222, so both harnesses can be up at once.
 */
export const CDP_PORT = 9223;

/** The reused session. Credential-equivalent: gitignored, 0600, never printed. */
export function sessionPath(repoRoot: string): string {
  return path.join(repoRoot, 'data', 'sessions', 'uhc.json');
}

/** Long enough for a single-page portal to finish rendering after a click. */
export const SETTLE_MS = 2_500;

/**
 * Not `networkidle`. A portal with polling or analytics never reaches it, and
 * the wait then expires at the navigation timeout on every single command.
 */
export async function settle(page: Page, ms: number = SETTLE_MS): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(ms);
}

/**
 * Prints what is on screen, in the shape a locator is written from.
 *
 * ⚠ Field VALUES are printed. On a production portal those are real - a group
 * name, a contact's phone number. This is a developer tool whose output goes to
 * a terminal; do not paste its output into a commit, an issue or a doc.
 */
export async function dump(page: Page): Promise<void> {
  const screen = await readScreen(page);

  if (screen === undefined) {
    console.log(`\nURL: ${page.url()}`);
    console.log('   (the page would not answer - it may still be navigating)');
    return;
  }

  console.log(`\nURL:      ${screen.url}`);
  console.log(`TITLE:    ${screen.title}`);
  if (screen.alerts.length > 0) console.log(`ALERTS:   ${screen.alerts.join(' | ')}`);
  if (screen.modal !== null) console.log(`MODAL:    ${screen.modal}`);

  console.log('\nHEADINGS:');
  for (const heading of screen.headings) console.log(`  ${heading}`);

  console.log('\nFIELDS:');
  for (const field of screen.fields) console.log(`  ${field.label} = ${field.value ?? ''}`);

  console.log('\nBUTTONS:');
  for (const button of screen.buttons) console.log(`  ${button}`);

  console.log('\nLINKS:');
  for (const link of screen.links) console.log(`  ${link}`);

  if (screen.answered.length > 0) {
    console.log('\nANSWERED:');
    for (const answered of screen.answered) console.log(`  ${answered}`);
  }

  await reportAmbiguity(page, screen.buttons);
}

/**
 * Names that match more than one control.
 *
 * This is the trap `anthem-verify-checklist.ts` was written to catch: a locator
 * derived from a dump looks right, and then `getByRole('button', { name })`
 * resolves to three elements and Playwright refuses in strict mode - or worse,
 * `.first()` picks a hidden one. Reporting it while mapping is much cheaper than
 * discovering it mid-run.
 */
async function reportAmbiguity(page: Page, buttons: readonly string[]): Promise<void> {
  const ambiguous: string[] = [];

  for (const name of buttons) {
    if (name === '') continue;
    const count = await page
      .getByRole('button', { name, exact: true })
      .count()
      .catch(() => 0);
    if (count > 1) ambiguous.push(`${name} (x${count})`);
  }

  if (ambiguous.length > 0) {
    console.log('\nAMBIGUOUS (getByRole will need a filter or an nth):');
    for (const entry of ambiguous) console.log(`  ${entry}`);
  }
}

export const COMMANDS = [
  '  <blank>        dump this screen again',
  '  u <url>        navigate (UHC hosts only)',
  '  c <name>       click the button with that accessible name (name@2 for the 2nd)',
  '  r <role> <nm>  click by role + accessible name',
  '  t <text>       click by visible text, for role-less controls',
  '  f <label>=<v>  fill the field with that label',
  '  a <legend>=<v> answer a radio question by its group name',
  '  b              back',
  '  secret <l>=<E> fill field <l> from env var <E>, without printing the value',
  '  signin         from the password screen: password + MFA + save session (one code)',
  '  save           persist this signed-in session to data/sessions/uhc.json',
].join('\n');

/** `Continue@2` -> `Continue`. */
function bare(input: string): string {
  return input.replace(/@\d+$/, '').trim();
}

/** `Continue@2` -> the 2nd match. Anything else -> the locator unchanged. */
function nth<T extends { nth: (i: number) => T }>(locator: T, input: string): T {
  const match = /@(\d+)$/.exec(input.trim());
  return match?.[1] === undefined ? locator : locator.nth(Number(match[1]) - 1);
}

/**
 * Runs one harness command against an already-open page.
 *
 * A failed command LOGS rather than throws. This browser holds a session that
 * cost a sign-in and an MFA code; a mistyped button name must not end the
 * mapping session.
 */
export async function runCommand(page: Page, answer: string): Promise<void> {
  try {
    if (answer.startsWith('u ')) {
      const target = answer.slice(2).trim();
      /**
       * The fence. This browser holds a live production session restored from
       * `data/sessions/uhc.json`, so an unrestricted `goto` is an egress path
       * with credentials already attached - see the note on `RECON_HOSTS`.
       * Refusing is deliberately not a throw: a bad command should not cost the
       * session.
       */
      if (!isReconOrigin(target)) {
        console.log(`\n!! refused: ${target}`);
        console.log(`   The recon harness may only navigate to: ${RECON_HOSTS.join(', ')}`);
        console.log('   If the portal has genuinely moved, add the host to RECON_HOSTS');
        console.log('   deliberately and record it in the drift log.');
        return;
      }
      await page.goto(target, { waitUntil: 'domcontentloaded' });
    } else if (answer === 'b') {
      await page.goBack({ waitUntil: 'domcontentloaded' });
    } else if (answer.startsWith('c ')) {
      await nth(page.getByRole('button', { name: bare(answer.slice(2)), exact: true }), answer).click();
    } else if (answer.startsWith('r ')) {
      const [role = 'button', ...rest] = answer.slice(2).trim().split(' ');
      const target = page.getByRole(role as Parameters<Page['getByRole']>[0], {
        name: bare(rest.join(' ')),
        exact: true,
      });
      await nth(target, answer).click();
    } else if (answer.startsWith('t ')) {
      await nth(page.getByText(bare(answer.slice(2)), { exact: true }), answer).click();
    } else if (answer.startsWith('f ')) {
      const [label = '', ...value] = answer.slice(2).split('=');
      await nth(page.getByLabel(bare(label), { exact: false }), label).fill(value.join('=').trim());
    } else if (answer.startsWith('a ')) {
      const [legend = '', ...value] = answer.slice(2).split('=');
      await page
        .getByRole('group', { name: new RegExp(bare(legend), 'i') })
        .getByRole('radio', { name: new RegExp(`^${value.join('=').trim()}$`, 'i') })
        .check();
    } else {
      console.log(`\n?? unrecognised command: ${answer}\n${COMMANDS}`);
    }
  } catch (cause: unknown) {
    console.log(`\n!! ${answer} failed: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`);
  }
}
