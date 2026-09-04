import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import type { ImapConfig } from '../config/schema.ts';
import { SystemException } from '../errors.ts';
import { createLogger } from '../logger.ts';
import { SecretResolver } from '../secrets.ts';
import {
  ImapMfaProvider,
  type ImapCredentials,
  type ImapFetchedMessage,
  type ImapSession,
} from './ImapMfaProvider.ts';
import type { MfaCodeRequest } from './MfaCodeProvider.ts';

/**
 * No network and no IMAP server: the session is injected, which is the reason
 * `createSession` is a constructor option at all.
 *
 * What is tested is the part that carries risk. The watermark, the sender
 * allow-list and the code extraction all live in the SHARED `mailboxPoll`
 * layer and are covered by its own tests, so what is left here is what this
 * provider alone is responsible for: opening only the configured label,
 * reading time from INTERNALDATE, and never letting a bookkeeping failure lose
 * a code.
 */

const CONFIG: ImapConfig = {
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  userEnv: 'MFA_IMAP_USER',
  passwordEnv: 'MFA_IMAP_APP_PASSWORD',
};

function silentLogger(): Logger {
  return createLogger({ level: 'silent', pretty: false, base: {} });
}

/** Same shape as GmailApiMfaProvider.test.ts: every level captured, child self-returning. */
function capturingLogger(lines: string[]): Logger {
  const logger = createLogger({ level: 'trace', pretty: false, base: {} }).child({});
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    (logger as unknown as Record<string, unknown>)[level] = (...args: unknown[]): void => {
      lines.push(JSON.stringify(args));
    };
  }
  (logger as unknown as Record<string, unknown>)['child'] = (): unknown => logger;
  return logger;
}

function secretsWith(values: Record<string, string>): SecretResolver {
  return new SecretResolver({
    name: 'test',
    get: async (key: string) => values[key],
  });
}

function request(overrides: Partial<MfaCodeRequest> = {}): MfaCodeRequest {
  return {
    since: new Date('2026-09-04T10:00:00.000Z'),
    timeoutMs: 30_000,
    purpose: 'test',
    matcher: {
      label: 'Access Token (Anthem)',
      fromAllowList: ['broker.anthem.com'],
      codePattern: /\b(\d{6})\b/,
    },
    ...overrides,
  };
}

function mail(overrides: Partial<ImapFetchedMessage> = {}): ImapFetchedMessage {
  return {
    uid: 42,
    internalDate: new Date('2026-09-04T10:00:30.000Z'),
    envelope: {
      subject: 'One-Time Security Code',
      from: [{ name: 'Anthem', address: 'noreply@broker.anthem.com' }],
    },
    source: 'Content-Type: text/plain\r\n\r\nYour code is 123456. It expires shortly.',
    ...overrides,
  };
}

interface FakeSession extends ImapSession {
  opened: string[];
  flagged: unknown[];
  connects: number;
  /** The uid range FETCH was asked for, so the cap can be asserted. */
  fetchedRanges: unknown[];
}

function fakeSession(messages: ImapFetchedMessage[], behaviour: {
  openThrows?: boolean;
  connectThrows?: boolean;
  flagThrows?: boolean;
} = {}): FakeSession {
  const session: FakeSession = {
    opened: [],
    flagged: [],
    connects: 0,
    fetchedRanges: [],
    search: async () => messages.map((message) => message.uid ?? 0),
    connect: async () => {
      session.connects += 1;
      if (behaviour.connectThrows === true) throw new Error('auth failed');
    },
    mailboxOpen: async (path: string) => {
      session.opened.push(path);
      if (behaviour.openThrows === true) throw new Error('no such mailbox');
      return {};
    },
    fetch: (range, _query) => {
      session.fetchedRanges.push(range);
      const wanted = String((range as { uid?: string }).uid ?? '')
        .split(',')
        .filter((uid) => uid !== '');
      async function* iterate(): AsyncGenerator<ImapFetchedMessage> {
        for (const message of messages) {
          if (wanted.includes(String(message.uid))) yield message;
        }
      }
      return iterate();
    },
    messageFlagsAdd: async (range) => {
      if (behaviour.flagThrows === true) throw new Error('flag failed');
      session.flagged.push(range);
      return true;
    },
    logout: async () => undefined,
  };
  return session;
}

function providerWith(
  session: FakeSession,
  config: ImapConfig = CONFIG,
  secrets = secretsWith({ MFA_IMAP_USER: 'ops@example.test', MFA_IMAP_APP_PASSWORD: 'app-password' }),
): ImapMfaProvider {
  return new ImapMfaProvider({
    config,
    secrets,
    logger: silentLogger(),
    pollIntervalMs: 1_000,
    createSession: () => session,
  });
}

