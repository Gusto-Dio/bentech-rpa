import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GmailApiConfig } from '../config/schema.ts';
import { SystemException } from '../errors.ts';
import { createLogger } from '../logger.ts';
import { createFetchMock, type MockResponseSpec, type RecordedCall } from '../orchestrator/testFetch.ts';
import { SecretResolver, type SecretProvider } from '../secrets.ts';
import { GmailApiMfaProvider, buildQuery, windowDaysFor } from './GmailApiMfaProvider.ts';
import type { MfaCodeRequest, MfaMatcher } from './MfaCodeProvider.ts';

const SECRETS: Record<string, string> = {
  GMAIL_CLIENT_ID: 'gmail-client-abc',
  GMAIL_CLIENT_SECRET: 'super-secret-client-value',
  GMAIL_REFRESH_TOKEN: 'super-secret-refresh-token',
};

class MapProvider implements SecretProvider {
  readonly name = 'test';
  async get(key: string): Promise<string | undefined> {
    return SECRETS[key];
  }
}

const CONFIG: GmailApiConfig = {
  clientIdEnv: 'GMAIL_CLIENT_ID',
  clientSecretEnv: 'GMAIL_CLIENT_SECRET',
  refreshTokenEnv: 'GMAIL_REFRESH_TOKEN',
  requestTimeoutMs: 5_000,
  maxRetries: 2,
  tokenRefreshSkewMs: 60_000,
};

const matcher: MfaMatcher = {
  label: 'carrier-mfa',
  fromAllowList: ['anthem.com'],
  codePattern: /\b(\d{6})\b/,
};

const SINCE = new Date('2026-09-02T10:00:00.000Z');
const CODE = '481923';
const ACCESS_TOKEN = 'super-secret-access-token';

function request(overrides: Partial<MfaCodeRequest> = {}): MfaCodeRequest {
  return { since: SINCE, timeoutMs: 30_000, matcher, purpose: 'anthem-ca portal login', ...overrides };
}

function gmailMessage(overrides: {
  id?: string;
  from?: string;
  subject?: string;
  receivedMs?: number;
  body?: string;
} = {}): unknown {
  const body = overrides.body ?? `Your verification code is ${CODE}.`;
  return {
    id: overrides.id ?? 'msg-1',
    internalDate: String(overrides.receivedMs ?? SINCE.getTime() + 1_000),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: overrides.from ?? 'Anthem <no-reply@anthem.com>' },
        { name: 'Subject', value: overrides.subject ?? 'Your verification code' },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } }],
    },
  };
}

const TOKEN_OK: MockResponseSpec = { body: { access_token: ACCESS_TOKEN, expires_in: 3600 } };

interface Harness {
  provider: GmailApiMfaProvider;
  mock: ReturnType<typeof createFetchMock>;
  logLines: string[];
  setNow: (value: number) => void;
}

/** Dispatches on URL rather than call index, so a changed call order does not silently pass. */
function harness(
  route: (call: RecordedCall) => MockResponseSpec,
  config: Partial<GmailApiConfig> = {},
): Harness {
  const mock = createFetchMock(route);
  const logLines: string[] = [];
  let now = SINCE.getTime();

  const logger = createLogger({ level: 'trace', pretty: false, base: {} });
  const captured = logger.child({});
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    (captured as unknown as Record<string, unknown>)[level] = (...args: unknown[]): void => {
      logLines.push(JSON.stringify(args));
    };
  }
  (captured as unknown as Record<string, unknown>)['child'] = (): unknown => captured;

  const provider = new GmailApiMfaProvider({
    config: { ...CONFIG, ...config },
    secrets: new SecretResolver(new MapProvider()),
    logger: captured,
    pollIntervalMs: 1_000,
    fetchImpl: mock.fetchImpl,
    now: () => now,
    // Advances the injected clock instead of really waiting, so a timeout test
    // costs microseconds.
    sleepImpl: async (ms: number) => {
      now += ms;
    },
  });

  return { provider, mock, logLines, setNow: (v: number) => { now = v; } };
}

/** The happy path: token, one message in the label, get it, modify it. */
function happyRoute(message: unknown = gmailMessage()): (call: RecordedCall) => MockResponseSpec {
  return (call) => {
    if (call.url.includes('oauth2.googleapis.com/token')) return TOKEN_OK;
    if (call.url.includes('/messages/') && call.url.includes('/modify')) return { body: {} };
    if (/\/messages\/[^?]+/.test(new URL(call.url).pathname)) return { body: message };
    return { body: { messages: [{ id: 'msg-1' }] } };
  };
}

const tokenCalls = (mock: Harness['mock']): RecordedCall[] =>
  mock.calls.filter((c) => c.url.includes('oauth2.googleapis.com/token'));

