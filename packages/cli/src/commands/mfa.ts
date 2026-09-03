import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  GmailUiMfaProvider,
  PlaywrightGmailUiPage,
  parseAccountFromTitle,
  createLogger,
  findAutomation,
  findRepoRoot,
  loadConfig,
  type GmailUiMode,
  type MfaConfig,
} from '@rpa/core';
import { chromium } from 'playwright';
import { flagBool, flagInt, flagString, resolveEnv, type ParsedArgs } from '../args.ts';
import { errorLine, heading, line, pad, style } from '../ui.ts';

/**
 * `rpa mfa` - prove the mailbox is reachable BEFORE a run needs a code, and
 * answer the two questions nobody can answer from the code alone: is the
 * session still alive, and who actually sends the carrier's MFA mail.
 *
 * Seeding and signing in cannot be automated, and that is deliberate: the OTP
 * for the Google account is not available to an unattended process. So these
 * commands do the parts a script can do and leave the rest to a person.
 */

const CREDENTIAL_WARNING =
  'A signed-in Gmail session is credential-equivalent: anyone with access to it has the ' +
  'mailbox. data/profiles/ and data/sessions/ are gitignored - do not copy them anywhere ' +
  'and do not print their contents.';

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function mfaCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];

  if (sub === 'check') return checkMailbox(args);
  if (sub === 'seed-profile') return seedProfile(args);
  if (sub === 'chrome') return printChromeCommand(args);
  if (sub === 'probe') return probeCode(args);

  errorLine('Usage: rpa mfa check --label "<gmail label>" [--automation <id>] [--days 7]');
  errorLine('       rpa mfa probe --label "<l>" --from "a,b"  read one real code end to end (CONSUMES it)');
  errorLine('       rpa mfa chrome                      print how to start Chrome for gmail-cdp');
  errorLine('       rpa mfa seed-profile [--account <email>] [--automation <id>]');
  return 2;
}

/**
 * Resolves the MFA config, optionally as a given automation sees it.
 *
 * `--automation` matters because the two carriers deliver codes to DIFFERENT
 * mailboxes, so `mfa.profileDir` is not one global value. An automation's
 * config.<env>.json is layer 4 and merges over the platform defaults, so it can
 * override the whole mfa block - and these commands must read exactly what the
 * run will read, or a green check proves nothing.
 */
async function resolveMfa(args: ParsedArgs): Promise<{ config: MfaConfig; repoRoot: string }> {
  const repoRoot = findRepoRoot();
  const automationId = flagString(args, 'automation');
  const automationDir =
    automationId === undefined ? repoRoot : (await findAutomation(repoRoot, automationId)).dir;

  const config = await loadConfig({ repoRoot, automationDir, env: resolveEnv(args) });
  return { config: config.mfa, repoRoot };
}

function modeFor(config: MfaConfig, repoRoot: string): GmailUiMode | undefined {
  if (config.provider === 'gmail-cdp') return { kind: 'cdp', endpoint: config.cdpEndpoint };
  if (config.provider === 'gmail-profile') {
    return { kind: 'profile', userDataDir: path.resolve(repoRoot, config.profileDir), headless: false };
  }
  return undefined;
}

/**
 * `rpa mfa chrome` - the exact command, because getting it slightly wrong fails
 * in a confusing way: if Chrome is already running the flag is silently
 * ignored and the DevTools port never opens.
 */
async function printChromeCommand(args: ParsedArgs): Promise<number> {
  const { config, repoRoot } = await resolveMfa(args);
  const port = new URL(config.cdpEndpoint).port;

  const dir = path.resolve(repoRoot, config.profileDir);

  heading('rpa mfa chrome');
  line(style.yellow('  Chrome 136+ IGNORES --remote-debugging-port on the default profile.'));
  line(style.dim('  Google added that to stop anything attaching to a real profile and reading'));
  line(style.dim('  its cookies. So your everyday Chrome session cannot be attached to, and the'));
  line(style.dim('  command below uses a dedicated directory that a human signs into once.'));
  line();
  line('  Start a dedicated Chrome with a DevTools port:');
  line();
  line(`     ${style.bold(`"${CHROME_MAC}" --remote-debugging-port=${port} --user-data-dir="${dir}"`)}`);
  line();
  line('  Then confirm the mailbox is reachable:');
  line();
  line(`     ${style.bold('pnpm rpa mfa check --label "Access Token (Anthem)"')}`);
  line();
  line(
    style.yellow(
      'The port is loopback-only and grants full control of that browser, including every ' +
        'session signed in to it. Never forward it off the machine.',
    ),
  );
  line(
    style.dim(
      'Since a human signs in either way, mfa.provider "gmail-profile" does the same job ' +
        'without the port. Prefer it unless such a browser is already running.',
    ),
  );
  return 0;
}

