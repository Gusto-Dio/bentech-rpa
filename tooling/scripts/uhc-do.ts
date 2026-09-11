import {
  SecretResolver,
  createLogger,
  createMfaProvider,
  findRepoRoot,
  loadConfig,
  type MfaMatcher,
} from '@rpa/core';
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { CDP_PORT, COMMANDS, dump, runCommand, sessionPath, settle } from './uhc-recon.ts';

/**
 * Runs commands against the browser `uhc-serve.ts` is holding open.
 *
 * Attaches over CDP, drives the page that is already there, and detaches WITHOUT
 * closing - so the portal keeps its place and the next command starts from the
 * screen this one reached.
 *
 *   pnpm tsx tooling/scripts/uhc-do.ts "c New Case" "f Company Name=The Company LLC"
 *   pnpm tsx tooling/scripts/uhc-do.ts            # just dump where we are
 *   pnpm tsx tooling/scripts/uhc-do.ts save       # persist the signed-in session
 */

const CDP_URL = `http://localhost:${CDP_PORT}`;

/**
 * Persists the signed-in session so the rest of the mapping spends no MFA codes.
 *
 * Written 0600, and never printed. `data/sessions/` is credential-equivalent and
 * gitignored: a storage state is a bearer token for a real licensed producer's
 * portal account, and it is treated exactly as `carrier-portal-session.ts`
 * treats the one the automation writes.
 */
async function saveSession(context: BrowserContext): Promise<void> {
  const statePath = sessionPath(findRepoRoot());
  await mkdir(path.dirname(statePath), { recursive: true });
  await context.storageState({ path: statePath });
  await chmod(statePath, 0o600);
  console.log(`Saved the session to ${path.relative(findRepoRoot(), statePath)} (0600).`);
  console.log('It is credential-equivalent and gitignored. Never copy or print it.');
}

/**
 * Fills a field with the VALUE of an environment variable, by name.
 *
 * `secret <field label>=<ENV_VAR_NAME>`
 *
 * Mapping a portal means getting past its login, and the obvious way - read the
 * password and type it - puts a real credential into whatever transcript,
 * scrollback or log is watching the mapping session. This resolves the variable
 * inside the process instead, so the only thing that appears anywhere is the
 * variable's NAME. The same reason config carries env-var names rather than
 * values; see docs/poc/sanitization.md.
 *
 * Nothing about the value is printed - not a prefix, not its length. The
 * confirmation is read back from the field as a masked character count, which is
 * enough to tell "it typed" from "the locator missed".
 */