describe('GmailApiMfaProvider - the label-scoped query', () => {
  it('never widens past the configured label', () => {
    const q = buildQuery(matcher);
    assert.match(q, /label:carrier-mfa/);
    // No is:unread: this mailbox's filter marks mail read on arrival, so it
    // hid every code. The watermark is what enforces freshness.
    assert.ok(!q.includes('is:unread'));
    assert.match(q, /newer_than:1d/);
  });

  it('never makes the query window narrower than the watermark', () => {
    /**
     * This was a real bug: a hardcoded `newer_than:1h` meant a caller waiting
     * on mail older than an hour got zero results no matter what `since` said.
     * Measured against the live mailbox, a 30-day watermark returned nothing.
     */
    const since = new Date('2026-08-03T00:00:00.000Z');
    const now = new Date('2026-09-02T00:00:00.000Z').getTime();
    assert.equal(windowDaysFor(since, now), 30);
    assert.match(buildQuery(matcher, windowDaysFor(since, now)), /newer_than:30d/);
  });

  it('floors the window at one day, because Gmail only has day granularity', () => {
    const since = new Date('2026-09-02T00:00:00.000Z');
    const now = since.getTime() + 5_000;
    assert.equal(windowDaysFor(since, now), 1);
  });

  it('does NOT narrow by sender, because Gmail\'s from: term proved unreliable', () => {
    /**
     * Measured against the real mailbox, from: matched every thread for one
     * sender and nothing at all for another. Silently returning zero results
     * would present as "the code never arrived". isAllowedSender enforces the
     * allow-list in code instead, where Gmail's query semantics cannot break it.
     */
    const q = buildQuery({ ...matcher, fromAllowList: ['anthem.com', 'uhc.com'] });
    assert.ok(!q.includes('from:'), 'a from: term can silently match nothing');
  });

  it('quotes a label containing spaces', () => {
    assert.match(buildQuery({ ...matcher, label: 'carrier mfa' }), /label:"carrier mfa"/);
  });

  it('adds subjectContains when the matcher narrows by subject', () => {
    assert.match(buildQuery({ ...matcher, subjectContains: 'verification' }), /subject:"verification"/);
  });

  it('sends spaces as %20, not +, so the q parameter survives the server', async () => {
    const h = harness(happyRoute());
    await h.provider.waitForCode(request());

    const list = h.mock.calls.find((c) => c.url.includes('/messages?'));
    assert.ok(list !== undefined);
    assert.ok(list.url.includes('%20'), 'expected %20-encoded spaces in the query');
    assert.ok(!list.url.includes('+'), 'a + in the query string can be read literally by the server');
  });
});

describe('GmailApiMfaProvider - reading a code', () => {
  it('returns the code and removes UNREAD so it cannot be reused', async () => {
    const h = harness(happyRoute());
    const code = await h.provider.waitForCode(request());

    assert.equal(code, CODE);

    const modify = h.mock.calls.find((c) => c.url.includes('/modify'));
    assert.ok(modify !== undefined, 'the message was never marked read');
    assert.equal(modify.method, 'POST');
    assert.deepEqual(JSON.parse(modify.body ?? '{}'), { removeLabelIds: ['UNREAD'] });
  });

  it('rejects a code that arrived before the watermark', async () => {
    const stale = gmailMessage({ receivedMs: SINCE.getTime() - 60_000 });
    const h = harness(happyRoute(stale));

    await assert.rejects(h.provider.waitForCode(request({ timeoutMs: 2_000 })), SystemException);
    assert.equal(h.mock.calls.filter((c) => c.url.includes('/modify')).length, 0);
  });

  it('rejects a code from a sender outside the allow-list', async () => {
    const spoofed = gmailMessage({ from: 'no-reply@anthem-security.example', body: 'code 000000' });
    const h = harness(happyRoute(spoofed));

    await assert.rejects(h.provider.waitForCode(request({ timeoutMs: 2_000 })), SystemException);
    assert.equal(h.mock.calls.filter((c) => c.url.includes('/modify')).length, 0);
  });

  it('falls back to a tag-stripped HTML part when there is no text/plain', async () => {
    const htmlOnly = {
      id: 'msg-1',
      internalDate: String(SINCE.getTime() + 1_000),
      payload: {
        mimeType: 'text/html',
        headers: [{ name: 'From', value: 'no-reply@anthem.com' }],
        body: { data: Buffer.from(`<p>Code: <b>${CODE}</b></p>`).toString('base64url') },
      },
    };

    const h = harness(happyRoute(htmlOnly));
    assert.equal(await h.provider.waitForCode(request()), CODE);
  });

  it('skips a message that disappeared between list and get instead of failing the login', async () => {
    // The mailbox is shared with a human who may have read or moved it.
    let gets = 0;
    const h = harness((call) => {
      if (call.url.includes('oauth2.googleapis.com/token')) return TOKEN_OK;
      if (call.url.includes('/modify')) return { body: {} };
      if (/\/messages\/[^?]+/.test(new URL(call.url).pathname)) {
        gets += 1;
        return gets === 1 ? { status: 404, body: { error: { message: 'Not Found' } } } : { body: gmailMessage({ id: 'msg-2' }) };
      }
      return { body: { messages: [{ id: gets === 0 ? 'msg-1' : 'msg-2' }] } };
    });

    assert.equal(await h.provider.waitForCode(request()), CODE);
  });
});

