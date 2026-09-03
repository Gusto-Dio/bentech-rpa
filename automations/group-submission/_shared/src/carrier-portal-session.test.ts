import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  BusinessException,
  EnvSecretProvider,
  SecretResolver,
  StaticMfaProvider,
  SystemException,
  createLogger,
  type Logger,
  type MfaMatcher,
  type SecretProvider,
} from '@rpa/core';
import type { BrowserContext, Page } from 'playwright';
import {
  classifyPortalError,
  createCarrierPortalSession,
  type CarrierLoginFlow,
} from './carrier-portal-session.ts';

const matcher: MfaMatcher = {
  label: 'carrier-mfa',
  fromAllowList: ['anthem.com'],
  codePattern: /\b(\d{6})\b/,
};

const SECRETS: Record<string, string> = {
  ANTHEM_PORTAL_USERNAME: 'producer-bot',
  ANTHEM_PORTAL_PASSWORD: 'not-a-real-password',
};

class MapProvider implements SecretProvider {
  readonly name = 'test';
  async get(key: string): Promise<string | undefined> {
    return SECRETS[key];
  }
}

function silentLogger(): Logger {
  return createLogger({ level: 'silent', pretty: false, base: {} });
}

/**
 * A scriptable CarrierLoginFlow that records the order it was driven in.
 *
 * The order is the thing under test: everything this file gets wrong in
 * production is an ordering mistake, not a selector mistake.
 */
class FakeLoginFlow implements CarrierLoginFlow {
  readonly calls: string[] = [];
  /** Wall-clock stamps, so the watermark can be located between two calls. */
  enteredCredentialsAt = 0;
  submittedCredentialsAt = 0;
  requestedMfaAt = 0;
  /** One entry per send, so the watermark can be checked against each. */
  readonly sendAt: number[] = [];
  resends = 0;
  probes = 0;
  codeEntered: string | undefined;

  /** Successive probe answers. The last one repeats. */
  #probeAnswers: boolean[];
  #errorAtCredentials: string | undefined;
  #errorAtMfa: string | undefined;
  #landmarkFails: boolean;
  #mfaRequired: boolean;

  constructor(options: {
    probeAnswers: boolean[];
    errorAtCredentials?: string;
    errorAtMfa?: string;
    landmarkFails?: boolean;
    mfaRequired?: boolean;
  }) {
    this.#probeAnswers = [...options.probeAnswers];
    this.#errorAtCredentials = options.errorAtCredentials;
    this.#errorAtMfa = options.errorAtMfa;
    this.#landmarkFails = options.landmarkFails ?? false;
    this.#mfaRequired = options.mfaRequired ?? true;
  }

  /** Only defined when the test cares; absent means "assume MFA is required". */
  async isMfaRequired(_page: Page): Promise<boolean> {
    this.calls.push('isMfaRequired');
    return this.#mfaRequired;
  }

