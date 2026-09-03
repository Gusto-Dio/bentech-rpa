import type { Logger } from 'pino';
import type { Browser, BrowserContext, Page } from 'playwright';
import { SystemException } from '../errors.ts';
import { isAllowedSender, type MfaCodeProvider, type MfaCodeRequest } from './MfaCodeProvider.ts';
import { pollForCode, type MfaMailbox, type MfaMessage } from './mailboxPoll.ts';

/**
 * Reads the MFA code out of the Gmail web interface.
 *
 * ── WHY THIS SCRAPES A JS APP, WHICH IS NORMALLY THE WRONG ANSWER ────────────
 * docs/poc/mfa-gmail.md specified Gmail's basic HTML view precisely to avoid
 * this: plain markup, no app to wait for. Google RETIRED that view in January
 * 2024 - mail.google.com/mail/u/0/h/ no longer exists - so the option the
 * design chose is gone, and the two that remain are the Gmail API
 * (GmailApiMfaProvider, the production target) or this.
 *
 * So treat every selector here as a liability, not an asset. Gmail's class
 * names are build output and will change without notice. Two things keep that
 * survivable:
 *
 *   1. Attribute hooks over class names wherever Gmail offers one - a row's
 *      thread id and `span[email]` are part of its data model, not its styling.
 *   2. Failing CLOSED. Markup we do not recognise yields no messages, so the
 *      poll times out with a System exception. It never yields a wrong code.
 *
 * Prefer GmailApiMfaProvider as soon as an OAuth client exists.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const GMAIL_ROOT = 'https://mail.google.com/mail/u/0/';

/**
 * CHROME 136+ WILL NOT DEBUG THE DEFAULT PROFILE.
 *
 * `--remote-debugging-port` is silently ignored unless it is accompanied by a
 * `--user-data-dir` pointing somewhere other than the default. Google added
 * that restriction specifically to stop anything attaching to a real profile
 * and reading its cookies and session state - which is exactly what "just
 * attach to the Chrome I am already signed into" asks for.
 *
 * So CDP cannot reuse an existing everyday Chrome session. It can only attach
 * to a browser started on a dedicated directory, which means a human still
 * signs in once - at which point `mode: 'profile'` does the same job with one
 * fewer moving part. `gmail-cdp` remains useful only when an operator already
 * keeps such a browser running.
 */
const CDP_HINT =
  'Chrome 136+ ignores --remote-debugging-port on the default profile, so an everyday ' +
  'Chrome session cannot be attached to. Start a dedicated one: ' +
  '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ' +
  '--remote-debugging-port=9222 --user-data-dir=<a non-default dir> ' +
  '(and quit Chrome first if that directory is already in use). ' +
  'Run `pnpm rpa mfa chrome` for the exact command.';

const PROFILE_HINT = 'Seed it with: pnpm rpa mfa seed-profile';

/** One row of a Gmail result list. Cheap: no message has been opened yet. */
export interface GmailRow {
  /**
   * Content-derived identity: sender plus the row's date title.
   *
   * NOT Gmail's DOM id. Those look like ":42" and are reassigned whenever the
   * SPA re-renders, which it does between listing and reading - a reference
   * captured during one poll was already invalid by the time the body was
   * opened. Sender-and-date survives a re-render and is stable enough to
   * consume exactly once.
   */
  id: string;
  /** The raw `title` string, kept so the row can be located again. */
  dateTitle: string;
  /**
   * Every distinct sender in the row, from the row's own data model.
   *
   * Plural because conversation view groups a thread: a forwarded MFA code sits
   * in the same thread as the carrier's original, so the row legitimately has
   * two senders. An earlier version kept only one and discarded anything else
   * as ambiguous, which silently dropped every real code.
   */
  senders: readonly string[];
  subject: string;
  /** undefined when the date could not be read - treated as stale. */
  receivedAt: Date | undefined;
  /** The preview Gmail renders. Often already contains the code. */
  snippet: string;
}

