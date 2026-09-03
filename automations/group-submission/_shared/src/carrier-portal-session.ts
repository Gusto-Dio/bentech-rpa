import { mkdir, readFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import {
  BusinessException,
  SystemException,
  step,
  type Logger,
  type MfaCodeProvider,
  type MfaMatcher,
  type SecretResolver,
} from '@rpa/core';
import type { BrowserContext, Page } from 'playwright';

/**
 * Signing in to a carrier portal that requires MFA, and not doing it more often
 * than necessary.
 *
 * Why session reuse is not an optimisation here: MFA is rate-limited by the
 * carrier and gated on a human's mailbox. An automation that re-authenticates
 * on every transaction will get throttled, and will burn a code per group. So
 * the flow is:
 *
 *   1. If a stored storageState exists, load it and probe whether it still works.
 *   2. If the probe passes, we are done - no login, no MFA, no code consumed.
 *   3. Otherwise sign in, satisfy MFA, and persist the new storageState.
 *
 * The probe matters more than it looks. "Cookies exist" is not "we are signed
 * in": carrier sessions expire server-side while the cookie is still present, so
 * the probe must load a page that only a signed-in user can see.
 */

/**
 * The carrier-specific half of a login, injected.
 *
 * ── WHY THIS IS INJECTED RATHER THAN WRITTEN HERE ────────────────────────────
 * The probe and the password/MFA steps need selectors, and selectors belong in
 * an automation's own src/pages/ (CLAUDE.md rule 5). Two carriers' login forms
 * hardcoded into this shared file would also mean every Anthem selector change
 * touching the file UHC depends on. So this file owns the ORDER of operations -
 * which is the part that is easy to get wrong and identical for both carriers -
 * and each PoC owns what its portal looks like.
 *
 * The split between enterCredentials and submitCredentials is not cosmetic: the
 * MFA watermark is set between them. See #signIn.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface CarrierLoginFlow {
  /**
   * Loads a page only a signed-in user can see and reports whether we are on
   * it. Must navigate itself rather than trusting the current page, and must
   * not check for cookies - that is the failure this whole file exists to
   * avoid.
   */
  probeSignedIn(page: Page): Promise<boolean>;

  /** Fills username and password. MUST NOT submit. */
  enterCredentials(page: Page, username: string, password: string): Promise<void>;

  /** Submits the credential form. */
  submitCredentials(page: Page): Promise<void>;

  /**
   * Triggers delivery of the code, and NOTHING else.
   *
   * The MFA watermark is set immediately before this call, so it must be the
   * single action that causes the mail to be sent. Anthem's Okta needs an
   * explicit "Email me a code" click - the code is not sent on password
   * submit - which is precisely why this is its own step: putting the
   * watermark before the password submit would set it too early and let a
   * stale code count as new.
   *
   * A no-op where the portal sends the code automatically.
   */
  /**
   * Is a one-time code actually going to be asked for?
   *
   * Okta does not always challenge. With a remembered device it hands straight
   * back to the portal after the password, and the code screen never renders -
   * observed on Anthem 2026-09-03, where the run died waiting 15s for an
   * "Email me a code" button on a page that had already navigated to the
   * dashboard. Treating that as a failure both wastes the successful login and
   * misreports a healthy sign-in as broken.
   *
   * Omit it and MFA is assumed to be required, which is the safe default: the
   * worst case is waiting for a code that does arrive.
   */
  isMfaRequired?(page: Page): Promise<boolean>;

  requestMfaCode(page: Page): Promise<void>;

  /**
   * Asks the portal to send ANOTHER code, for when the first never arrived.
   *
   * Optional: omit it and the session waits out `mfaTimeoutMs` on a single
   * code. Implement it wherever the portal offers a "Resend" control, because
   * a code that expires in transit cannot be salvaged by waiting longer - the
   * only way out is a fresh one.
   *
   * The watermark is reset immediately before each call, so like
   * requestMfaCode this must do nothing except trigger a new send.
   */
  resendMfaCode?(page: Page): Promise<void>;

  /** Enters the code and submits it. */
  enterMfaCode(page: Page, code: string): Promise<void>;

  /** Waits for the signed-in landmark. Throws or times out if sign-in did not complete. */
  waitForSignedIn(page: Page): Promise<void>;

  /**
   * The portal's own visible error text, or undefined when there is none.
   *
   * Returned rather than thrown so this file can classify it - the portal's
   * wording is what decides Business vs System, and that decision must be made
   * in one place for both carriers.
   */
  readError(page: Page): Promise<string | undefined>;
}