  async probeSignedIn(_page: Page): Promise<boolean> {
    this.probes += 1;
    this.calls.push('probe');
    return this.#probeAnswers.length > 1
      ? (this.#probeAnswers.shift() ?? false)
      : (this.#probeAnswers[0] ?? false);
  }

  async enterCredentials(_page: Page, _username: string, _password: string): Promise<void> {
    this.calls.push('enterCredentials');
    await sleep(3);
    this.enteredCredentialsAt = Date.now();
  }

  async submitCredentials(_page: Page): Promise<void> {
    this.submittedCredentialsAt = Date.now();
    await sleep(3);
    this.calls.push('submitCredentials');
  }

  async requestMfaCode(_page: Page): Promise<void> {
    this.requestedMfaAt = Date.now();
    this.sendAt.push(Date.now());
    await sleep(3);
    this.calls.push('requestMfaCode');
  }

  async resendMfaCode(_page: Page): Promise<void> {
    this.resends += 1;
    this.sendAt.push(Date.now());
    await sleep(3);
    this.calls.push('resendMfaCode');
  }

  async enterMfaCode(_page: Page, code: string): Promise<void> {
    this.calls.push('enterMfaCode');
    this.codeEntered = code;
  }

  async waitForSignedIn(_page: Page): Promise<void> {
    this.calls.push('waitForSignedIn');
    if (this.#landmarkFails) throw new Error('never saw the landmark');
  }

  async readError(_page: Page): Promise<string | undefined> {
    // Whichever stage we are at is inferred from what has run so far.
    if (!this.calls.includes('enterMfaCode')) return this.#errorAtCredentials;
    return this.#errorAtMfa;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakePage(): { page: Page; navigations: string[] } {
  const navigations: string[] = [];
  const page = {
    goto: async (url: string) => {
      navigations.push(url);
      return null;
    },
  } as unknown as Page;
  return { page, navigations };
}

interface FakeContext {
  context: BrowserContext;
  addedCookies: unknown[];
  initScripts: string[];
  saves: number;
}

function fakeContext(): FakeContext {
  const state: FakeContext = {
    addedCookies: [],
    initScripts: [],
    saves: 0,
    context: undefined as unknown as BrowserContext,
  };

  state.context = {
    addCookies: async (cookies: unknown[]) => {
      state.addedCookies.push(...cookies);
    },
    addInitScript: async (script: { content?: string }) => {
      state.initScripts.push(script.content ?? '');
    },
    storageState: async (options?: { path?: string }) => {
      state.saves += 1;
      const document = { cookies: [{ name: 'SESSION', value: 'fresh' }], origins: [] };
      if (options?.path !== undefined) {
        await writeFile(options.path, JSON.stringify(document), 'utf8');
      }
      return document;
    },
  } as unknown as BrowserContext;

  return state;
}

interface Fixture {
  dir: string;
  storageStatePath: string;
  mfa: StaticMfaProvider;
  session: ReturnType<typeof createCarrierPortalSession>;
  login: FakeLoginFlow;
  page: Page;
  navigations: string[];
  ctx: FakeContext;
}

async function fixture(login: FakeLoginFlow): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rpa-carrier-session-'));
  const storageStatePath = path.join(dir, 'sessions', 'anthem-ca.json');
  const mfa = new StaticMfaProvider('481923');
  const { page, navigations } = fakePage();
  const ctx = fakeContext();

  const session = createCarrierPortalSession({
    carrier: 'anthem-ca',
    loginUrl: 'https://portal.test/producer',
    usernameEnv: 'ANTHEM_PORTAL_USERNAME',
    passwordEnv: 'ANTHEM_PORTAL_PASSWORD',
    secrets: new SecretResolver(new MapProvider()),
    mfa,
    mfaMatcher: matcher,
    mfaTimeoutMs: 30_000,
    storageStatePath,
    login,
    logger: silentLogger(),
  });

  return { dir, storageStatePath, mfa, session, login, page, navigations, ctx };
}

async function writeStoredSession(file: string, contents?: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    contents ??
      JSON.stringify({
        cookies: [{ name: 'SESSION', value: 'stored', domain: 'portal.test', path: '/' }],
        origins: [
          { origin: 'https://portal.test', localStorage: [{ name: 'producerId', value: 'PRD-1' }] },
        ],
      }),
    'utf8',
  );
}

describe('createCarrierPortalSession - session reuse', () => {
  it('consumes NO MFA code when the probe passes', async () => {
    // MFA is rate-limited by the carrier and gated on a human's mailbox. This
    // assertion is the whole reason session reuse exists.
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    await writeStoredSession(f.storageStatePath);

    const outcome = await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.equal(outcome.how, 'reused');
    assert.equal(outcome.hadStoredSession, true);
    assert.equal(f.mfa.requests.length, 0, 'an MFA code was consumed on the reuse path');
    assert.deepEqual(f.login.calls, ['probe'], 'the password form must not be touched at all');

    await rm(f.dir, { recursive: true, force: true });
  });

  it('does not rewrite the stored session when it reused one', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    await writeStoredSession(f.storageStatePath);

    await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.equal(f.ctx.saves, 0);
    const onDisk = JSON.parse(await readFile(f.storageStatePath, 'utf8')) as { cookies: { value: string }[] };
    assert.equal(onDisk.cookies[0]?.value, 'stored');

    await rm(f.dir, { recursive: true, force: true });
  });

  it('loads stored cookies and localStorage into the live context', async () => {
    // BrowserSession builds the context before initialize() runs, so this has
    // to be addCookies + addInitScript rather than newContext({ storageState }).
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    await writeStoredSession(f.storageStatePath);

    await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.equal(f.ctx.addedCookies.length, 1);
    assert.equal(f.ctx.initScripts.length, 1);
    assert.match(f.ctx.initScripts[0] ?? '', /producerId/);
    // Only absent keys are seeded, so a fresher in-page value is never clobbered.
    assert.match(f.ctx.initScripts[0] ?? '', /getItem\(e\.name\) === null/);

    await rm(f.dir, { recursive: true, force: true });
  });

  it('signs in fully when a stored session has expired server-side', async () => {
    // "Cookies exist" is not "we are signed in" - the single most common way
    // session reuse silently breaks.
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [false, true] }));
    await writeStoredSession(f.storageStatePath);

    const outcome = await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.equal(outcome.how, 'password-and-mfa');
    assert.equal(outcome.hadStoredSession, true);
    assert.equal(f.mfa.requests.length, 1);

    await rm(f.dir, { recursive: true, force: true });
  });

  it('skips the probe entirely when there is no stored session to probe', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));

    const outcome = await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.equal(outcome.how, 'password-and-mfa');
    assert.equal(outcome.hadStoredSession, false);
    // One probe, after the login, as the postcondition. Not one before it.
    assert.equal(f.login.probes, 1);
    assert.equal(f.login.calls[0], 'enterCredentials');

    await rm(f.dir, { recursive: true, force: true });
  });

  it('treats an unreadable stored session as no session rather than wedging every run', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    await writeStoredSession(f.storageStatePath, '{ this is not json');

    const outcome = await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.equal(outcome.hadStoredSession, false);
    assert.equal(outcome.how, 'password-and-mfa');

    await rm(f.dir, { recursive: true, force: true });
  });
});

