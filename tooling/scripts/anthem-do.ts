import { chromium, type Page } from 'playwright';
import { COMMANDS, dump, runCommand, settle } from './anthem-recon.ts';

/**
 * Runs commands against the browser `anthem-serve.ts` is holding open.
 *
 * Attaches over CDP, drives the page that is already there, and detaches WITHOUT
 * closing - so the portal keeps its place and the next command starts from the
 * screen this one reached. That is the whole point: a command costs a couple of
 * seconds instead of a browser launch, and a twenty-screen process can be walked
 * one screen at a time.
 *
 *   pnpm tsx tooling/scripts/anthem-do.ts "c Start Quote" "c Select a Market@1"
 *   pnpm tsx tooling/scripts/anthem-do.ts            # just dump where we are
 */

const CDP_URL = 'http://localhost:9222';

async function main(): Promise<void> {
  const commands = process.argv.slice(2);

  const browser = await chromium.connectOverCDP(CDP_URL).catch((cause: unknown) => {
    console.error(
      `Could not attach to a recon browser on ${CDP_URL}.\n` +
        'Start one first:  pnpm tsx tooling/scripts/anthem-serve.ts &\n' +
        `(${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)})`,
    );
    process.exit(1);
  });

  try {
    /**
     * The LAST page, not the first. connectOverCDP surfaces Chromium's own
     * blank startup tab as context 0, and the signed-in page anthem-serve
     * opened is the one after it.
     */
    const pages: Page[] = browser.contexts().flatMap((context) => context.pages());
    const page = pages.at(-1);

    if (page === undefined) {
      console.error('The recon browser has no open page. Restart anthem-serve.ts.');
      process.exit(1);
    }

    if (commands.length === 0) {
      console.log(`\nNo command given. Available:\n${COMMANDS}`);
      await dump(page);
      return;
    }

    for (const command of commands) {
      console.log(`\n>>> ${command}`);
      await runCommand(page, command);
      await settle(page);
    }
    await dump(page);
  } finally {
    /**
     * Disconnect, never close. Closing here would tear down the very browser
     * this script exists to preserve.
     */
    await browser.close();
  }
}

await main();