/** What the provider needs from a browser, so tests inject a double instead. */
export interface GmailUiPage {
  /**
   * Loads the LABEL VIEW and returns one descriptor per row.
   *
   * The label view, not a search. Gmail's own URL for it is
   * `#label/Access+Token+(Anthem)`, which is inherently scoped to exactly one
   * label - there is no query syntax to get subtly wrong, and no way for it to
   * quietly widen to the inbox.
   */
  listLabel(label: string): Promise<readonly GmailRow[]>;
  /** Opens a row and returns its body text. Re-locates it by content. */
  readBody(row: GmailRow): Promise<string>;
  /** Marks read so a retry cannot reuse the code. Never deletes. */
  markRead(row: GmailRow): Promise<void>;

  /**
   * Which mailbox this is actually reading, or undefined if it cannot be told.
   *
   * Worth knowing because seeding the wrong Google account produces a profile
   * that works perfectly and reads the wrong inbox forever - the codes simply
   * never arrive, and nothing says why.
   */
  signedInAccount(): Promise<string | undefined>;

  close(): Promise<void>;
}

export type GmailUiMode =
  /** Attach to a Chrome the human already signed in. No credentials to store. */
  | { kind: 'cdp'; endpoint: string }
  /** A dedicated persistent profile, signed in once by a human. */
  | { kind: 'profile'; userDataDir: string; headless: boolean };

export interface GmailUiMfaProviderOptions {
  mode: GmailUiMode;
  logger: Logger;
  pollIntervalMs: number;
  /** Injected in tests. Defaults to a real browser for `mode`. */
  pageFactory?: () => Promise<GmailUiPage>;
  now?: () => number;
  /** Injected in tests alongside `now`. Both or neither. */
  sleepImpl?: (ms: number) => Promise<void>;
  abortSignal?: AbortSignal;
}

export class GmailUiMfaProvider implements MfaCodeProvider, MfaMailbox {
  readonly name: string;

  readonly #options: GmailUiMfaProviderOptions;
  readonly #logger: Logger;

  #page: GmailUiPage | undefined;
  #openInFlight: Promise<GmailUiPage> | undefined;
  /** Rows from the latest search, so consume() can re-locate one by content. */
  readonly #rows = new Map<string, GmailRow>();

  constructor(options: GmailUiMfaProviderOptions) {
    this.#options = options;
    this.name = options.mode.kind === 'cdp' ? 'gmail-cdp' : 'gmail-profile';
    this.#logger = options.logger.child({ component: this.name });
  }