/**
 * Reads the label and reports metadata only - a count, the distinct senders and
 * the newest date. Never a subject, a body or a code.
 *
 * The sender list is the point: mfaSenderAllowList is a security control, and a
 * wrong value rejects every real code. This is how you set it from evidence
 * instead of guessing.
 */
async function checkMailbox(args: ParsedArgs): Promise<number> {
  const { config, repoRoot } = await resolveMfa(args);
  const label = flagString(args, 'label') ?? process.env['GMAIL_MFA_LABEL'];
  const days = flagInt(args, 'days') ?? 7;

  heading('rpa mfa check');
  line(`  provider : ${config.provider}`);
  line(`  label    : ${label ?? style.dim('(none given)')}`);

  const mode = modeFor(config, repoRoot);
  if (mode === undefined) {
    line();
    errorLine(
      style.red(
        `mfa.provider is "${config.provider}", which reads no mailbox. ` +
          'Set it to "gmail-cdp" or "gmail-profile" to use this command.',
      ),
    );
    return 2;
  }

  line(`  source   : ${mode.kind === 'cdp' ? mode.endpoint : mode.userDataDir}`);
  line();

  if (label === undefined || label.length === 0) {
    errorLine(style.red('No label to check. Pass --label "<name>", or set GMAIL_MFA_LABEL in .env.'));
    return 2;
  }

  /**
   * Reads the LABEL VIEW, exactly as the provider does. The `--days` window is
   * applied here in the CLI rather than in a query, so this cannot drift from
   * what a run actually sees.
   */
  line(style.dim(`  source   : #label/${label.split(' ').join('+')}`));
  line();

  const logger = createLogger({ level: 'warn', pretty: false, base: {} });
  let page: PlaywrightGmailUiPage | undefined;

  try {
    page = await PlaywrightGmailUiPage.open(mode, logger);
    const cutoff = Date.now() - days * 86_400_000;
    const all = await page.listLabel(label);
    const rows = all.filter((row) => (row.receivedAt?.getTime() ?? 0) >= cutoff);

    if (rows.length === 0) {
      /**
       * Report the mailbox here too. An empty label and the WRONG mailbox look
       * identical from the outside, and that is a genuinely hard bug to find
       * later.
       */
      line(`  mailbox  : ${(await page.signedInAccount()) ?? style.yellow('could not be determined')}`);
      line(style.yellow(`The label is reachable, but no mail in it from the last ${days} days.`));
      line(style.dim('  Widen the window with --days, confirm the label name is exact, and'));
      line(style.dim('  confirm the mailbox above is the one that receives the carrier mail.'));
      return 0;
    }

    line(style.green(`Signed in, and the label is readable.`));
    line(`  mailbox  : ${(await page.signedInAccount()) ?? style.yellow('could not be determined')}`);
    line(`  messages : ${rows.length} in the last ${days} days`);
    line();

    /**
     * Per sender: how many messages, and how many LOOK like they carry a code.
     *
     * The second number is what decides the allow-list. A label often collects
     * more than codes - forwards, notifications, ops chatter - and putting a
     * sender on the allow-list that never carries a code widens an
     * anti-spoofing control for nothing.
     *
     * A boolean per message, never the code. Read from the list snippet only,
     * so no message is opened and nothing is marked read - running this
     * diagnostic must not consume a code the automation still needs.
     */
    const senders = new Map<string, { total: number; withCode: number }>();
    for (const row of rows) {
      // A row is a thread and can carry several senders - the carrier's
      // original plus a forward - so count each of them.
      for (const raw of row.senders) {
        const from = raw.trim().toLowerCase();
        if (from.length === 0) continue;
        const entry = senders.get(from) ?? { total: 0, withCode: 0 };
        entry.total += 1;
        if (/\b\d{6}\b/.test(row.snippet)) entry.withCode += 1;
        senders.set(from, entry);
      }
    }

    line(style.bold('  Senders in this label'));
    line(style.dim(`    ${pad('address', 56)} ${pad('msgs', 6)} with a 6-digit code`));
    for (const [from, { total, withCode }] of [...senders].sort((a, b) => b[1].withCode - a[1].withCode)) {
      const verdict = withCode > 0 ? style.green(String(withCode)) : style.dim('0');
      line(`    ${pad(from, 56)} ${pad(String(total), 6)} ${verdict}`);
    }
    if (senders.size === 0) {
      line(style.yellow('    none readable — the sender selector needs re-mapping'));
    }

    /**
     * `--diagnose` distinguishes "this mail carries no code" from "our snippet
     * selector is broken", which look identical from the summary above and have
     * completely different fixes.
     *
     * Reports the LENGTH of each snippet and the LENGTHS of the digit runs in
     * it. Never a snippet, never a code. It also reveals the code's real shape:
     * the matcher assumes six digits, and nothing has confirmed that.
     */
    if (flagBool(args, 'diagnose')) {
      line();
      line(style.bold('  Per-message diagnosis (lengths only, never content)'));
      line(style.dim(`    ${pad('sender', 40)} ${pad('snippet len', 12)} digit-run lengths`));
      for (const row of rows) {
        const runs = [...row.snippet.matchAll(/\d+/g)].map((m) => m[0].length);
        const shape = runs.length === 0 ? style.yellow('none') : runs.join(',');
        line(`    ${pad(row.senders.join(',').slice(0, 38), 40)} ${pad(String(row.snippet.length), 12)} ${shape}`);
      }
      line();
      if (rows.every((row) => row.snippet.length === 0)) {
        line(
          style.yellow(
            '    Every snippet is empty, so the snippet selector is broken rather than the mail ' +
              'being code-free. The provider still works - it falls back to opening each ' +
              'message - but that marks mail read, so it is worth re-mapping.',
          ),
        );
      }
    }

    if (senders.size > 0) {
      line();
      line(
        style.dim(
          '    Put only the senders that actually carry codes on mfaSenderAllowList.',
        ),
      );
    }

    const newest = rows
      .map((r) => r.receivedAt)
      .filter((d): d is Date => d !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    line();
    line(`  newest   : ${newest?.toISOString() ?? style.yellow('unreadable — the date selector needs re-mapping')}`);
    return 0;
  } catch (thrown) {
    errorLine(style.red(thrown instanceof Error ? thrown.message : String(thrown)));
    return 1;
  } finally {
    await page?.close();
  }
}

async function seedProfile(args: ParsedArgs): Promise<number> {
  const { config, repoRoot } = await resolveMfa(args);
  const dir = path.resolve(repoRoot, config.profileDir);
  const account = flagString(args, 'account') ?? process.env['GMAIL_ACCOUNT'];

  heading('rpa mfa seed-profile');
  line(`  profile  : ${dir}`);
  line(`  provider : ${config.provider}`);
  line(`  account  : ${account ?? style.dim('(not specified — pass --account to pin it)')}`);
  line();

  if (process.stdin.isTTY !== true) {
    errorLine(style.red('This command needs a terminal and a display - a human has to sign in.'));
    return 1;
  }

  if (config.provider !== 'gmail-profile') {
    line(style.yellow(`Note: mfa.provider is "${config.provider}", so runs will not use this profile.`));
    line();
  }

  await mkdir(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(dir, { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    /**
     * Go straight to the right account instead of a picker.
     *
     * This is a fresh, dedicated profile - it is NOT the everyday Chrome
     * profile, and it cannot be: Chrome 136+ refuses to expose a debugging
     * interface for the default profile, and a copied profile arrives signed
     * out because macOS encrypts its cookies against a Keychain entry
     * Chromium cannot read. So a one-time sign-in here is unavoidable; the
     * account hint just removes the guesswork from it.
     */
    await page.goto(accountHintUrl(account), { waitUntil: 'domcontentloaded' });

    line(style.bold('A Chromium window is open. In it:'));
    line(`  1. Sign in as ${style.bold(account ?? 'the account that receives the carrier MFA mail')}.`);
    line('  2. Complete Google MFA if prompted (1Password here - just this once).');
    line('  3. Confirm you can see the mail list, then come back here.');
    line();

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    await rl.question('Press Enter when you are signed in... ');
    rl.close();

    await page.goto('https://mail.google.com/mail/u/0/', { waitUntil: 'domcontentloaded' });
    if (/accounts\.google\.com|ServiceLogin/i.test(page.url())) {
      line();
      errorLine(style.red('Still signed out. The profile was not seeded.'));
      return 1;
    }

    const signedIn = parseAccountFromTitle(await page.title());
    line();
    line(style.green('Profile seeded.'));
    line(`  mailbox : ${signedIn ?? style.yellow('could not be determined')}`);

    /**
     * A mismatch is worth failing on. A profile signed into the wrong account
     * works perfectly and reads the wrong inbox forever: the codes simply never
     * arrive, and nothing anywhere says why.
     */
    if (account !== undefined && signedIn !== undefined && signedIn !== account.toLowerCase()) {
      line();
      errorLine(style.red(`Expected ${account} but this profile is signed in as ${signedIn}.`));
      errorLine(style.red('Sign out in the window and re-run, or pass the account you actually want.'));
      return 1;
    }

    line(`  verify  : ${style.bold('pnpm rpa mfa check --label "Access Token (Anthem)"')}`);
    line();
    line(style.yellow(CREDENTIAL_WARNING));
    return 0;
  } finally {
    await context.close();
  }
}

/**
 * Lands on the sign-in form with the account pre-filled, rather than on a
 * chooser. Google's AccountChooser honours an `Email` hint and a `continue`
 * target, so there is nothing to click before typing a password.
 */
function accountHintUrl(account: string | undefined): string {
  const inbox = 'https://mail.google.com/mail/u/0/';
  if (account === undefined || account.length === 0) return inbox;
  const params = new URLSearchParams({ Email: account, continue: inbox });
  return `https://accounts.google.com/AccountChooser?${params.toString()}`;
}

/**
 * `rpa mfa probe` - the acceptance test for a new carrier or label.
 *
 * Runs the REAL provider against the real mailbox and reports whether a code
 * could be obtained. It never prints the code, or its length.
 *
 * It CONSUMES a message: the whole point is to prove the marked-read path
 * works, so it deliberately does the irreversible half too. Run it against a
 * label whose newest code is already spent.
 */
async function probeCode(args: ParsedArgs): Promise<number> {
  const { config, repoRoot } = await resolveMfa(args);
  const label = flagString(args, 'label');
  const from = flagString(args, 'from');
  const minutes = flagInt(args, 'minutes') ?? 60;
  const timeoutSeconds = flagInt(args, 'timeout') ?? 25;

  heading('rpa mfa probe');

  const mode = modeFor(config, repoRoot);
  if (mode === undefined || label === undefined || from === undefined) {
    errorLine(
      style.red('Usage: rpa mfa probe --label "<gmail label>" --from "sender1,sender2" [--minutes 60]'),
    );
    errorLine(style.dim('mfa.provider must be gmail-cdp or gmail-profile.'));
    return 2;
  }

  const fromAllowList = from.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
  const since = new Date(Date.now() - minutes * 60_000);

  line(`  label     : ${label}`);
  line(`  allow-list: ${fromAllowList.join(', ')}`);
  line(`  since     : ${since.toISOString()} (${minutes}m ago)`);
  line(style.yellow('  This marks a message read. Only the fact of success is printed, never the code.'));
  line();

  const logger = createLogger({ level: 'warn', pretty: false, base: {} });
  const provider = new GmailUiMfaProvider({ mode, logger, pollIntervalMs: 5_000 });

  try {
    const code = await provider.waitForCode({
      since,
      timeoutMs: timeoutSeconds * 1_000,
      // The same six-digit shape both automations configure.
      matcher: { label, fromAllowList, codePattern: /\b(\d{6})\b/ },
      purpose: 'rpa mfa probe',
    });

    // Only a shape assertion. The value never reaches stdout or a log.
    line(style.green('A code was read and the message was marked read.'));
    line(`  shape   : ${/^\d{6}$/.test(code) ? 'six digits, as configured' : style.yellow('NOT six digits — the codePattern needs changing')}`);
    line();
    line(style.dim('Re-running now should find nothing: the message was consumed.'));
    return 0;
  } catch (thrown) {
    errorLine(style.red(thrown instanceof Error ? thrown.message : String(thrown)));

    /**
     * Explain the most common cause instead of leaving "no code arrived".
     *
     * Codes are only ever picked up while UNREAD - that is what stops a retry
     * reusing one - so a label full of already-read mail yields nothing, which
     * is correct but looks broken. Historical mail cannot be probed; only a
     * freshly delivered code can.
     */
    /**
     * Release the profile first. A persistent profile can only be opened by one
     * browser at a time, so diagnosing while the provider still holds it fails
     * silently - which is exactly what it did the first time. close() is
     * idempotent, so the finally below is still safe.
     */
    await provider.close();

    const logger2 = createLogger({ level: 'silent', pretty: false, base: {} });
    let page: PlaywrightGmailUiPage | undefined;
    try {
      page = await PlaywrightGmailUiPage.open(mode, logger2);
      const cutoff = Date.now() - minutes * 60_000;
      const all = await page.listLabel(label);
      const inWindow = all.filter((row) => (row.receivedAt?.getTime() ?? 0) >= cutoff);
      line();
      line(style.bold('  What the label actually holds'));
      line(`    rows in the label      : ${all.length}`);
      line(`    newer than the window  : ${inWindow.length}`);
      const newest = all
        .map((row) => row.receivedAt)
        .filter((at): at is Date => at !== undefined)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      line(`    newest                 : ${newest?.toISOString() ?? 'unreadable'}`);
      if (all.length > 0 && inWindow.length === 0) {
        line();
        line(
          style.yellow(
            '    The label has mail, but none newer than the watermark. Widen --minutes, or ' +
              'trigger a fresh code: the watermark deliberately refuses anything older, because ' +
              'an old code has already been invalidated by the portal.',
          ),
        );
      }
    } catch {
      // Diagnosis is best-effort; never replace the original failure.
    } finally {
      await page?.close();
    }

    return 1;
  } finally {
    await provider.close();
  }
}