describe('ImapMfaProvider - label scoping is the containment control', () => {
  /**
   * The credential cannot be scoped to a label, so the CODE is what keeps the
   * provider away from the rest of a shared Benefits Operations mailbox. If
   * this ever opens INBOX or All Mail, the whole reason the docs hesitated
   * about IMAP has come true.
   */
  it('opens only the configured label, never INBOX or All Mail', async () => {
    const session = fakeSession([mail()]);
    await providerWith(session).search(request());

    assert.deepEqual(session.opened, ['Access Token (Anthem)']);
  });

  it('reuses the open mailbox instead of reopening it on every poll', async () => {
    const session = fakeSession([mail()]);
    const provider = providerWith(session);

    await provider.search(request());
    await provider.search(request());

    assert.equal(session.connects, 1);
    assert.deepEqual(session.opened, ['Access Token (Anthem)']);
  });

  it('fails loudly when the label does not exist rather than widening the search', async () => {
    const session = fakeSession([mail()], { openThrows: true });
    await assert.rejects(() => providerWith(session).search(request()), (error: unknown) => {
      assert.ok(error instanceof SystemException);
      assert.match(error.message, /Access Token \(Anthem\)/);
      return true;
    });
  });
});

describe('ImapMfaProvider - reading a message', () => {
  it('maps envelope and body into the shared MfaMessage shape', async () => {
    const [message] = await providerWith(fakeSession([mail()])).search(request());

    assert.equal(message?.id, '42');
    assert.equal(message?.from, 'Anthem <noreply@broker.anthem.com>');
    assert.equal(message?.subject, 'One-Time Security Code');
    assert.match(message?.text ?? '', /123456/);
  });

  /**
   * INTERNALDATE is when the SERVER received the mail - what the watermark
   * means, and what a sender cannot influence. It also has real second
   * precision, which is the whole reason IMAP is an improvement here: the Gmail
   * UI provider could only read "6:38 PM" off a row, so a code arriving in the
   * same minute it was requested was rejected as stale.
   */
  it('takes receivedAt from INTERNALDATE, not the sender Date header', async () => {
    const [message] = await providerWith(
      fakeSession([
        mail({
          internalDate: new Date('2026-09-04T10:00:30.000Z'),
          envelope: {
            subject: 'One-Time Security Code',
            date: new Date('2020-01-01T00:00:00.000Z'),
            from: [{ address: 'noreply@broker.anthem.com' }],
          },
        }),
      ]),
    ).search(request());

    assert.equal(message?.receivedAt.toISOString(), '2026-09-04T10:00:30.000Z');
  });

  it('returns candidates newest first', async () => {
    const older = mail({ uid: 1, internalDate: new Date('2026-09-04T10:00:10.000Z') });
    const newer = mail({ uid: 2, internalDate: new Date('2026-09-04T10:00:50.000Z') });

    const messages = await providerWith(fakeSession([older, newer])).search(request());

    assert.deepEqual(messages.map((message) => message.id), ['2', '1']);
  });

  /**
   * Measured on the real mailbox 2026-09-04: 209 messages in the search window,
   * 171 of them forwarded codes. Fetching every body on every poll, at a 5s
   * interval, means hundreds of full messages per code and a poll slower than
   * its own interval. SEARCH transfers no bodies; only the newest handful are
   * fetched.
   */
  it('fetches only the newest candidates, not every message in the window', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      mail({ uid: index + 1, internalDate: new Date(Date.parse('2026-09-04T10:00:00Z') + index * 1_000) }),
    );
    const session = fakeSession(many);

    const messages = await providerWith(session).search(request());

    assert.equal(messages.length, 25, 'the fetch must be capped');
    assert.equal(session.fetchedRanges.length, 1, 'one FETCH, not one per message');
    // The newest, not the oldest: uid 60 is present and uid 1 is not.
    assert.ok(messages.some((message) => message.id === '60'));
    assert.ok(!messages.some((message) => message.id === '1'));
  });

  it('does not fetch at all when the search matches nothing', async () => {
    const session = fakeSession([]);
    assert.deepEqual(await providerWith(session).search(request()), []);
    assert.equal(session.fetchedRanges.length, 0);
  });

  it('skips a message with no date rather than guessing one', async () => {
    const undated: ImapFetchedMessage = { ...mail(), internalDate: undefined, envelope: { subject: 's' } };
    assert.deepEqual(await providerWith(fakeSession([undated])).search(request()), []);
  });

  it('decodes a base64 HTML body, where a six-digit run is otherwise invisible', async () => {
    const html = Buffer.from('<p>Your code is <b>654321</b></p>').toString('base64');
    const [message] = await providerWith(
      fakeSession([
        mail({
          source: `Content-Type: text/html\r\nContent-Transfer-Encoding: base64\r\n\r\n${html}`,
        }),
      ]),
    ).search(request());

    assert.match(message?.text ?? '', /654321/);
  });
});