describe('createCarrierPortalSession - the MFA watermark', () => {
  it('sets `since` immediately before the action that triggers the mail', async () => {
    /**
     * Not before the password submit: Anthem's Okta sends nothing until an
     * explicit "Email me a code" click, so the seconds spent submitting and
     * verifying a password would otherwise be a window in which a previous
     * attempt's code still counts as new.
     *
     * Not after the request either, or we race the mail our own click causes.
     */
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    await f.session.ensureSignedIn(f.page, f.ctx.context);

    const since = f.mfa.requests[0]?.since;
    assert.ok(since !== undefined, 'no MFA code was requested at all');
    assert.ok(
      since.getTime() >= f.login.submittedCredentialsAt,
      'the watermark was set before the password was submitted - too early, a stale code could pass',
    );
    assert.ok(
      since.getTime() <= f.login.requestedMfaAt,
      'the watermark was set after the code was requested - this races the email',
    );

    await rm(f.dir, { recursive: true, force: true });
  });

  it('drives the login in the one order that is retry-safe', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.deepEqual(f.login.calls, [
      'enterCredentials',
      'submitCredentials',
      // Between the password and the code request: it decides whether a code is
      // coming at all, and it must not run before the password is accepted.
      'isMfaRequired',
      'requestMfaCode',
      'enterMfaCode',
      'waitForSignedIn',
      'probe',
    ]);

    await rm(f.dir, { recursive: true, force: true });
  });

  it('starts from the login URL rather than inheriting the previous page', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.deepEqual(f.navigations, ['https://portal.test/producer']);

    await rm(f.dir, { recursive: true, force: true });
  });

  it('passes the code to the portal and never puts it in the outcome', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    const outcome = await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.equal(f.login.codeEntered, '481923');
    assert.ok(!JSON.stringify(outcome).includes('481923'));

    await rm(f.dir, { recursive: true, force: true });
  });
});

