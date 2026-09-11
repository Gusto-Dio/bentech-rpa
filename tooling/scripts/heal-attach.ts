import { chromium, type Browser, type Page } from 'playwright';

/**
 * Attaching to the recon browser, in one place.
 *
 * Three verification scripts need the same thing: the page `anthem-serve.ts` is
 * already holding open, on the screen a human or an agent has parked it on. The
 * reason to share it rather than repeat it is the comment below about which page
 * to pick - that detail was discovered once and would be re-discovered wrongly
 * by each copy.
 */

const CDP_URL = 'http://localhost:9222';

export interface Attached {
  browser: Browser;
  page: Page;
}

export async function attachToReconBrowser(): Promise<Attached> {
  const browser = await chromium.connectOverCDP(CDP_URL).catch((cause: unknown) => {
    console.error(
      `Could not attach to a recon browser on ${CDP_URL}.\n` +
        'Start one first:  pnpm tsx tooling/scripts/anthem-serve.ts &\n' +
        `(${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)})`,
    );
    process.exit(1);
  });

  /**
   * The LAST page, not the first. `connectOverCDP` surfaces Chromium's own
   * blank startup tab as context 0, and the signed-in page `anthem-serve`
   * opened is the one after it. Picking the first gives `about:blank` and every
   * locator then reports zero matches - which reads exactly like a broken
   * locator on a working portal.
   */
  const pages: Page[] = browser.contexts().flatMap((context) => context.pages());
  const page = pages.at(-1);

  if (page === undefined) {
    console.error('The recon browser has no page open.');
    await browser.close();
    process.exit(1);
  }

  return { browser, page };
}

/**
 * Disconnect, never close.
 *
 * `browser.close()` on a CDP connection detaches rather than killing the
 * browser, which is what we want - the recon session is expensive to rebuild
 * and the whole harness exists so it survives between commands.
 */
export async function detach(browser: Browser): Promise<void> {
  await browser.close().catch(() => undefined);
}
