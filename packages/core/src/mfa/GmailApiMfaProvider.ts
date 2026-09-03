import type { Logger } from 'pino';
import type { GmailApiConfig } from '../config/schema.ts';
import { SystemException } from '../errors.ts';
import { computeBackoff, sleep } from '../retry.ts';
import type { SecretResolver } from '../secrets.ts';
import type { MfaCodeProvider, MfaCodeRequest, MfaMatcher } from './MfaCodeProvider.ts';
import { pollForCode, type MfaMailbox, type MfaMessage } from './mailboxPoll.ts';

/**
 * Reads the MFA code through the Gmail REST API. The production target.
 *
 * Bare `fetch`, not `googleapis`: that package is very large for three
 * endpoints, and this repo keeps its dependency surface small on purpose - a
 * transitive native dependency is exactly the arm64 -> amd64 hazard the
 * platform avoids. Token handling deliberately mirrors OrchestratorClient
 * (single-flight acquisition, skew baked in at store time, injected fetch and
 * clock) rather than inventing a second shape for the same problem.
 *
 * Scopes: gmail.readonly, plus gmail.modify - needed only to drop the UNREAD
 * label so a code cannot be consumed twice. Never gmail.delete.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Gmail returns ids only from list, so each candidate costs a second call. Keep the page small. */
const MAX_RESULTS = 10;

export interface GmailApiMfaProviderOptions {
  config: GmailApiConfig;
  /** Resolves clientIdEnv / clientSecretEnv / refreshTokenEnv. Values never come from config. */
  secrets: SecretResolver;
  logger: Logger;
  pollIntervalMs: number;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so token expiry is deterministic. */
  now?: () => number;
  /**
   * Injected in tests alongside `now`. Both or neither: an injected clock that
   * does not advance while the real sleep does would poll forever.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /** The run's stop signal, so a backoff does not hold shutdown open. */
  abortSignal?: AbortSignal;
}

