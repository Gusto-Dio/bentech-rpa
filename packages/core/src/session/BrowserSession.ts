import type { Logger } from 'pino';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { EvidenceCapableSession } from '../contracts/Session.ts';
import type { BrowserConfig } from '../config/schema.ts';
import { SystemException } from '../errors.ts';

/**
 * REFramework's InitAllApplications / CloseAllApplications / KillAllProcesses,
 * for a browser.
 *
 * Note what this class does NOT do: log in. Authentication is the automation's
 * business, and it lives in the automation's `initialize()`. The runner re-runs
 * `initialize()` after every recover(), which is precisely how REFramework
 * re-invokes InitAllApplications - and the reason `initialize()` must be
 * idempotent.
 */
export interface BrowserSessionOptions {
  config: BrowserConfig;
  logger: Logger;
  /**
   * Where a session video goes, when `config.recordVideo` is on.
   *
   * Passed in rather than derived, because the session has no business knowing
   * how the artifact store lays out a run - the runner already owns that.
   */
  videoDir?: string;
}

export class BrowserSession implements EvidenceCapableSession {
  readonly kind = 'browser';

  readonly #config: BrowserConfig;
  readonly #logger: Logger;
  readonly #videoDir: string | undefined;

  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  #tracingActive = false;
  #chunkOpen = false;

  constructor(options: BrowserSessionOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#videoDir = options.videoDir;
  }

  get page(): Page {
    if (this.#page === undefined) {
      throw new SystemException('Browser session is not initialised (no page)');
    }
    return this.#page;
  }

  get context(): BrowserContext {
    if (this.#context === undefined) {
      throw new SystemException('Browser session is not initialised (no context)');
    }
    return this.#context;
  }

  async init(): Promise<void> {
    const args = [...this.#config.args];
    if (this.#config.noSandbox) {
      // Documented escape hatch for running as root in a container. The image
      // shipped with this repo runs as the non-root pwuser precisely so this
      // stays off: with the sandbox disabled, a compromised page inherits the
      // container's privileges.
      args.push('--no-sandbox', '--disable-setuid-sandbox');
    }

    this.#logger.debug(
      { headless: this.#config.headless, noSandbox: this.#config.noSandbox, args },
      'Launching Chromium',
    );

    this.#browser = await chromium.launch({
      headless: this.#config.headless,
      slowMo: this.#config.slowMoMs,
      args,
    });

    const viewport = { width: this.#config.viewport.width, height: this.#config.viewport.height };

    /**
     * Video is opt-in and needs a directory. Playwright writes one file per
     * PAGE and only finalises it when the context closes, so `close()` below
     * logs where they landed - otherwise a recorded run leaves files nobody
     * knows about.
     */
    const recording =
      this.#config.recordVideo && this.#videoDir !== undefined
        ? { recordVideo: { dir: this.#videoDir, size: viewport } }
        : {};

    this.#context = await this.#browser.newContext({
      viewport,
      locale: this.#config.locale,
      timezoneId: this.#config.timezoneId,
      ...recording,
    });

    if (this.#config.recordVideo) {
      if (this.#videoDir === undefined) {
        this.#logger.warn('recordVideo is on but no video directory was provided; not recording');
      } else {
        this.#logger.info({ videoDir: this.#videoDir }, 'Recording this session to video');
      }
    }
    this.#context.setDefaultTimeout(this.#config.actionTimeoutMs);
    this.#context.setDefaultNavigationTimeout(this.#config.navigationTimeoutMs);

    if (this.#config.tracing) {
      await this.#context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      this.#tracingActive = true;
    }

    this.#page = await this.#context.newPage();
  }

  /** Full teardown and relaunch. A partially recovered session just fails maxRetries times instead of once. */
  async recover(): Promise<void> {
    this.#logger.warn('Recovering browser session: closing everything and relaunching');
    await this.close();
    await this.init();
  }

  async close(): Promise<void> {
    if (this.#tracingActive && this.#context !== undefined) {
      await this.#safely('stop tracing', async () => {
        if (this.#chunkOpen) {
          await this.#context?.tracing.stopChunk();
          this.#chunkOpen = false;
        }
        await this.#context?.tracing.stop();
      });
    }
    this.#tracingActive = false;

    /**
     * The video path has to be read BEFORE the context closes - the Video
     * handle belongs to the page - but the FILE only exists afterwards, because
     * Playwright finalises it on close. Hence: capture the paths, close, then
     * log them.
     */
    const videos =
      this.#config.recordVideo && this.#context !== undefined
        ? await Promise.all(
            this.#context.pages().map(async (page) => page.video()?.path().catch(() => undefined)),
          )
        : [];

    await this.#safely('close context', async () => this.#context?.close());
    await this.#safely('close browser', async () => this.#browser?.close());

    const recorded = videos.filter((path): path is string => path !== undefined);
    if (recorded.length > 0) {
      this.#logger.info({ videos: recorded }, 'Session video saved');
    }

    this.#page = undefined;
    this.#context = undefined;
    this.#browser = undefined;
  }

  /** One trace chunk per transaction attempt, so a saved trace holds that attempt and nothing else. */
  async startTrace(title: string): Promise<void> {
    if (!this.#tracingActive || this.#context === undefined) return;
    if (this.#chunkOpen) await this.discardTrace();
    await this.#context.tracing.startChunk({ title });
    this.#chunkOpen = true;
  }

  async saveTrace(file: string): Promise<void> {
    if (!this.#chunkOpen || this.#context === undefined) return;
    await this.#context.tracing.stopChunk({ path: file });
    this.#chunkOpen = false;
  }

  async discardTrace(): Promise<void> {
    if (!this.#chunkOpen || this.#context === undefined) return;
    await this.#context.tracing.stopChunk();
    this.#chunkOpen = false;
  }

  async captureScreenshot(file: string): Promise<void> {
    await this.page.screenshot({ path: file, fullPage: true });
  }

  /** Teardown is best-effort: a failure here must not replace the error that caused it. */
  async #safely(what: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (cause) {
      this.#logger.debug({ err: cause }, `Ignored failure while trying to ${what}`);
    }
  }
}