export interface CarrierPortalSessionOptions {
  /** Used for the storageState filename and for log fields. */
  carrier: 'anthem-ca' | 'uhc';
  loginUrl: string;

  /** NAMES of the credential variables; values come from secrets. */
  usernameEnv: string;
  passwordEnv: string;
  secrets: SecretResolver;

  mfa: MfaCodeProvider;
  /** Label, sender allow-list and code pattern for THIS carrier. */
  mfaMatcher: MfaMatcher;
  /** Total budget for obtaining a code, across every resend attempt. */
  mfaTimeoutMs: number;

  /**
   * How long to wait for one code before resending, when the flow supports it.
   *
   * Defaults to the whole budget, i.e. no resend. Set it BELOW the carrier's
   * expiry countdown: waiting past expiry for a code that is already in flight
   * gains nothing, because it will be rejected on arrival.
   */
  mfaResendAfterMs?: number;
  /** How many extra codes to request. 0 disables resending. */
  mfaMaxResends?: number;

  /**
   * Absolute path for the persisted storageState, e.g.
   * <repoRoot>/data/sessions/anthem-ca.json.
   *
   * CREDENTIAL-EQUIVALENT: this file holds live portal cookies. Gitignored, and
   * never copied off the machine.
   */
  storageStatePath: string;

  /** What this carrier's login page looks like. See CarrierLoginFlow. */
  login: CarrierLoginFlow;

  /** Required by step(), and by the sign-in log line. Never receives a secret. */
  logger: Logger;
}

export interface CarrierPortalSession {
  /**
   * Ensures `page` is signed in, reusing a stored session when it still works.
   * Must be idempotent - the runner calls initialize() again after every
   * session recovery.
   */
  ensureSignedIn(page: Page, context: BrowserContext): Promise<SignInOutcome>;

  /** Persists the current cookies so the next run can skip MFA. */
  saveSession(context: BrowserContext): Promise<void>;

  /** Discards the stored session, forcing a full login next time. */
  clearSession(): Promise<void>;
}

export interface SignInOutcome {
  /** 'reused' means no MFA code was consumed. */
  how: 'reused' | 'password-and-mfa';
  /** Whether a stored session was found at all, regardless of whether it worked. */
  hadStoredSession: boolean;
}

/** Playwright's own shape, so a version bump cannot silently desync a hand-written copy. */
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
type CookieList = Parameters<BrowserContext['addCookies']>[0];

/** Password entry, MFA wait and the landmark all fit inside the MFA timeout plus this. */
const LOGIN_HEADROOM_MS = 90_000;

export function createCarrierPortalSession(
  options: CarrierPortalSessionOptions,
): CarrierPortalSession {
  return new CarrierPortalSessionImpl(options);
}

class CarrierPortalSessionImpl implements CarrierPortalSession {
  readonly #options: CarrierPortalSessionOptions;
  readonly #logger: Logger;