  async waitForCode(request: MfaCodeRequest): Promise<string> {
    return pollForCode(this, request, {
      logger: this.#logger,
      pollIntervalMs: this.#options.pollIntervalMs,
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      ...(this.#options.sleepImpl === undefined ? {} : { sleepImpl: this.#options.sleepImpl }),
      ...(this.#options.abortSignal === undefined ? {} : { abortSignal: this.#options.abortSignal }),
    });
  }

  async close(): Promise<void> {
    const page = this.#page;
    this.#page = undefined;
    this.#openInFlight = undefined;
    if (page !== undefined) await page.close();
  }

  // ── MfaMailbox ─────────────────────────────────────────────────────────────

  async search(request: MfaCodeRequest): Promise<readonly MfaMessage[]> {
    const page = await this.#open();

    /**
     * Scoped by LABEL, and nothing else. Freshness is the watermark's job,
     * applied in the pre-filter below and authoritatively in selectCode.
     */
    const rows = await page.listLabel(request.matcher.label);

    const messages: MfaMessage[] = [];
    for (const row of rows) {
      /**
       * A cheap pre-filter, purely to avoid opening mail we are going to
       * reject - opening a message marks it read in Gmail, and consuming
       * something we then discard is exactly how a code goes missing.
       *
       * It is NOT the security check: selectCode re-applies the watermark and
       * the allow-list authoritatively on everything returned here.
       *
       * Every drop is LOGGED. An earlier version skipped rows silently, and a
       * row that Gmail had returned simply vanished with no trace - which made
       * "the code never arrived" indistinguishable from "we threw it away".
       */
      if (row.receivedAt === undefined) {
        this.#logger.debug({ messageId: row.id, reason: 'unreadable-date' }, 'Skipping a row');
        continue;
      }
      if (row.receivedAt.getTime() <= request.since.getTime()) {
        this.#logger.debug(
          { messageId: row.id, reason: 'stale', rowAt: row.receivedAt.toISOString() },
          'Skipping a row',
        );
        continue;
      }

      /**
       * EVERY sender must be allow-listed, not just one.
       *
       * A grouped thread holds the carrier's original and the forwarded copy,
       * and both are legitimate. Requiring all of them to pass keeps the
       * control meaningful - a thread carrying one unknown sender is refused -
       * while no longer discarding the ordinary two-sender case.
       */
      if (row.senders.length === 0 || !row.senders.every((from) => isAllowedSender(from, request.matcher))) {
        this.#logger.debug(
          { messageId: row.id, reason: 'sender-not-allowed', senderCount: row.senders.length },
          'Skipping a row',
        );
        continue;
      }

      // Gmail's own preview usually carries the code, which saves opening it.
      this.#rows.set(row.id, row);

      /**
       * Prefer the snippet, and treat a row we cannot open as one bad row -
       * not a failed poll.
       *
       * The code usually arrives TWICE: the carrier's original, whose snippet
       * contains it, and a forwarded copy whose snippet is preamble. Aborting
       * on the forward meant never reaching the original sitting right behind
       * it, so a poll that had the code in hand returned nothing.
       */
      let text: string;
      if (hasDigitRun(row.snippet, request.matcher.codePattern)) {
        text = row.snippet;
      } else {
        try {
          text = await page.readBody(row);
        } catch (cause) {
          this.#logger.debug(
            { messageId: row.id, reason: 'body-unreadable' },
            'Skipping a row whose message could not be opened; trying the next candidate',
          );
          continue;
        }
      }

      messages.push({
        id: row.id,
        // Any of them re-validates in selectCode; they have all passed already.
        from: row.senders[0] ?? '',
        subject: row.subject,
        receivedAt: row.receivedAt,
        text,
      });
    }

    return messages;
  }

  /**
   * Marks the message read - BEST EFFORT, and deliberately so.
   *
   * Two things changed the status of this step:
   *
   *  1. `is:unread` is no longer in the query, because this mailbox's filter
   *     marks mail read on arrival and it hid every code. So being read is not
   *     what makes a code un-reusable - the WATERMARK is, and it is enforced
   *     authoritatively in selectCode. Marking read is now an audit trail a
   *     human can follow.
   *  2. Reading a body OPENS the message, which navigates off the list. A
   *     later attempt to re-locate the row then finds no list at all - and
   *     opening it is itself what clears UNREAD, so the step was both
   *     redundant and, when it threw, fatal to a code already in hand.
   *
   * Throwing here discarded a perfectly good code. It no longer does.
   */
  async consume(id: string): Promise<void> {
    const row = this.#rows.get(id);
    if (row === undefined) {
      this.#logger.debug({ messageId: id }, 'No row to mark read; the code stands on the watermark');
      return;
    }

    try {
      const page = await this.#open();
      await page.markRead(row);
    } catch (cause) {
      this.#logger.warn(
        { messageId: id, err: cause instanceof Error ? cause.message : String(cause) },
        'Could not mark the message read; continuing, since freshness rests on the watermark',
      );
    }
  }

  /** One browser per provider, opened on first use so constructing it is free. */
  async #open(): Promise<GmailUiPage> {
    const existing = this.#page;
    if (existing !== undefined) return existing;

    this.#openInFlight ??= this.#createPage().finally(() => {
      this.#openInFlight = undefined;
    });
    return this.#openInFlight;
  }

  async #createPage(): Promise<GmailUiPage> {
    const factory =
      this.#options.pageFactory ??
      ((): Promise<GmailUiPage> => PlaywrightGmailUiPage.open(this.#options.mode, this.#logger));

    const page = await factory();
    this.#page = page;
    return page;
  }
}

