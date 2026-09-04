import { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import type { ImapConfig } from '../config/schema.ts';
import { SystemException } from '../errors.ts';
import type { SecretResolver } from '../secrets.ts';
import type { MfaCodeProvider, MfaCodeRequest } from './MfaCodeProvider.ts';
import { pollForCode, type MfaMailbox, type MfaMessage } from './mailboxPoll.ts';
import { extractTextFromRfc822 } from './mimeText.ts';

/**
 * Reads the MFA code over IMAP.
 *
 * ── WHY THIS EXISTS, GIVEN THE DOCS SAID NOT TO ──────────────────────────────
 * `docs/poc/mfa-gmail.md` rejected IMAP, and it was right about the reason: an
 * IMAP credential is long-lived and can `SELECT` any folder, so its blast radius
 * is the WHOLE mailbox rather than one label - which matters more, not less,
 * when the mailbox is a shared Benefits Operations one carrying customer
 * correspondence.
 *
 * It is here anyway, deliberately and as an INTERIM measure, because the
 * alternatives were blocking the PoCs: `gmail-profile` and `gmail-cdp` drive
 * Gmail's own JS UI, which needs a display, cannot run on the Linux runtime, and
 * cost this project a string of failures written up in the Anthem drift log -
 * cached SPA lists, minute-precision dates, row ids reassigned on re-render, and
 * a basic HTML view Google retired in 2024. `gmail-api` is the production
 * answer and remains unvalidated against a real mailbox.
 *
 * So: this unblocks, `gmail-api` is still the target, and the trade-off is
 * recorded rather than reversed quietly. See docs/poc/mfa-gmail.md.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── WHAT THIS PROVIDER DOES NOT DO ──────────────────────────────────────────
 * It opens exactly ONE mailbox: `request.matcher.label`. It never selects
 * INBOX, never `[Gmail]/All Mail`, and never issues a mailbox-wide search. The
 * credential cannot be scoped to a label, so the CODE is what keeps the
 * containment control the design intends, and a test pins it.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * The slice of an IMAP client this provider uses.
 *
 * Declared here rather than importing `imapflow`'s types so the provider can be
 * tested against a fake with no network and no server - the same reason
 * `GmailApiMfaProvider` takes an injected `fetch`.
 */
export interface ImapSession {
  connect(): Promise<void>;
  /** Throws when the mailbox does not exist - which is how a mistyped label fails loudly. */
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<unknown>;
  fetch(
    range: unknown,
    query: { envelope?: boolean; internalDate?: boolean; source?: boolean; uid?: boolean },
    options?: { uid?: boolean },
  ): AsyncIterable<ImapFetchedMessage>;
  messageFlagsAdd(range: unknown, flags: readonly string[], options?: { uid?: boolean }): Promise<boolean>;
  logout(): Promise<void>;
}

export interface ImapFetchedMessage {
  uid?: number;
  internalDate?: Date;
  source?: Buffer | Uint8Array | string;
  envelope?: {
    subject?: string;
    date?: Date;
    from?: readonly { name?: string; address?: string }[];
  };
}

export interface ImapMfaProviderOptions {
  config: ImapConfig;
  /** Resolves userEnv and passwordEnv / accessTokenEnv. Values never come from config. */
  secrets: SecretResolver;
  logger: Logger;
  pollIntervalMs: number;
  /** Injected in tests. Defaults to a real ImapFlow session. */
  createSession?: (credentials: ImapCredentials, config: ImapConfig) => ImapSession;
  abortSignal?: AbortSignal;
}

export interface ImapCredentials {
  user: string;
  /** Exactly one of these. Google removed plain-password IMAP, so `pass` means an APP password. */
  pass?: string;
  accessToken?: string;
}

/**
 * How far back to ask the server for mail.
 *
 * IMAP's `SINCE` takes a DATE, not a timestamp - there is no way to say "since
 * 14:32:05" in the protocol. So this is only a coarse server-side floor, and
 * the authoritative freshness check stays where it already was: `selectCode`
 * comparing `receivedAt` against `request.since`. `receivedAt` comes from
 * INTERNALDATE, which has real second precision - so IMAP actually FIXES the
 * minute-precision problem that made the Gmail UI reject codes arriving in the
 * same minute they were requested.
 */
function sinceDate(since: Date): Date {
  const floor = new Date(since);
  floor.setUTCDate(floor.getUTCDate() - 1);
  return floor;
}

export class ImapMfaProvider implements MfaCodeProvider, MfaMailbox {
  readonly name = 'imap';

  readonly #config: ImapConfig;
  readonly #secrets: SecretResolver;
  readonly #logger: Logger;
  readonly #pollIntervalMs: number;
  readonly #createSession: (credentials: ImapCredentials, config: ImapConfig) => ImapSession;
  readonly #abortSignal: AbortSignal | undefined;

  #session: ImapSession | undefined;
  /** Which mailbox the live session has open, so it is not reopened per poll. */
  #openLabel: string | undefined;

  constructor(options: ImapMfaProviderOptions) {
    this.#config = options.config;
    this.#secrets = options.secrets;
    this.#logger = options.logger;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#createSession = options.createSession ?? defaultCreateSession;
    this.#abortSignal = options.abortSignal;
  }

  async waitForCode(request: MfaCodeRequest): Promise<string> {
    return pollForCode(this, request, {
      logger: this.#logger,
      pollIntervalMs: this.#pollIntervalMs,
      ...(this.#abortSignal === undefined ? {} : { abortSignal: this.#abortSignal }),
    });
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    this.#openLabel = undefined;
    // Best-effort: a failed logout must not fail a run that already has its code.
    await session?.logout().catch(() => undefined);
  }

  // ── MfaMailbox ─────────────────────────────────────────────────────────────

  async search(request: MfaCodeRequest): Promise<readonly MfaMessage[]> {
    const session = await this.#open(request.matcher.label);

    const messages: MfaMessage[] = [];
    for await (const message of session.fetch(
      { since: sinceDate(request.since) },
      { uid: true, envelope: true, internalDate: true, source: true },
    )) {
      const mapped = toMfaMessage(message);
      if (mapped !== undefined) messages.push(mapped);
    }

    // Newest first, as MfaMailbox.search promises: selectCode takes the first
    // acceptable candidate, and the freshest is the one the portal is expecting.
    messages.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

    this.#logger.debug(
      { candidates: messages.length, label: request.matcher.label },
      'Listed candidates in the MFA label over IMAP',
    );

    return messages;
  }

  /**
   * Marks the message `\Seen`, and never deletes.
   *
   * ── BEST-EFFORT ON PURPOSE ──────────────────────────────────────────────────
   * The consume-once guarantee does NOT rest on this flag - it rests on the
   * `since` watermark, enforced authoritatively in `selectCode`. This mailbox's
   * own filter marks mail read on arrival anyway, which is why `is:unread`
   * matched 0 of 21 labelled messages and hid every code.
   *
   * So throwing here would discard a code that is already in hand and force
   * another request against a carrier that throttles them. Every guard added to
   * this layer "for safety" that was not one of the watermark, the sender
   * allow-list or label scoping has turned a recoverable situation into a lost
   * code.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async consume(id: string): Promise<void> {
    const session = this.#session;
    if (session === undefined) return;

    const uid = Number(id);
    if (!Number.isInteger(uid)) return;

    try {
      await session.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
    } catch (cause) {
      this.#logger.warn(
        { messageId: id, err: cause },
        'Could not mark the MFA message read; the watermark still prevents reuse',
      );
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  async #open(label: string): Promise<ImapSession> {
    if (this.#session !== undefined && this.#openLabel === label) return this.#session;

    if (this.#session === undefined) {
      const credentials = await this.#credentials();
      const session = this.#createSession(credentials, this.#config);
      try {
        await session.connect();
      } catch (cause) {
        /**
         * Almost always one of three things, and worth saying so: Google
         * removed plain-password IMAP, so a mailbox password fails here; app
         * passwords need 2-Step Verification on the account; and a Workspace
         * admin can disable IMAP for the whole org.
         */
        throw new SystemException(
          `Could not connect to IMAP at ${this.#config.host}:${this.#config.port}. Check that IMAP is ` +
            'enabled for the account, and that the credential is an app password or an OAuth access ' +
            'token - Google no longer accepts a plain mailbox password.',
          { cause, details: { host: this.#config.host, port: this.#config.port } },
        );
      }
      this.#session = session;
    }

    /**
     * The containment control. ONLY the configured label is ever opened - never
     * INBOX, never `[Gmail]/All Mail`, and never a mailbox-wide search. A
     * mistyped label throws here instead of silently widening to everything.
     */
    try {
      await this.#session.mailboxOpen(label, { readOnly: false });
    } catch (cause) {
      throw new SystemException(
        `IMAP mailbox "${label}" could not be opened. In Gmail a label IS the mailbox path, so this ` +
          'must match the label exactly, including spaces and parentheses.',
        { cause, details: { label } },
      );
    }

    this.#openLabel = label;
    return this.#session;
  }

  async #credentials(): Promise<ImapCredentials> {
    const user = await this.#secrets.require(this.#config.userEnv);

    if (this.#config.accessTokenEnv !== undefined) {
      return { user, accessToken: await this.#secrets.require(this.#config.accessTokenEnv) };
    }
    if (this.#config.passwordEnv !== undefined) {
      return { user, pass: await this.#secrets.require(this.#config.passwordEnv) };
    }

    throw new SystemException(
      'IMAP is configured with neither passwordEnv nor accessTokenEnv, so there is no way to ' +
        'authenticate. Set exactly one.',
    );
  }
}

function toMfaMessage(message: ImapFetchedMessage): MfaMessage | undefined {
  if (message.uid === undefined) return undefined;

  /**
   * INTERNALDATE, not the `Date:` header. INTERNALDATE is when the SERVER
   * received the mail, which is what the watermark means and what a sender
   * cannot influence; the Date header is written by the sender.
   */
  const receivedAt = message.internalDate ?? message.envelope?.date;
  if (receivedAt === undefined) return undefined;

  const sender = message.envelope?.from?.[0];
  const from =
    sender?.name !== undefined && sender.name !== ''
      ? `${sender.name} <${sender.address ?? ''}>`
      : (sender?.address ?? '');

  const source = message.source;
  const raw =
    source === undefined
      ? ''
      : typeof source === 'string'
        ? source
        : Buffer.from(source).toString('utf8');

  return {
    id: String(message.uid),
    from,
    subject: message.envelope?.subject ?? '',
    receivedAt,
    // NEVER logged. selectCode extracts the code from this and logs neither.
    text: extractTextFromRfc822(raw),
  };
}

/**
 * The real session.
 *
 * Cast through `unknown` because `ImapSession` is deliberately a narrow slice of
 * imapflow's surface - declared locally so this provider can be tested against a
 * fake, which is the whole reason `createSession` is injectable.
 */
function defaultCreateSession(credentials: ImapCredentials, config: ImapConfig): ImapSession {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: credentials,
    /**
     * imapflow logs message metadata at debug level through its own pino
     * instance, which does not carry this repo's REDACT_PATHS. Off, rather than
     * risk a subject, a body or a code reaching a log sink by a route the
     * platform does not control.
     */
    logger: false,
    emitLogs: false,
  }) as unknown as ImapSession;
}