  constructor(options: CarrierPortalSessionOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'carrier-session', carrier: options.carrier });
  }

  /**
   * Deliberately stateless: it probes every time rather than remembering that
   * it signed in.
   *
   * After a session recovery the BrowserContext is a brand-new browser with no
   * cookies, so a cached "we are signed in" flag would be a lie exactly when it
   * matters most - the first retry would run against a signed-out portal and
   * fail for a different reason than the original error. This is what makes it
   * idempotent under CLAUDE.md rule 7.
   */
  async ensureSignedIn(page: Page, context: BrowserContext): Promise<SignInOutcome> {
    const stored = await readStoredState(this.#options.storageStatePath, this.#logger);
    const hadStoredSession = stored !== undefined;
    if (stored !== undefined) await applyStoredState(context, stored);

    /**
     * step() checks the postcondition BEFORE the action, so with the probe as
     * the postcondition the skip path *is* the session-reuse path: outcome
     * 'skipped' means a stored session still works and no code was consumed.
     *
     * A probe that throws is coerced to false by step(), which is the reading
     * we want - a locator error on the way to a signed-in page means "sign in
     * again", not "crash the run".
     */
    const result = await step<void>(
      { logger: this.#logger },
      {
        name: `carrier-login:${this.#options.carrier}`,
        // With no stored cookies we already know the answer, so do not pay for
        // a navigation to find out.
        alwaysRun: !hadStoredSession,
        postcondition: () => this.#options.login.probeSignedIn(page),
        action: () => this.#signIn(page),
        timeoutMs: this.#options.mfaTimeoutMs + LOGIN_HEADROOM_MS,
      },
    );

    const how: SignInOutcome['how'] = result.outcome === 'skipped' ? 'reused' : 'password-and-mfa';

    /**
     * Persist only after the postcondition confirmed we are signed in.
     * Saving inside the action would happily write a half-authenticated state
     * over a good one.
     */
    if (how === 'password-and-mfa') await this.saveSession(context);

    this.#logger.info({ how, hadStoredSession }, 'Carrier portal session ready');
    return { how, hadStoredSession };
  }

  async #signIn(page: Page): Promise<void> {
    // MFA options are consumed by #obtainCode, not here.
    const { login, secrets, usernameEnv, passwordEnv, loginUrl } = this.#options;

    const username = await secrets.require(usernameEnv);
    const password = await secrets.require(passwordEnv);

    // Never inherit whatever the previous transaction left on screen (rule 8).
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await login.enterCredentials(page, username, password);

    await login.submitCredentials(page);

    // A rejected password surfaces here, before any code is requested at all.
    await this.#failOnPortalError(page, 'credentials');

    /**
     * ── THE WATERMARK ────────────────────────────────────────────────────────
     * Immediately before the one action that causes the mail, and not a moment
     * earlier. Set it after and we race the email our own click causes. Set it
     * earlier - before the password submit, say, which is where it used to be -
     * and the seconds spent entering and verifying a password become a window
     * in which a previous attempt's code still counts as new. A retry then
     * submits a code the portal already invalidated, which presents as a
     * portal fault and is not one.
     *
     * It also sits AFTER the password check, so a rejected credential never
     * requests a code.
     * ─────────────────────────────────────────────────────────────────────────
     */
    const mfaRequired = login.isMfaRequired === undefined ? true : await login.isMfaRequired(page);

    if (mfaRequired) {
      const code = await this.#obtainCode(page);

      // The code is never logged, passed to a log field, or put in an exception.
      await login.enterMfaCode(page, code);
      await this.#failOnPortalError(page, 'mfa');
    } else {
      /**
       * Worth a log line at info: whether a code was spent is the one thing
       * anyone debugging this flow wants to know, and "no challenge" looks
       * identical to "reused session" in every other respect.
       */
      this.#options.logger.info(
        { carrier: this.#options.carrier },
        'The portal did not challenge for a one-time code; no MFA code was consumed',
      );
    }

    try {
      await login.waitForSignedIn(page);
    } catch (cause) {
      throw new SystemException(
        `Signed in to the ${this.#options.carrier} portal but never reached the signed-in landmark`,
        { cause, details: { carrier: this.#options.carrier, stage: 'landmark' } },
      );
    }
  }

  /**
   * Requests a code and waits for it, resending if the flow allows it.
   *
   * Why resend rather than simply wait longer: Anthem's code carries an expiry
   * countdown, and its mail reaches us through a forward whose latency was
   * measured between ~132s and over 600s. Past the countdown the code is dead
   * on arrival, so a bigger timeout just fails more slowly. Asking for a fresh
   * one is the only recovery, and it is exactly what a human does.
   */
  async #obtainCode(page: Page): Promise<string> {
    const { login, mfa, mfaMatcher, mfaTimeoutMs } = this.#options;
    const maxResends = login.resendMfaCode === undefined ? 0 : (this.#options.mfaMaxResends ?? 0);
    const perAttemptMs = Math.min(this.#options.mfaResendAfterMs ?? mfaTimeoutMs, mfaTimeoutMs);

    const deadline = Date.now() + mfaTimeoutMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxResends; attempt += 1) {
      // Never overrun the total budget, however many resends are configured.
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      /**
       * The watermark is reset for EVERY attempt, immediately before the send.
       * Without that, a resend would happily accept the first code - which is
       * the one we already know is too old to use.
       */
      const since = new Date();
      if (attempt === 0) {
        await login.requestMfaCode(page);
      } else {
        /**
         * If the resend control itself cannot be used, report BOTH facts. The
         * first version of this threw only the click failure, which buried the
         * reason we were resending at all and left error.json unable to explain
         * the run.
         */
        try {
          await login.resendMfaCode?.(page);
        } catch (resendFailure) {
          throw new SystemException(
            `No MFA code arrived for the ${this.#options.carrier} portal, and the portal's ` +
              'resend control could not be used either',
            {
              cause: resendFailure,
              details: {
                carrier: this.#options.carrier,
                attempt: attempt + 1,
                originalFailure: lastError instanceof Error ? lastError.message : undefined,
              },
            },
          );
        }
      }

      // A throttle or lockout message appears here, and waiting out the whole
      // budget before noticing it would waste minutes per attempt.
      await this.#failOnPortalError(page, 'mfa-request');

      try {
        return await mfa.waitForCode({
          since,
          timeoutMs: Math.min(perAttemptMs, remainingMs),
          matcher: mfaMatcher,
          purpose: `${this.#options.carrier} portal login`,
        });
      } catch (thrown) {
        // A BusinessException means a human must intervene; resending would
        // only make it worse.
        if (thrown instanceof BusinessException) throw thrown;

        /**
         * Resend ONLY when the code genuinely failed to arrive. Anything else -
         * a signed-out mailbox, a browser that died, a Gmail redesign - is a
         * real fault, and treating it as "the mail was late" would request
         * more codes while hiding the actual cause. The first version of this
         * loop resent on any error and masked exactly that.
         */
        if (!isCodeTimeout(thrown)) throw thrown;
        lastError = thrown;

        if (attempt < maxResends) {
          this.#logger.warn(
            { attempt: attempt + 1, resendsLeft: maxResends - attempt },
            'No MFA code arrived in time; asking the portal to resend',
          );
        }
      }
    }

    throw lastError ?? new SystemException('No MFA code could be obtained');
  }

  async #failOnPortalError(page: Page, stage: 'credentials' | 'mfa-request' | 'mfa'): Promise<void> {
    const message = await this.#options.login.readError(page).catch(() => undefined);
    if (message === undefined || message.trim().length === 0) return;

    /**
     * On the code-entry screen the portal also renders HELPFUL text in an alert
     * region - Anthem explains which sender to expect - so treating any alert
     * as a failure there would break every login. At that stage only
     * problem-shaped wording counts, and anything unrecognised is left alone:
     * a missed error costs one timeout, while a false positive costs every run.
     */
    if (stage === 'mfa-request' && !PROBLEM_WORDING.test(message)) {
      this.#logger.debug('Informational message on the code screen; not treating it as a failure');
      return;
    }

    throw classifyPortalError(message.trim(), { carrier: this.#options.carrier, stage });
  }

  async saveSession(context: BrowserContext): Promise<void> {
    const file = this.#options.storageStatePath;
    await mkdir(path.dirname(file), { recursive: true });
    await context.storageState({ path: file });

    // Owner-only. The file is live portal cookies; on a shared machine the
    // default 0644 would hand the carrier account to every local account.
    await chmod(file, 0o600).catch(() => undefined);

    // The path, never the contents.
    this.#logger.debug({ file }, 'Persisted the carrier portal session');
  }

  async clearSession(): Promise<void> {
    await rm(this.#options.storageStatePath, { force: true });
    this.#logger.info('Discarded the stored carrier portal session');
  }
}

/**
 * Business vs System for a failed sign-in.
 *
 * The rule is the one from CLAUDE.md: would running this again, on a fresh
 * browser, plausibly give a different answer?
 *
 *   Lockout / too many attempts -> NO, and retrying actively makes it worse by
 *     driving the counter further up. A human has to intervene, so Business.
 *   Everything else, including a rejected password -> the environment is wrong,
 *     not the group. A bad credential is a System fault; failing the queue item
 *     for it would blame the group for our misconfiguration, and would mark
 *     every remaining item the same way.
 */
/** True only for "the code never arrived", not for a mailbox that could not be read. */
function isCodeTimeout(error: unknown): boolean {
  return error instanceof SystemException && error.details['reason'] === 'timeout';
}

/** Wording that marks an alert as a real failure rather than guidance. */
const PROBLEM_WORDING =
  /unable|invalid|incorrect|too many|locked|lockout|suspended|disabled|expired|failed|denied|not recognized|try again/i;

export function classifyPortalError(
  message: string,
  context: { carrier: string; stage: 'credentials' | 'mfa-request' | 'mfa' },
): BusinessException | SystemException {
  const details = { ...context, portalMessage: message };

  const lockedOut = [
    /too many (?:failed |unsuccessful )?(?:sign-?in |login )?attempts/i,
    /locked\s*out|account\s+(?:is\s+)?locked|lockout/i,
    /temporarily\s+(?:disabled|blocked|suspended)/i,
    /account\s+(?:is\s+)?(?:suspended|deactivated)/i,
  ].some((pattern) => pattern.test(message));

  if (lockedOut) {
    return new BusinessException(
      `The ${context.carrier} portal account is locked or throttled: ${message}`,
      { details },
    );
  }

  return new SystemException(`${context.carrier} portal sign-in failed: ${message}`, { details });
}

/** Missing is normal - the first run has no session. Unreadable is a warning, not a failure. */
async function readStoredState(file: string, logger: Logger): Promise<StorageState | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isStorageState(parsed)) throw new Error('not a storageState document');
    return parsed;
  } catch (cause) {
    /**
     * Treated as "no session" rather than fatal: the worst case is one extra
     * login, and a corrupt file would otherwise wedge every run until someone
     * deleted it by hand. The path is logged; the contents never are.
     */
    logger.warn({ file, err: cause }, 'Stored session file is unreadable; signing in from scratch');
    return undefined;
  }
}