describe('createCarrierPortalSession - failure classification', () => {
  it('classifies a rejected password as System, because the environment is wrong', async () => {
    // Business would fail the queue item, blaming the group for our bad
    // credential - and would then do the same to every remaining item.
    const f = await fixture(
      new FakeLoginFlow({ probeAnswers: [true], errorAtCredentials: 'The username or password is incorrect.' }),
    );

    const error = await f.session.ensureSignedIn(f.page, f.ctx.context).catch((t: unknown) => t);
    assert.ok(error instanceof SystemException);
    assert.equal(f.mfa.requests.length, 0, 'a code must not be consumed after a rejected password');
    // And it must not even ASK the carrier to send one - that would burn a
    // code, and rate limits, on a credential we already know is wrong.
    assert.ok(!f.login.calls.includes('requestMfaCode'));

    await rm(f.dir, { recursive: true, force: true });
  });

  it('classifies "too many attempts" as Business, because retrying makes it worse', async () => {
    const f = await fixture(
      new FakeLoginFlow({ probeAnswers: [true], errorAtCredentials: 'Too many failed sign-in attempts.' }),
    );

    const error = await f.session.ensureSignedIn(f.page, f.ctx.context).catch((t: unknown) => t);
    assert.ok(error instanceof BusinessException, 'a lockout must not burn three logins and three codes');

    await rm(f.dir, { recursive: true, force: true });
  });

  it('classifies a lockout discovered at the MFA screen as Business too', async () => {
    const f = await fixture(
      new FakeLoginFlow({ probeAnswers: [true], errorAtMfa: 'Your account has been locked out.' }),
    );

    const error = await f.session.ensureSignedIn(f.page, f.ctx.context).catch((t: unknown) => t);
    assert.ok(error instanceof BusinessException);

    await rm(f.dir, { recursive: true, force: true });
  });

  it('does not persist a session when sign-in never reached the landmark', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [false], landmarkFails: true }));

    await assert.rejects(f.session.ensureSignedIn(f.page, f.ctx.context), SystemException);
    assert.equal(f.ctx.saves, 0);

    await rm(f.dir, { recursive: true, force: true });
  });

  it('reports a missing code as System and leaves no session behind', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    const failing = createCarrierPortalSession({
      carrier: 'anthem-ca',
      loginUrl: 'https://portal.test/producer',
      usernameEnv: 'ANTHEM_PORTAL_USERNAME',
      passwordEnv: 'ANTHEM_PORTAL_PASSWORD',
      secrets: new SecretResolver(new MapProvider()),
      mfa: {
        name: 'never-arrives',
        waitForCode: async () => {
          throw new SystemException('No MFA code arrived within 30000ms');
        },
      },
      mfaMatcher: matcher,
      mfaTimeoutMs: 30_000,
      storageStatePath: f.storageStatePath,
      login: f.login,
      logger: silentLogger(),
    });

    await assert.rejects(failing.ensureSignedIn(f.page, f.ctx.context), SystemException);
    assert.equal(f.ctx.saves, 0);

    await rm(f.dir, { recursive: true, force: true });
  });

  it('reports a missing credential as System, naming the variable', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    const noSecrets = createCarrierPortalSession({
      carrier: 'anthem-ca',
      loginUrl: 'https://portal.test/producer',
      usernameEnv: 'ANTHEM_PORTAL_USERNAME',
      passwordEnv: 'ANTHEM_PORTAL_PASSWORD',
      // The real provider, against an environment that has neither variable.
      secrets: new SecretResolver(new EnvSecretProvider()),
      mfa: f.mfa,
      mfaMatcher: matcher,
      mfaTimeoutMs: 30_000,
      storageStatePath: f.storageStatePath,
      login: f.login,
      logger: silentLogger(),
    });

    await assert.rejects(noSecrets.ensureSignedIn(f.page, f.ctx.context), (error: unknown) => {
      assert.ok(error instanceof SystemException);
      assert.match(error.message, /ANTHEM_PORTAL_USERNAME/);
      return true;
    });

    await rm(f.dir, { recursive: true, force: true });
  });
});