/**
 * Widens a minute-truncated timestamp to the last instant it could represent.
 *
 * Undefined stays undefined: an unparseable date must keep failing closed.
 */
export function lastInstantOfMinute(at: Date | undefined): Date | undefined {
  if (at === undefined) return undefined;
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000 + 59_999);
}

/** Does this text plausibly contain a code, without extracting or logging one? */
function hasDigitRun(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

// ── The browser-backed implementation ────────────────────────────────────────

export class PlaywrightGmailUiPage implements GmailUiPage {
  readonly #page: Page;
  readonly #logger: Logger;
  /** Set only when we launched the browser ourselves and must close it. */
  readonly #owned: { context?: BrowserContext; browser?: Browser };

  private constructor(page: Page, logger: Logger, owned: { context?: BrowserContext; browser?: Browser }) {
    this.#page = page;
    this.#logger = logger;
    this.#owned = owned;
  }

  static async open(mode: GmailUiMode, logger: Logger): Promise<PlaywrightGmailUiPage> {
    // Imported lazily so constructing the provider never starts a browser.
    const { chromium } = await import('playwright');

    if (mode.kind === 'cdp') {
      let browser: Browser;
      try {
        browser = await chromium.connectOverCDP(mode.endpoint);
      } catch (cause) {
        throw new SystemException(
          `Could not attach to Chrome at ${mode.endpoint}, so no MFA code can be read. ${CDP_HINT}`,
          { cause, details: { provider: 'gmail-cdp', endpoint: mode.endpoint } },
        );
      }

      /**
       * Reuse the human's existing context - that is the whole point, since it
       * is the one holding the Google session. A fresh context from this
       * browser would be signed out.
       */
      const context = browser.contexts()[0];
      if (context === undefined) {
        throw new SystemException(
          `Chrome at ${mode.endpoint} exposed no browser context to attach to. ${CDP_HINT}`,
          { details: { provider: 'gmail-cdp', endpoint: mode.endpoint } },
        );
      }

      // A dedicated tab, so the automation never navigates a tab a human is using.
      const page = await context.newPage();
      return new PlaywrightGmailUiPage(page, logger, { browser });
    }

    let context;
    try {
      context = await chromium.launchPersistentContext(mode.userDataDir, {
        headless: mode.headless,
      });
    } catch (cause) {
      /**
       * A persistent profile can only be open in one browser at a time, and
       * Playwright's message for it ("Opening in existing browser session") is
       * not obviously about a lock. This is usually an orphaned browser from a
       * run that aborted before releasing it, so name the fix.
       */
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/already in use|existing browser session/i.test(message)) {
        throw new SystemException(
          `The Gmail profile at ${mode.userDataDir} is already open in another browser, so it ` +
            'cannot be read. That is usually a browser left behind by a run that aborted. Close ' +
            'it, or find it with: pgrep -fl "user-data-dir=' + mode.userDataDir + '"',
          { cause, details: { provider: 'gmail-profile', userDataDir: mode.userDataDir } },
        );
      }
      throw cause;
    }

    const page = context.pages()[0] ?? (await context.newPage());
    return new PlaywrightGmailUiPage(page, logger, { context });
  }

  /**
   * VERIFIED against benefitsoperations@gusto.com on 2026-09-02: the row
   * selector, `span[email]`, `span.bog` and the `title` date all parse real
   * mail correctly. Re-confirm whenever Gmail ships a redesign -
   * `pnpm rpa mfa check --label "<name>" --diagnose` is what settles it.
   *
   * Two measured caveats worth keeping in mind:
   *
   *  - `span.y2` snippets are capped near 200 characters, and the carriers put
   *    the code past that, so the snippet shortcut rarely fires in practice and
   *    most reads open the message.
   *  - Conversation view is ON in that mailbox, so rows are threads. Every
   *    thread observed was single-sender, which keeps attribution valid, and
   *    readBody deliberately takes the LAST message - the newest code.
   *
   * TODO(gmail): a cold Gmail load can render zero rows for a label that has
   * mail. The poll loop covers it by simply looking again, but if a login ever
   * fails with "no code arrived" while the mail is visibly there, this is the
   * first thing to suspect.
   */
  async listLabel(label: string): Promise<readonly GmailRow[]> {
    // Gmail's label fragment encodes a space as '+' and leaves parentheses
    // alone: "#label/Access+Token+(Anthem)". Taken from the live address bar.
    const fragment = `label/${label.split(' ').join('+')}`;

    /**
     * Every poll must be a REAL navigation, and it must land on OUR search.
     *
     * Two problems produced a poll loop that could not see new mail, which is
     * indistinguishable from mail that never arrived:
     *
     *  1. goto() to a URL differing only in its #fragment is a same-document
     *     navigation - the SPA is never re-entered, so the list never refreshes.
     *     A changing query parameter makes it a genuine navigation. Gmail
     *     ignores the parameter itself.
     *  2. reload() sometimes came back on a DIFFERENT view. One poll returned 51
     *     rows where the label holds one thread - almost certainly the inbox.
     *     Parsing that would break the containment this provider is built on.
     *
     * Measured cost of getting this wrong: a code that arrived 26 seconds after
     * it was requested went unseen through 106 polls.
     */
    await this.#page.goto(`${GMAIL_ROOT}?rpa=${Date.now()}#${fragment}`, {
      waitUntil: 'domcontentloaded',
    });

    await this.#assertSignedIn();

    /**
     * Hard containment guard: parse rows ONLY when the view really is our
     * label-scoped search. If Gmail put us somewhere else, report nothing
     * rather than reading whatever happens to be on screen - the poll simply
     * looks again.
     */
    const landedHash = this.#page.url().split('#')[1] ?? '';
    if (!landedHash.startsWith('label/')) {
      this.#logger.warn(
        { landedOn: landedHash.split('/')[0] || '(no fragment)' },
        'Gmail did not land on the label view; reporting no rows rather than reading another view',
      );
      return [];
    }


    /**
     * Wait for either result rows or the empty-results message, so an empty
     * label is fast rather than always costing the full timeout. Whichever
     * appears first wins; a timeout means neither did, and no rows is the
     * fail-closed answer.
     */
    await Promise.race([
      this.#page.locator('tr[data-legacy-thread-id], table[role="grid"] tr.zA').first().waitFor({ timeout: 15_000 }),
      this.#page.getByText(/no messages matched|no conversations/i).first().waitFor({ timeout: 15_000 }),
    ]).catch(() => undefined);

    const rows = await this.#page
      .locator('tr[data-legacy-thread-id], table[role="grid"] tr.zA')
      .evaluateAll((elements) =>
        elements.map((row) => ({
          // Thread id is part of Gmail's data model, unlike its class names.
          domId: row.getAttribute('id') ?? '',
          /**
           * span[email] is an attribute hook, and the most stable thing here.
           * It appears TWICE per row - Gmail renders the sender block in two
           * columns - so collapse to distinct addresses.
           *
           * More than one distinct sender means Gmail grouped a multi-sender
           * thread, and the row can no longer tell us who sent the newest
           * message. Return '' in that case: it fails the allow-list, so the
           * row is rejected rather than attributed to the wrong sender.
           */
          // span[email] renders twice per row (Gmail draws the sender block in
          // two columns), so collapse to distinct addresses.
          senders: (() => {
            const nodes = row.querySelectorAll('span[email]');
            const distinct: string[] = [];
            for (let i = 0; i < nodes.length; i += 1) {
              const value = nodes[i]?.getAttribute('email') ?? '';
              if (value.length > 0 && !distinct.includes(value)) distinct.push(value);
            }
            return distinct;
          })(),
          subject: row.querySelector('span[data-thread-id] span, span.bog')?.textContent ?? '',
          // The title attribute carries a full, unambiguous date; the visible
          // text is relative ("10:32 AM") and needs today's date to interpret.
          dateTitle:
            row.querySelector('span[title][aria-label], td span[title]')?.getAttribute('title') ?? '',
          snippet: row.querySelector('span.y2')?.textContent ?? '',
        })),
      );

    const parsed = rows
      .filter((row) => row.senders.length > 0 || row.domId.length > 0)
      .map((row) => ({
        // Identity from content, so it survives the SPA re-rendering.
        id: `${row.senders[0] ?? 'unknown'}|${row.dateTitle}`,
        dateTitle: row.dateTitle,
        senders: row.senders,
        subject: row.subject.trim(),
        /**
         * Reported as the LAST instant of the minute Gmail names.
         *
         * A row's date reads "6:38 PM" with no seconds, so the true receive
         * time lies anywhere in [19:38:00, 19:38:59]. Handing over the start of
         * that interval makes the watermark reject a code that arrived in the
         * very minute it was requested - exactly what a fast delivery looks
         * like. Handing over the end says what is actually known: this may have
         * arrived after the watermark.
         *
         * The imprecision is declared here, at its source, rather than by
         * loosening the shared comparison in selectCode - which is
         * authoritative and stays exact for the API provider, where
         * internalDate is precise to the millisecond.
         */
        receivedAt: lastInstantOfMinute(parseGmailDate(row.dateTitle)),
        snippet: row.snippet.trim(),
      }));

    this.#logger.debug({ candidates: parsed.length }, 'Listed the MFA label');
    return parsed;
  }

  async readBody(row: GmailRow): Promise<string> {
    await this.#openThread(row);
    // div.a3s is the message body container. Class-based and therefore fragile;
    // Gmail exposes no attribute hook for it.
    const body = this.#page.locator('div.a3s').last();
    return (await body.innerText().catch(() => '')) || '';
  }

  /**
   * Opening a thread is what clears UNREAD in Gmail, so this is mostly a
   * confirmation step. It is still called explicitly because "the code was
   * reused on a retry" is otherwise impossible to explain.
   */
  async markRead(row: GmailRow): Promise<void> {
    /**
     * If no list is on screen we are already inside a message - readBody put us
     * there, and that view is itself what clears UNREAD. Re-opening would be
     * pointless, and hunting for rows that are not displayed is what used to
     * fail here.
     */
    if ((await this.#page.locator('tr.zA').count().catch(() => 0)) === 0) {
      this.#logger.debug({ messageId: row.id }, 'Already in the message view, which clears UNREAD');
      return;
    }

    await this.#openThread(row);
    this.#logger.debug({ messageId: row.id }, 'Opened the message, which clears UNREAD');
  }

  /**
   * Read from the document title, which Gmail renders as
   * "Inbox (3) - someone@example.com - Gmail".
   *
   * TODO(gmail): confirm the title format. It has been stable for years and is
   * far less fragile than the account-button markup, but it is still a string
   * Google owns.
   */
  async signedInAccount(): Promise<string | undefined> {
    return parseAccountFromTitle(await this.#page.title());
  }

  async close(): Promise<void> {
    /**
     * A CDP-attached browser belongs to the human - closing it would shut their
     * Chrome. Close only our own tab and drop the connection.
     */
    if (this.#owned.browser !== undefined) {
      await this.#page.close().catch(() => undefined);
      await this.#owned.browser.close().catch(() => undefined);
      return;
    }
    await this.#owned.context?.close();
  }

  /**
   * Opens a row from the CURRENT list render.
   *
   * Gmail exposes no stable thread id on a row - the observed attributes are
   * class, jscontroller, jsaction, jsmodel, id, tabindex, role, aria-labelledby,
   * draggable and jslog, none of which identify the thread. So `id` here is
   * Gmail's internal DOM id (":44" and the like), which is only meaningful
   * until the list re-renders.
   *
   * That is why there is no URL fallback: navigating to `#all/:44` would be a
   * fabricated address. If the row has gone, this fails and the poll simply
   * looks again - the honest outcome, and one that cannot silently open the
   * wrong message and consume somebody else's code.
   */
  /**
   * Locates a row by its CONTENT and opens it.
   *
   * Gmail exposes no stable thread id, and its DOM ids (":42") are reassigned
   * on every re-render - a reference from one poll was already dead by the time
   * the body was read. Sender and date title come from the row's own data and
   * survive that, so they are what identifies it here.
   */
  async #openThread(row: GmailRow): Promise<void> {
    const sender = row.senders[0] ?? '';
    const bySender =
      sender.length > 0
        ? this.#page.locator('tr.zA').filter({ has: this.#page.locator(`span[email="${sender}"]`) })
        : this.#page.locator('tr.zA');

    /**
     * Narrow by date when that still matches something, and fall back to the
     * sender alone when it does not.
     *
     * Gmail re-renders live, and the date title it draws is not always
     * byte-identical to the one captured a moment earlier. Insisting on both
     * turned an ordinary re-render into a hard failure.
     */
    const byBoth =
      row.dateTitle.length > 0
        ? bySender.filter({ has: this.#page.locator(`span[title="${row.dateTitle}"]`) })
        : bySender;

    const target = (await byBoth.count().catch(() => 0)) > 0 ? byBoth : bySender;

    const first = target.first();
    if (!(await first.isVisible().catch(() => false))) {
      throw new SystemException(
        `The Gmail row for "${row.id}" is no longer in the list, so its message could not be ` +
          'opened. The next poll will list again.',
        { details: { provider: 'gmail-ui', messageId: row.id, reason: 'row-vanished' } },
      );
    }

    await first.click();
    await this.#page.locator('div.a3s').last().waitFor({ timeout: 15_000 }).catch(() => undefined);
  }

  async #assertSignedIn(): Promise<void> {
    const url = this.#page.url();
    if (!/accounts\.google\.com|ServiceLogin|signin\/identifier/i.test(url)) return;

    const hint = this.#owned.browser !== undefined ? CDP_HINT : PROFILE_HINT;
    throw new SystemException(
      'The Gmail session is not signed in, so no MFA code can be read. This provider ' +
        'deliberately does not attempt a Google login - the OTP for it is unavailable to an ' +
        `unattended process. ${hint}`,
      { details: { provider: this.#owned.browser !== undefined ? 'gmail-cdp' : 'gmail-profile' } },
    );
  }
}

/** The account Gmail names in its document title, e.g. "Inbox - a@b.com - Gmail". */
export function parseAccountFromTitle(title: string): string | undefined {
  const match = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(title);
  return match?.[1]?.toLowerCase();
}

/**
 * Parses the full date Gmail puts in a row's `title` attribute.
 *
 * Returns undefined rather than guessing. The caller treats that as stale,
 * which is the safe direction: rejecting a real code costs one retry, while
 * accepting an undated one risks submitting a code the portal has already
 * invalidated - and that presents as a portal fault.
 */
export function parseGmailDate(title: string): Date | undefined {
  if (title.trim().length === 0) return undefined;

  // "Tue, Sep 2, 2026, 4:31 PM" and "2 Sep 2026, 16:31" both parse directly
  // once the weekday-comma noise is normalised.
  const normalized = title.replace(/\bat\b/i, '').replace(/\s+/g, ' ').trim();
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}