async function fillSecret(page: Page, spec: string): Promise<void> {
  const [label = '', envVar = ''] = spec.split('=');

  if (label.trim() === '' || envVar.trim() === '') {
    console.log('  usage: secret <field label>=<ENV_VAR_NAME>');
    return;
  }

  const value = await new SecretResolver().require(envVar.trim()).catch((cause: unknown) => {
    console.log(`  !! ${envVar.trim()} is not set (${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)})`);
    return undefined;
  });
  if (value === undefined) return;

  const field = page.getByLabel(new RegExp(label.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
  await field.fill(value).catch((cause: unknown) => {
    console.log(`  !! could not fill "${label.trim()}": ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`);
  });

  const typed = await field.inputValue().catch(() => '');
  console.log(`  filled "${label.trim()}" from $${envVar.trim()} (${'*'.repeat(typed.length)})`);
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

/**
 * Completes the sign-in from the password screen, spending exactly one code.
 *
 * ── WHY THIS IS ONE COMMAND AND NOT THREE ───────────────────────────────────
 * The MFA watermark has to be set immediately BEFORE the action that sends the
 * code, and checked against messages newer than it. Each `uhc-do` invocation is
 * a separate process, so a watermark taken in one command cannot be honoured by
 * the next - split across commands it would either race the incoming text or
 * accept a stale one. The shared session helper splits `enterCredentials` from
 * `submitCredentials` for exactly this reason; here the whole thing stays in one
 * process instead.
 *
 * Nothing is printed: not the password, not the code, not its length. UHC's
 * codes arrive as forwarded text messages and are the most rate-limited resource
 * in this automation, which is why the session is saved the moment it works.
 */
async function signIn(page: Page, context: BrowserContext): Promise<void> {
  const repoRoot = findRepoRoot();
  const config = await loadConfig<{
    mfaLabel: string;
    mfaSenderAllowList: string[];
    mfaTimeoutMs: number;
    passwordEnv: string;
  }>({
    repoRoot,
    automationDir: path.join(repoRoot, 'automations', 'group-submission', 'uhc-np-new-plans'),
    env: process.env['APP_ENV'] ?? 'dev',
  });

  const logger = createLogger({ level: 'warn', pretty: true, base: {} });
  const secrets = new SecretResolver();
  const auto = config.automation;

  const matcher: MfaMatcher = {
    label: auto.mfaLabel,
    fromAllowList: auto.mfaSenderAllowList,
    codePattern: /\b(\d{6})\b/,
  };

  const password = await secrets.require(auto.passwordEnv);
  await page.getByLabel(/password/i).first().fill(password);
  console.log('  filled the password from $' + auto.passwordEnv);

  const mfa = createMfaProvider({ config: config.mfa, logger, secrets, repoRoot });

  try {
    // The watermark, immediately before the one action that sends the code.
    const since = new Date();
    await page.getByRole('button', { name: /^Continue$/ }).first().click();
    await settle(page, 6_000);

    console.log(`  submitted; polling the "${auto.mfaLabel}" label for a code newer than the watermark`);

    /**
     * Returns the code itself, and the provider consumes the message it read -
     * so a second attempt cannot pick up the same code twice.
     */
    const code = await mfa.waitForCode({
      matcher,
      since,
      timeoutMs: auto.mfaTimeoutMs,
      purpose: 'uhc-samx-mapping-signin',
    });

    const field = page
      .getByLabel(/(verification|security|one[- ]time|access|passcode|otp).*code|code/i)
      .first();
    await field.fill(code);
    console.log('  filled the code (not printed)');

    await page.getByRole('button', { name: /^(Continue|Verify|Submit)$/ }).first().click();
    await settle(page, 8_000);
  } finally {
    await mfa.close?.();
  }

  // Saved the moment it works: the next mapping command must not need a code.
  await saveSession(context);
}

async function main(): Promise<void> {
  const commands = process.argv.slice(2);
  loadEnv();

  const browser = await chromium.connectOverCDP(CDP_URL).catch((cause: unknown) => {
    console.error(
      `Could not attach to a recon browser on ${CDP_URL}.\n` +
        'Start one first:  pnpm tsx tooling/scripts/uhc-serve.ts &\n' +
        `(${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)})`,
    );
    process.exit(1);
  });

  try {
    /**
     * The LAST page, not the first. connectOverCDP surfaces Chromium's own blank
     * startup tab as context 0, and the page uhc-serve opened is after it.
     */
    const contexts = browser.contexts();
    const pages: Page[] = contexts.flatMap((context) => context.pages());
    const page = pages.at(-1);
    const context = contexts.at(-1);

    if (page === undefined || context === undefined) {
      console.error('The recon browser has no open page. Restart uhc-serve.ts.');
      process.exit(1);
    }

    if (commands.length === 1 && commands[0] === 'save') {
      await saveSession(context);
      return;
    }

    if (commands.length === 0) {
      console.log(`\nNo command given. Available:\n${COMMANDS}`);
      await dump(page);
      return;
    }

    for (const command of commands) {
      console.log(`\n>>> ${command}`);
      if (command === 'save') {
        await saveSession(context);
        continue;
      }
      if (command.startsWith('secret ')) {
        await fillSecret(page, command.slice(7));
        await settle(page);
        continue;
      }
      if (command === 'signin') {
        await signIn(page, context);
        continue;
      }
      await runCommand(page, command);
      await settle(page);
    }
    await dump(page);
  } finally {
    /**
     * Disconnect, never close. `browser.close()` on a CDP connection detaches
     * rather than tearing down the browser it attached to - which is what keeps
     * uhc-serve's session alive between commands.
     */
    await browser.close();
  }
}

await main();