describe('ImapMfaProvider - consume is bookkeeping, not a security control', () => {
  it('marks the message read', async () => {
    const session = fakeSession([mail()]);
    const provider = providerWith(session);
    await provider.search(request());
    await provider.consume('42');

    assert.deepEqual(session.flagged, [{ uid: '42' }]);
  });

  /**
   * The consume-once guarantee rests on the `since` watermark in selectCode,
   * not on this flag - and this mailbox's filter marks mail read on arrival
   * anyway. Throwing here would discard a code already in hand and force
   * another request against a carrier that throttles them.
   */
  it('does not throw when the flag cannot be set, so a good code is not lost', async () => {
    const session = fakeSession([mail()], { flagThrows: true });
    const provider = providerWith(session);
    await provider.search(request());

    await provider.consume('42');
  });

  it('is a no-op before any mailbox has been opened', async () => {
    await providerWith(fakeSession([mail()])).consume('42');
  });
});

describe('ImapMfaProvider - credentials and connection', () => {
  it('resolves the user and app password by env-var NAME', async () => {
    const session = fakeSession([mail()]);
    let seen: ImapCredentials | undefined;

    const provider = new ImapMfaProvider({
      config: CONFIG,
      secrets: secretsWith({ MFA_IMAP_USER: 'ops@example.test', MFA_IMAP_APP_PASSWORD: 'app-password' }),
      logger: silentLogger(),
      pollIntervalMs: 1_000,
      createSession: (credentials) => {
        seen = credentials;
        return session;
      },
    });

    await provider.search(request());

    assert.equal(seen?.user, 'ops@example.test');
    assert.equal(seen?.pass, 'app-password');
    assert.equal(seen?.accessToken, undefined);
  });

  it('uses XOAUTH2 when an access token is configured instead', async () => {
    const session = fakeSession([mail()]);
    let seen: ImapCredentials | undefined;

    const provider = new ImapMfaProvider({
      config: { ...CONFIG, passwordEnv: undefined, accessTokenEnv: 'MFA_IMAP_ACCESS_TOKEN' },
      secrets: secretsWith({ MFA_IMAP_USER: 'ops@example.test', MFA_IMAP_ACCESS_TOKEN: 'ya29.token' }),
      logger: silentLogger(),
      pollIntervalMs: 1_000,
      createSession: (credentials) => {
        seen = credentials;
        return session;
      },
    });

    await provider.search(request());

    assert.equal(seen?.accessToken, 'ya29.token');
    assert.equal(seen?.pass, undefined);
  });

  it('reports a missing credential as a System failure, not a Business one', async () => {
    const provider = providerWith(fakeSession([mail()]), CONFIG, secretsWith({}));
    await assert.rejects(() => provider.search(request()), SystemException);
  });

  /**
   * The three real reasons this fails, all worth naming in the message: Google
   * removed plain-password IMAP, app passwords need 2-Step Verification, and a
   * Workspace admin can disable IMAP for the whole org.
   */
  it('explains an auth failure in terms of what is actually wrong', async () => {
    const session = fakeSession([mail()], { connectThrows: true });
    await assert.rejects(() => providerWith(session).search(request()), (error: unknown) => {
      assert.ok(error instanceof SystemException);
      assert.match(error.message, /app password|OAuth/i);
      return true;
    });
  });
});

describe('ImapMfaProvider - logging never carries a code', () => {
  it('logs candidate counts and the label, never a body or a subject', async () => {
    const lines: string[] = [];

    const provider = new ImapMfaProvider({
      config: CONFIG,
      secrets: secretsWith({ MFA_IMAP_USER: 'ops@example.test', MFA_IMAP_APP_PASSWORD: 'app-password' }),
      logger: capturingLogger(lines),
      pollIntervalMs: 1_000,
      createSession: () => fakeSession([mail()]),
    });

    await provider.search(request());

    assert.ok(lines.length > 0, 'the provider should log something');
    const serialized = lines.join('\n');
    assert.doesNotMatch(serialized, /123456/, 'a code must never reach a log line');
    assert.doesNotMatch(serialized, /app-password/);
    assert.doesNotMatch(serialized, /expires shortly/, 'a body must never reach a log line');
  });
});