interface TokenState {
  token: string;
  expiresAtMs: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface GmailListResponse {
  messages?: readonly { id?: string }[];
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPart {
  mimeType?: string;
  headers?: readonly GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: readonly GmailPart[];
}

interface GmailMessageResponse {
  id?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

export class GmailApiMfaProvider implements MfaCodeProvider, MfaMailbox {
  readonly name = 'gmail-api';

  readonly #config: GmailApiConfig;
  readonly #secrets: SecretResolver;
  readonly #logger: Logger;
  readonly #pollIntervalMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleepImpl: ((ms: number) => Promise<void>) | undefined;
  readonly #abortSignal: AbortSignal | undefined;

  #token: TokenState | undefined;
  #authInFlight: Promise<TokenState> | undefined;

  constructor(options: GmailApiMfaProviderOptions) {
    this.#config = options.config;
    this.#secrets = options.secrets;
    this.#logger = options.logger.child({ component: 'gmail-api' });
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleepImpl = options.sleepImpl;
    this.#abortSignal = options.abortSignal;
  }

  async waitForCode(request: MfaCodeRequest): Promise<string> {
    return pollForCode(this, request, {
      logger: this.#logger,
      pollIntervalMs: this.#pollIntervalMs,
      now: this.#now,
      ...(this.#sleepImpl === undefined ? {} : { sleepImpl: this.#sleepImpl }),
      ...(this.#abortSignal === undefined ? {} : { abortSignal: this.#abortSignal }),
    });
  }

  async close(): Promise<void> {
    this.#token = undefined;
    this.#authInFlight = undefined;
  }

  // ── MfaMailbox ─────────────────────────────────────────────────────────────

  async search(request: MfaCodeRequest): Promise<readonly MfaMessage[]> {
    const list = await this.#request<GmailListResponse>('GET', '/messages', {
      q: buildQuery(request.matcher, windowDaysFor(request.since, this.#now())),
      maxResults: String(MAX_RESULTS),
    });

    const ids = (list.messages ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => id !== undefined && id.length > 0);

    const messages: MfaMessage[] = [];
    for (const id of ids) {
      const message = await this.#fetchMessage(id);
      if (message !== undefined) messages.push(message);
    }
    return messages;
  }

  async consume(id: string): Promise<void> {
    // Remove UNREAD, nothing else. The label itself stays, so the mail remains
    // auditable by a human afterwards.
    await this.#request<unknown>('POST', `/messages/${id}/modify`, undefined, {
      removeLabelIds: ['UNREAD'],
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  async #fetchMessage(id: string): Promise<MfaMessage | undefined> {
    let raw: GmailMessageResponse;
    try {
      raw = await this.#request<GmailMessageResponse>('GET', `/messages/${id}`, { format: 'full' });
    } catch (cause) {
      /**
       * A message that vanished between list and get is not a failure: the
       * mailbox is shared with a human who may have read or moved it. Skipping
       * it is correct; the poll loop simply keeps waiting.
       */
      if (cause instanceof MessageGone) {
        this.#logger.debug({ messageId: id }, 'Message disappeared between list and get; skipping');
        return undefined;
      }
      throw cause;
    }

    const headers = raw.payload?.headers ?? [];
    const internalDate = Number(raw.internalDate ?? '0');

    return {
      id,
      from: header(headers, 'From') ?? '',
      subject: header(headers, 'Subject') ?? '',
      /**
       * internalDate is the mail server's receive time in epoch milliseconds,
       * which is the right clock for the watermark - the Date header is
       * sender-supplied and therefore not trustworthy for ordering.
       */
      receivedAt: new Date(Number.isFinite(internalDate) ? internalDate : 0),
      text: extractBodyText(raw),
    };
  }

  /** Shared so N concurrent callers on a cold provider produce one token request, not N. */
  async #ensureToken(): Promise<TokenState> {
    const cached = this.#token;
    if (cached !== undefined && cached.expiresAtMs > this.#now()) return cached;

    this.#authInFlight ??= this.#requestToken().finally(() => {
      this.#authInFlight = undefined;
    });

    return this.#authInFlight;
  }

  async #requestToken(): Promise<TokenState> {
    const clientId = await this.#secrets.require(this.#config.clientIdEnv);
    const clientSecret = await this.#secrets.require(this.#config.clientSecretEnv);
    const refreshToken = await this.#secrets.require(this.#config.refreshTokenEnv);

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });

    let response: Response;
    try {
      response = await this.#fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
      });
    } catch (cause) {
      throw new SystemException('Could not reach the Google token endpoint', {
        cause,
        details: { tokenUrl: TOKEN_URL },
      });
    }

    if (!response.ok) {
      const raw = await safeText(response);
      /**
       * Always System, never Business - including the 400 that carries
       * invalid_grant. A revoked or expired refresh token means the
       * environment is wrong, and marking a queue item as a business failure
       * because our mailbox credentials rotted would blame the group for it.
       * A human has to re-consent; see docs/poc/mfa-gmail.md.
       */
      throw new SystemException(
        `Gmail authentication failed: ${response.status} ${response.statusText}` +
          (raw === undefined ? '' : ` - ${redactSecretish(raw)}`),
        { details: { tokenUrl: TOKEN_URL, status: response.status } },
      );
    }

    const payload = (await parseJson<TokenResponse>(response)) ?? {};
    if (payload.access_token === undefined || payload.access_token.length === 0) {
      throw new SystemException('Gmail token response contained no access_token');
    }

    const expiresInMs = (payload.expires_in ?? 3600) * 1000;
    const expiresAtMs = this.#now() + expiresInMs - this.#config.tokenRefreshSkewMs;
    const state: TokenState = { token: payload.access_token, expiresAtMs };
    this.#token = state;

    // The token is never logged, only its lifetime.
    this.#logger.info({ expiresInMs }, 'Authenticated with the Gmail API');
    return state;
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const url = buildUrl(`${API_ROOT}${path}`, query);
    let reauthenticated = false;

    for (let attempt = 1; ; ) {
      const token = await this.#ensureToken();

      let response: Response | undefined;
      let networkError: unknown;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token.token}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
        });
      } catch (cause) {
        networkError = cause;
      }

      /**
       * A 401 on a token we believed was valid means it was revoked or our skew
       * guess was wrong. Re-authenticate and replay once without consuming a
       * retry attempt - but only once, so a genuinely unauthorised client
       * cannot loop.
       */
      if (response?.status === 401 && !reauthenticated) {
        reauthenticated = true;
        this.#token = undefined;
        this.#logger.warn({ method, path }, 'Gmail returned 401; re-authenticating and replaying once');
        continue;
      }

      if (response !== undefined && response.ok) {
        this.#logger.debug({ method, path, status: response.status, attempt }, 'Gmail request succeeded');
        return ((await parseJson<T>(response)) ?? {}) as T;
      }

      const status = response?.status ?? 0;
      if (status === 404) throw new MessageGone();

      const retryable = networkError !== undefined || status === 429 || status >= 500;
      if (!retryable || attempt > this.#config.maxRetries) {
        const raw = response === undefined ? undefined : await safeText(response);
        this.#logger.error({ method, path, status, attempt, retryable }, 'Gmail request failed');
        throw new SystemException(
          `Gmail request failed: ${method} ${path} -> ${status} ${response?.statusText ?? 'network error'}` +
            (raw === undefined ? '' : ` - ${redactSecretish(raw)}`) +
            (status === 403
              ? ' (a 403 here usually means the OAuth client was not granted gmail.readonly and gmail.modify)'
              : ''),
          {
            ...(networkError === undefined ? {} : { cause: networkError }),
            details: { method, path, status, attempt },
          },
        );
      }

      this.#logger.warn({ method, path, status, attempt }, 'Gmail request failed transiently; retrying');
      await sleep(computeBackoff({ baseMs: 500, factor: 2, maxMs: 15_000 }, attempt), this.#abortSignal);
      attempt += 1;
    }
  }
}

/** Internal marker: a message that no longer exists is skipped, not a failure. */
class MessageGone extends Error {
  constructor() {
    super('message not found');
    this.name = 'MessageGone';
  }
}