describe('GmailApiMfaProvider - token handling', () => {
  it('requests one token for a whole poll, not one per call', async () => {
    const h = harness(happyRoute());
    await h.provider.waitForCode(request());
    assert.equal(tokenCalls(h.mock).length, 1);
  });

  it('produces a single token request for concurrent cold callers', async () => {
    const h = harness(happyRoute());
    await Promise.all([h.provider.waitForCode(request()), h.provider.waitForCode(request())]);
    assert.equal(tokenCalls(h.mock).length, 1);
  });

  it('exchanges the refresh token, never a client-credentials grant', async () => {
    const h = harness(happyRoute());
    await h.provider.waitForCode(request());

    const body = tokenCalls(h.mock)[0]?.body ?? '';
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=super-secret-refresh-token/);
  });

  it('re-requests a token once the skew window is reached', async () => {
    const h = harness(happyRoute());
    await h.provider.waitForCode(request());

    // 3600s lifetime minus the 60s skew: one second past that is expired.
    h.setNow(SINCE.getTime() + (3600 - 60) * 1000 + 1);
    await h.provider.waitForCode(request());

    assert.equal(tokenCalls(h.mock).length, 2);
  });

  it('treats a revoked refresh token as System, not Business', async () => {
    // Business would blame the group for our mailbox credentials rotting.
    const h = harness(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    }));

    const error = await h.provider.waitForCode(request()).catch((t: unknown) => t);
    assert.ok(error instanceof SystemException);
    assert.equal(error.reason, 'system');
    assert.match(error.message, /Gmail authentication failed/);
  });

  it('re-authenticates and replays once on a 401', async () => {
    let listCalls = 0;
    const h = harness((call) => {
      if (call.url.includes('oauth2.googleapis.com/token')) return TOKEN_OK;
      if (call.url.includes('/modify')) return { body: {} };
      if (/\/messages\/[^?]+/.test(new URL(call.url).pathname)) return { body: gmailMessage() };
      listCalls += 1;
      return listCalls === 1 ? { status: 401, body: { error: 'invalid' } } : { body: { messages: [{ id: 'msg-1' }] } };
    });

    assert.equal(await h.provider.waitForCode(request()), CODE);
    assert.equal(tokenCalls(h.mock).length, 2, 'the 401 should have forced a fresh token');
    assert.equal(listCalls, 2, 'the request should have been replayed exactly once');
  });

  it('explains a 403 as a missing scope, which is the actual cause every time', async () => {
    const h = harness((call) =>
      call.url.includes('oauth2.googleapis.com/token')
        ? TOKEN_OK
        : { status: 403, body: { error: { message: 'Insufficient Permission' } } },
    );

    await assert.rejects(h.provider.waitForCode(request()), /gmail\.readonly and gmail\.modify/);
  });
});

describe('GmailApiMfaProvider - redaction', () => {
  it('never logs the code, the token, the client secret or the refresh token', async () => {
    const h = harness(happyRoute());
    const code = await h.provider.waitForCode(request());
    assert.equal(code, CODE);

    const everything = h.logLines.join('\n');
    assert.ok(h.logLines.length > 0, 'the provider should log something');
    for (const secret of [CODE, ACCESS_TOKEN, SECRETS['GMAIL_CLIENT_SECRET'], SECRETS['GMAIL_REFRESH_TOKEN']]) {
      assert.ok(secret !== undefined);
      assert.ok(!everything.includes(secret), `"${secret.slice(0, 12)}..." leaked into a log line`);
    }
  });

  it('strips secret-shaped values out of an echoed error body', async () => {
    const h = harness(() => ({
      status: 400,
      rawBody: JSON.stringify({
        error: 'invalid_client',
        request: { client_secret: SECRETS['GMAIL_CLIENT_SECRET'], refresh_token: SECRETS['GMAIL_REFRESH_TOKEN'] },
      }),
    }));

    const error = await h.provider.waitForCode(request()).catch((t: unknown) => t);
    assert.ok(error instanceof SystemException);
    assert.match(error.message, /REDACTED/);
    assert.ok(!error.message.includes('super-secret-client-value'));
    assert.ok(!error.message.includes('super-secret-refresh-token'));
  });
});