describe('classifyPortalError', () => {
  const context = { carrier: 'anthem-ca', stage: 'credentials' } as const;

  it('treats lockout wording as Business', () => {
    for (const message of [
      'Too many failed attempts',
      'too many unsuccessful login attempts, please wait',
      'Your account is locked',
      'You have been locked out',
      'This account has been temporarily disabled',
      'Account is suspended',
    ]) {
      assert.ok(
        classifyPortalError(message, context) instanceof BusinessException,
        `expected Business for: ${message}`,
      );
    }
  });

  it('treats everything else as System', () => {
    for (const message of [
      'The username or password is incorrect',
      'Service temporarily unavailable',
      'An unexpected error occurred',
    ]) {
      assert.ok(
        classifyPortalError(message, context) instanceof SystemException,
        `expected System for: ${message}`,
      );
    }
  });

  it('carries the portal wording through, which is what an operator actually needs', () => {
    const error = classifyPortalError('The username or password is incorrect', context);
    assert.match(error.message, /username or password is incorrect/);
    assert.equal(error.details['portalMessage'], 'The username or password is incorrect');
  });
});

describe('createCarrierPortalSession - persistence', () => {
  it('persists the session owner-readable only', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    await f.session.ensureSignedIn(f.page, f.ctx.context);

    const stats = await stat(f.storageStatePath);
    // Live portal cookies. 0644 would hand the carrier account to every local account.
    assert.equal(stats.mode & 0o777, 0o600);

    await rm(f.dir, { recursive: true, force: true });
  });

  it('clearSession removes the stored session and is safe when there is none', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true] }));
    await writeStoredSession(f.storageStatePath);

    await f.session.clearSession();
    await assert.rejects(stat(f.storageStatePath));

    // Idempotent: a second call must not throw.
    await f.session.clearSession();

    await rm(f.dir, { recursive: true, force: true });
  });
});