/**
 * The label-scoped query. `label:` is the containment control, so it is always
 * present and the mailbox is never searched more widely than one label.
 *
 * ── WHY THERE IS NO `from:` TERM ─────────────────────────────────────────────
 * There used to be one, and it was wrong in BOTH directions when measured
 * against the real mailbox:
 *
 *   from:broker.anthem.com     matched every thread in the label, because
 *                              Gmail matches a THREAD when any message in it
 *                              matches - so it filtered nothing.
 *   from:txt.voice.google.com  matched NOTHING, despite two such messages
 *                              sitting in the label.
 *
 * A filter that can silently return zero results is a "the code never arrived"
 * bug waiting to happen, and narrowing server-side buys nothing anyway: the
 * allow-list is enforced in code by isAllowedSender, which is authoritative and
 * cannot be fooled by Gmail's query semantics. So the query stays broad within
 * the label and the code decides what to accept.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function buildQuery(matcher: MfaMatcher, windowDays = 1): string {
  // Gmail accepts the quoted form for a label containing spaces; verified
  // against "Access Token (Anthem)", parentheses included.
  const label = /\s/.test(matcher.label) ? `"${matcher.label}"` : matcher.label;

  const terms = [
    `label:${label}`,
    /**
     * A server-side floor under the watermark, derived from `since` rather than
     * hardcoded.
     *
     * This used to be a fixed `newer_than:1h`, which was a bug: the query was
     * NARROWER than the watermark, so any caller waiting on mail older than an
     * hour saw zero results no matter what `since` said. The floor must never
     * be tighter than the watermark, and deriving it is how that stays true.
     */
    `newer_than:${Math.max(1, Math.ceil(windowDays))}d`,
  ];

  /**
   * ── THERE IS DELIBERATELY NO `is:unread` HERE ────────────────────────────
   * It was here, as the consume-once mechanism: mark a code read on the way
   * out and it can never be picked up again. That rested on an assumption that
   * is false for this mailbox - the Gmail filter that applies the label ALSO
   * marks the mail read, so codes arrive already read and `is:unread` hid every
   * single one. Measured: the label held 21 messages, and 0 of them matched
   * `is:unread`.
   *
   * Freshness is the WATERMARK's job, and always was - `since` is the
   * authoritative check in selectCode and it is enough on its own. Marking read
   * continues, but as an audit trail a human can follow, not as a filter the
   * automation depends on.
   * ─────────────────────────────────────────────────────────────────────────
   */

  if (matcher.subjectContains !== undefined && matcher.subjectContains.length > 0) {
    terms.push(`subject:"${matcher.subjectContains}"`);
  }

  return terms.join(' ');
}

/**
 * How many days of mail the query must cover to include everything the
 * watermark would accept. Always at least one day: Gmail's newer_than has
 * day granularity, so anything finer would round the wrong way and exclude
 * the very message we are waiting for.
 */
export function windowDaysFor(since: Date, nowMs: number): number {
  return Math.max(1, Math.ceil((nowMs - since.getTime()) / 86_400_000));
}

function buildUrl(base: string, query: Record<string, string> | undefined): string {
  if (query === undefined) return base;
  const params = new URLSearchParams(query);
  const search = params.toString();
  if (search.length === 0) return base;
  // '%20' rather than URLSearchParams' '+': the same reason buildUrl in
  // OrchestratorClient does it, and Gmail's `q` is full of spaces.
  return `${base}?${search.replace(/\+/g, '%20')}`;
}

function header(headers: readonly GmailHeader[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find((h) => h.name?.toLowerCase() === wanted)?.value;
}

/**
 * Pulls readable text out of a Gmail payload.
 *
 * TODO(gmail): confirm the part layout carriers actually send. text/plain is
 * preferred, a tag-stripped text/html is the fallback, and `snippet` is the
 * last resort - which is enough for a six-digit code even when the body is a
 * single image, but has only been tested against synthetic fixtures.
 */
function extractBodyText(message: GmailMessageResponse): string {
  const payload = message.payload;
  if (payload !== undefined) {
    const plain = findPart(payload, 'text/plain');
    if (plain !== undefined) return plain;

    const html = findPart(payload, 'text/html');
    if (html !== undefined) return stripTags(html);
  }
  return message.snippet ?? '';
}

function findPart(part: GmailPart, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && part.body?.data !== undefined) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== undefined) return found;
  }
  return undefined;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');
}

async function parseJson<T>(response: Response): Promise<T | undefined> {
  if (response.status === 204) return undefined;
  const text = await safeText(response);
  if (text === undefined || text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new SystemException('Gmail returned a non-JSON response body', {
      cause,
      details: { status: response.status },
    });
  }
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/** Error bodies can echo the request. Strip anything secret-shaped before it reaches a message. */
function redactSecretish(raw: string): string {
  return raw
    .replace(/("?(client_secret|refresh_token|access_token|id_token)"?\s*[:=]\s*")[^"]*(")/gi, '$1[REDACTED]$3')
    .replace(/((client_secret|refresh_token|access_token|id_token)=)[^&\s]*/gi, '$1[REDACTED]')
    .slice(0, 400);
}

/** Public alias: the one definition of "the MFA mail", shared by both providers. */
export const buildMfaQuery = buildQuery;