function isStorageState(value: unknown): value is StorageState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { cookies?: unknown; origins?: unknown };
  return Array.isArray(candidate.cookies) && Array.isArray(candidate.origins);
}

/**
 * Loads a stored session into a context that already exists.
 *
 * BrowserSession creates the context before initialize() runs and Playwright
 * cannot retro-fit a storageState into a live context, so this is
 * addCookies plus an init script rather than newContext({ storageState }).
 */
async function applyStoredState(context: BrowserContext, state: StorageState): Promise<void> {
  if (state.cookies.length > 0) await context.addCookies(state.cookies as CookieList);

  for (const origin of state.origins) {
    if (origin.localStorage.length === 0) continue;

    /**
     * Passed as source text, not a function: this package is typechecked with
     * lib ES2023, so `localStorage` and `location` do not exist as far as tsc
     * is concerned.
     *
     * Only absent keys are seeded, so a value the portal has already refreshed
     * in this context is never overwritten with the stale one from disk.
     */
    await context.addInitScript({
      content:
        `(() => { try {` +
        `if (location.origin !== ${JSON.stringify(origin.origin)}) return;` +
        `for (const e of ${JSON.stringify(origin.localStorage)}) {` +
        `if (localStorage.getItem(e.name) === null) localStorage.setItem(e.name, e.value);` +
        `}} catch (_) { /* a sandboxed origin may deny storage; the probe will catch it */ } })();`,
    });
  }
}