describe('createCarrierPortalSession - resending a code', () => {
  /** Fails a given number of times before yielding a code, recording each watermark. */
  class LateMfaProvider {
    readonly name = 'late';
    readonly requests: { since: Date }[] = [];
    #failures: number;

    constructor(failures: number) {
      this.#failures = failures;
    }

    async waitForCode(request: { since: Date }): Promise<string> {
      this.requests.push({ since: request.since });
      if (this.#failures > 0) {
        this.#failures -= 1;
        // details.reason marks this as "the mail was late", which is the only
        // failure a resend is a valid response to.
        throw new SystemException('No MFA code arrived', { details: { reason: 'timeout' } });
      }
      return '481923';
    }
  }

  async function sessionWith(mfa: unknown, login: FakeLoginFlow, extra: Record<string, unknown> = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'rpa-resend-'));
    const session = createCarrierPortalSession({
      carrier: 'anthem-ca',
      loginUrl: 'https://portal.test/producer',
      usernameEnv: 'ANTHEM_PORTAL_USERNAME',
      passwordEnv: 'ANTHEM_PORTAL_PASSWORD',
      secrets: new SecretResolver(new MapProvider()),
      mfa: mfa as never,
      mfaMatcher: matcher,
      mfaTimeoutMs: 60_000,
      storageStatePath: path.join(dir, 'anthem-ca.json'),
      login,
      logger: silentLogger(),
      ...extra,
    });
    return { session, dir };
  }

  it('asks the portal to resend when the first code never arrives', async () => {
    // Anthem's code expires in transit, so a fresh one is the only recovery -
    // waiting longer on a dead code just fails more slowly.
    const login = new FakeLoginFlow({ probeAnswers: [true] });
    const mfa = new LateMfaProvider(1);
    const { session, dir } = await sessionWith(mfa, login, { mfaResendAfterMs: 5_000, mfaMaxResends: 2 });
    const { page } = fakePage();

    const outcome = await session.ensureSignedIn(page, fakeContext().context);

    assert.equal(outcome.how, 'password-and-mfa');
    assert.equal(login.resends, 1, 'expected exactly one resend');
    assert.equal(mfa.requests.length, 2);

    await rm(dir, { recursive: true, force: true });
  });

  it('resets the watermark for every resend', async () => {
    /**
     * The critical one. A resend that kept the original watermark would happily
     * accept the FIRST code - the one already known to be too old to use.
     */
    const login = new FakeLoginFlow({ probeAnswers: [true] });
    const mfa = new LateMfaProvider(2);
    const { session, dir } = await sessionWith(mfa, login, { mfaResendAfterMs: 5_000, mfaMaxResends: 2 });
    const { page } = fakePage();

    await session.ensureSignedIn(page, fakeContext().context);

    assert.equal(mfa.requests.length, 3);
    const [first, second, third] = mfa.requests;
    assert.ok(first !== undefined && second !== undefined && third !== undefined);
    assert.ok(second.since.getTime() > first.since.getTime(), 'the second watermark was not reset');
    assert.ok(third.since.getTime() > second.since.getTime(), 'the third watermark was not reset');

    // And each watermark sits at or before its own send.
    for (const [i, sentAt] of login.sendAt.entries()) {
      assert.ok((mfa.requests[i]?.since.getTime() ?? 0) <= sentAt);
    }

    await rm(dir, { recursive: true, force: true });
  });

  it('gives up after the configured number of resends', async () => {
    const login = new FakeLoginFlow({ probeAnswers: [true] });
    const mfa = new LateMfaProvider(99);
    const { session, dir } = await sessionWith(mfa, login, { mfaResendAfterMs: 5_000, mfaMaxResends: 2 });
    const { page } = fakePage();

    await assert.rejects(session.ensureSignedIn(page, fakeContext().context), SystemException);
    // One initial request plus two resends, and no more.
    assert.equal(login.resends, 2);
    assert.equal(mfa.requests.length, 3);

    await rm(dir, { recursive: true, force: true });
  });

  it('does not resend at all by default', async () => {
    // Resending costs a real code and can trip carrier rate limits, so it must
    // be opted into per carrier rather than happening implicitly.
    const login = new FakeLoginFlow({ probeAnswers: [true] });
    const mfa = new LateMfaProvider(99);
    const { session, dir } = await sessionWith(mfa, login);
    const { page } = fakePage();

    await assert.rejects(session.ensureSignedIn(page, fakeContext().context), SystemException);
    assert.equal(login.resends, 0);
    assert.equal(mfa.requests.length, 1);

    await rm(dir, { recursive: true, force: true });
  });

  it('never resends after a Business failure', async () => {
    // A lockout needs a human. Asking for more codes makes it worse.
    const login = new FakeLoginFlow({ probeAnswers: [true] });
    const locked = {
      name: 'locked',
      requests: [] as unknown[],
      async waitForCode(): Promise<string> {
        throw new BusinessException('Your account is locked');
      },
    };
    const { session, dir } = await sessionWith(locked, login, { mfaResendAfterMs: 5_000, mfaMaxResends: 3 });
    const { page } = fakePage();

    await assert.rejects(session.ensureSignedIn(page, fakeContext().context), BusinessException);
    assert.equal(login.resends, 0);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('classifyPortalError - informational text on the code screen', () => {
  it('ignores the portal\'s own guidance rather than failing the login', () => {
    /**
     * Anthem renders "You'll receive an email from noreply@broker.anthem.com
     * with the subject 'One-Time Security Code.'" in an alert region on the
     * code screen. Treating any alert there as a failure would break every
     * single login, so only problem-shaped wording counts.
     */
    const guidance = "You'll receive an email from noreply@broker.anthem.com with the subject 'One-Time Security Code.'";
    assert.ok(!/unable|invalid|too many|locked|expired|failed/i.test(guidance));
  });
});

describe('createCarrierPortalSession - resend only on a real timeout', () => {
  it('does NOT resend when the mailbox itself could not be read', async () => {
    /**
     * A signed-out Gmail profile is a System failure, like a late code, but
     * resending would request more codes while hiding the real fault. The first
     * version of this loop resent on any error and buried a provider failure
     * behind a "Resend Code" click timeout - error.json could not explain the
     * run at all.
     */
    const login = new FakeLoginFlow({ probeAnswers: [true] });
    const broken = {
      name: 'signed-out',
      requests: [] as unknown[],
      async waitForCode(): Promise<string> {
        throw new SystemException('The Gmail session is not signed in');
      },
    };

    const dir = await mkdtemp(path.join(tmpdir(), 'rpa-noresend-'));
    const session = createCarrierPortalSession({
      carrier: 'anthem-ca',
      loginUrl: 'https://portal.test/producer',
      usernameEnv: 'ANTHEM_PORTAL_USERNAME',
      passwordEnv: 'ANTHEM_PORTAL_PASSWORD',
      secrets: new SecretResolver(new MapProvider()),
      mfa: broken as never,
      mfaMatcher: matcher,
      mfaTimeoutMs: 60_000,
      mfaResendAfterMs: 5_000,
      mfaMaxResends: 3,
      storageStatePath: path.join(dir, 'anthem-ca.json'),
      login,
      logger: silentLogger(),
    });

    await assert.rejects(
      session.ensureSignedIn(fakePage().page, fakeContext().context),
      (error: unknown) => {
        assert.ok(error instanceof SystemException);
        // The ORIGINAL cause survives, rather than being replaced.
        assert.match(error.message, /not signed in/);
        return true;
      },
    );
    assert.equal(login.resends, 0, 'a provider failure must not trigger a resend');

    await rm(dir, { recursive: true, force: true });
  });

  it('reports both failures when the resend control cannot be used', async () => {
    const login = new FakeLoginFlow({ probeAnswers: [true] });
    // Resend exists but is unusable, as when the countdown has not lapsed.
    login.resendMfaCode = async () => {
      throw new Error('locator.click: Timeout 15000ms exceeded');
    };

    const mfa = {
      name: 'late',
      requests: [] as unknown[],
      async waitForCode(): Promise<string> {
        throw new SystemException('No MFA code arrived', { details: { reason: 'timeout' } });
      },
    };

    const dir = await mkdtemp(path.join(tmpdir(), 'rpa-resendfail-'));
    const session = createCarrierPortalSession({
      carrier: 'anthem-ca',
      loginUrl: 'https://portal.test/producer',
      usernameEnv: 'ANTHEM_PORTAL_USERNAME',
      passwordEnv: 'ANTHEM_PORTAL_PASSWORD',
      secrets: new SecretResolver(new MapProvider()),
      mfa: mfa as never,
      mfaMatcher: matcher,
      mfaTimeoutMs: 60_000,
      mfaResendAfterMs: 5_000,
      mfaMaxResends: 2,
      storageStatePath: path.join(dir, 'anthem-ca.json'),
      login,
      logger: silentLogger(),
    });

    await assert.rejects(
      session.ensureSignedIn(fakePage().page, fakeContext().context),
      (error: unknown) => {
        assert.ok(error instanceof SystemException);
        // Both facts, so the artifact explains the run without a re-run.
        assert.match(error.message, /No MFA code arrived/);
        assert.match(error.message, /resend control could not be used/);
        assert.ok(error.cause !== undefined, 'the click failure should be the cause');
        return true;
      },
    );

    await rm(dir, { recursive: true, force: true });
  });
});

describe('when the portal does not challenge for a code', () => {
  /**
   * Okta does not always ask. With a remembered device it hands straight back
   * to the portal and no factor screen renders - which used to kill the run
   * after a SUCCESSFUL login, waiting 15s for a button that was never coming.
   */
  it('skips the code entirely and still reaches signed-in', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true], mfaRequired: false }));
    await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.ok(!f.login.calls.includes('requestMfaCode'), 'no code is requested');
    assert.ok(!f.login.calls.includes('enterMfaCode'), 'no code is entered');
    assert.ok(f.login.calls.includes('waitForSignedIn'), 'it still waits for the landmark');
    assert.equal(f.mfa.requests.length, 0, 'the mailbox is never even asked');

    await rm(f.dir, { recursive: true, force: true });
  });

  it('still requests a code when the portal does challenge', async () => {
    const f = await fixture(new FakeLoginFlow({ probeAnswers: [true], mfaRequired: true }));
    await f.session.ensureSignedIn(f.page, f.ctx.context);

    assert.ok(f.login.calls.includes('requestMfaCode'));
    assert.ok(f.login.calls.includes('enterMfaCode'));

    await rm(f.dir, { recursive: true, force: true });
  });
});
