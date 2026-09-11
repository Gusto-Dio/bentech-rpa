import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SystemException } from '../errors.ts';
import { createLogger, type Logger } from '../logger.ts';
import {
  GmailUiMfaProvider,
  lastInstantOfMinute,
  parseAccountFromTitle,
  parseGmailDate,
  type GmailRow,
  type GmailUiMode,
  type GmailUiPage,
} from './GmailUiMfaProvider.ts';
import type { MfaCodeRequest, MfaMatcher } from './MfaCodeProvider.ts';

const matcher: MfaMatcher = {
  label: 'Access Token (Anthem)',
  fromAllowList: ['anthem.com'],
  codePattern: /\b(\d{6})\b/,
};

const SINCE = new Date('2026-09-02T10:00:00.000Z');
const CODE = '481923';

function request(overrides: Partial<MfaCodeRequest> = {}): MfaCodeRequest {
  return { since: SINCE, timeoutMs: 30_000, matcher, purpose: 'anthem-ca portal login', ...overrides };
}

function row(overrides: Partial<GmailRow> = {}): GmailRow {
  return {
    id: 'thread-1',
    dateTitle: 'Wed, Sep 2, 2026, 10:00 AM',
    senders: ['no-reply@anthem.com'],
    subject: 'Your verification code',
    receivedAt: new Date(SINCE.getTime() + 1_000),
    snippet: `Your verification code is ${CODE}`,
    ...overrides,
  };
}

/** Records what the provider asked the browser to do. */
class FakeGmailUiPage implements GmailUiPage {
  readonly queries: string[] = [];
  readonly bodiesRead: string[] = [];
  readonly marked: string[] = [];
  closed = false;

  #rows: GmailRow[];
  readonly #bodies: Map<string, string>;

  constructor(rows: readonly GmailRow[] = [], bodies: Iterable<[string, string]> = []) {
    this.#rows = [...rows];
    this.#bodies = new Map(bodies);
  }

  async listLabel(label: string): Promise<readonly GmailRow[]> {
    this.queries.push(label);
    return this.#rows;
  }

  async readBody(row: GmailRow): Promise<string> {
    this.bodiesRead.push(row.id);
    return this.#bodies.get(row.id) ?? '';
  }

  async markRead(row: GmailRow): Promise<void> {
    this.marked.push(row.id);
    // Mirrors is:unread - a read message stops matching the runtime query.
    this.#rows = this.#rows.filter((r) => r.id !== row.id);
  }

  async signedInAccount(): Promise<string | undefined> {
    return 'benefitsoperations@example.test';
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function silentLogger(): Logger {
  return createLogger({ level: 'silent', pretty: false, base: {} });
}

const CDP: GmailUiMode = { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' };

function harness(page: FakeGmailUiPage, mode: GmailUiMode = CDP): { provider: GmailUiMfaProvider; opens: number } {
  let now = SINCE.getTime();
  const state = { opens: 0 };

  const provider = new GmailUiMfaProvider({
    mode,
    logger: silentLogger(),
    pollIntervalMs: 1_000,
    pageFactory: async () => {
      state.opens += 1;
      return page;
    },
    now: () => now,
    sleepImpl: async (ms: number) => {
      now += ms;
    },
  });

  return {
    provider,
    get opens(): number {
      return state.opens;
    },
  };
}

describe('GmailUiMfaProvider - label scoping', () => {
  it('asks for exactly the configured label, and nothing else', async () => {
    /**
     * The label VIEW, not a search. Gmail's own URL is
     * `#label/Access+Token+(Anthem)`, so there is no query syntax to get subtly
     * wrong. The search-based version this replaced once returned 51 rows
     * because it had landed on the inbox, and its `is:unread` term hid every
     * real code - this mailbox's filter marks mail read on arrival.
     */
    const page = new FakeGmailUiPage([row()]);
    await harness(page).provider.waitForCode(request());

    assert.deepEqual(page.queries, ['Access Token (Anthem)']);
  });

  it('reports which mode it is running in, since they fail differently', () => {
    assert.equal(harness(new FakeGmailUiPage()).provider.name, 'gmail-cdp');
    assert.equal(
      harness(new FakeGmailUiPage(), { kind: 'profile', userDataDir: '/tmp/p', headless: false }).provider.name,
      'gmail-profile',
    );
  });
});

describe('GmailUiMfaProvider - reading a code', () => {
  it('takes the code from the list snippet without opening the message', async () => {
    // Opening a message is what marks it read in Gmail, so not opening is both
    // faster and one less irreversible side-effect.
    const page = new FakeGmailUiPage([row()]);
    const code = await harness(page).provider.waitForCode(request());

    assert.equal(code, CODE);
    assert.deepEqual(page.bodiesRead, [], 'the body should not have been opened');
    assert.deepEqual(page.marked, ['thread-1']);
  });

  it('opens the message when the snippet is truncated before the code', async () => {
    const truncated = row({ snippet: 'Your verification code is below. Do not share it...' });
    const page = new FakeGmailUiPage([truncated], [['thread-1', `code: ${CODE}`]]);

    assert.equal(await harness(page).provider.waitForCode(request()), CODE);
    assert.deepEqual(page.bodiesRead, ['thread-1']);
  });

  it('does not open - and so does not consume - mail it is going to reject', async () => {
    /**
     * The important one. If a stale or wrong-sender message were opened to look
     * for a code, Gmail would mark it read, and a genuine code arriving under
     * the same conditions later could be silently skipped.
     */
    const stale = row({ id: 'stale', receivedAt: new Date(SINCE.getTime() - 60_000), snippet: 'no code here' });
    const spoofed = row({ id: 'spoofed', senders: ['no-reply@anthem-security.example'], snippet: 'no code here' });
    const page = new FakeGmailUiPage([stale, spoofed]);

    await assert.rejects(harness(page).provider.waitForCode(request({ timeoutMs: 3_000 })), SystemException);

    assert.deepEqual(page.bodiesRead, []);
    assert.deepEqual(page.marked, []);
  });

  it('rejects a code that arrived before the watermark', async () => {
    const page = new FakeGmailUiPage([row({ receivedAt: new Date(SINCE.getTime() - 1_000) })]);
    await assert.rejects(harness(page).provider.waitForCode(request({ timeoutMs: 3_000 })), SystemException);
    assert.deepEqual(page.marked, []);
  });

  it('rejects a code from a sender outside the allow-list', async () => {
    const page = new FakeGmailUiPage([row({ senders: ['attacker@evil.example'] })]);
    await assert.rejects(harness(page).provider.waitForCode(request({ timeoutMs: 3_000 })), SystemException);
    assert.deepEqual(page.marked, []);
  });

  it('treats a row whose date could not be read as stale, not as fresh', async () => {
    // Failing closed: Gmail's date markup changing must not turn every old
    // message into an acceptable code.
    const page = new FakeGmailUiPage([row({ receivedAt: undefined })]);
    await assert.rejects(harness(page).provider.waitForCode(request({ timeoutMs: 3_000 })), SystemException);
    assert.deepEqual(page.marked, []);
  });

  it('does not hand back the same code twice', async () => {
    const page = new FakeGmailUiPage([row()]);
    const h = harness(page);

    assert.equal(await h.provider.waitForCode(request()), CODE);
    await assert.rejects(h.provider.waitForCode(request({ timeoutMs: 3_000 })), SystemException);
  });

  it('yields no messages rather than a wrong one when the markup is unrecognised', async () => {
    // The fail-closed contract: unknown markup times out, it never guesses.
    const page = new FakeGmailUiPage([]);
    await assert.rejects(
      harness(page).provider.waitForCode(request({ timeoutMs: 3_000 })),
      (error: unknown) => error instanceof SystemException && /No MFA code arrived/.test(error.message),
    );
  });
});

describe('GmailUiMfaProvider - browser lifecycle', () => {
  it('opens one browser for the whole run, not one per poll', async () => {
    const page = new FakeGmailUiPage([row(), row({ id: 'thread-2' })]);
    const h = harness(page);

    await h.provider.waitForCode(request());
    await h.provider.waitForCode(request());

    assert.equal(h.opens, 1);
  });

  it('closes what it opened', async () => {
    const page = new FakeGmailUiPage([row()]);
    const h = harness(page);
    await h.provider.waitForCode(request());
    await h.provider.close();
    assert.equal(page.closed, true);
  });
});

describe('parseGmailDate', () => {
  it('parses the full date Gmail puts in a row title', () => {
    for (const title of [
      'Tue, Sep 2, 2026, 4:31 PM',
      'Sep 2, 2026, 4:31 PM',
      '2 Sep 2026, 16:31',
      'Tue, Sep 2, 2026 at 4:31 PM',
    ]) {
      const parsed = parseGmailDate(title);
      assert.ok(parsed !== undefined, `failed to parse: ${title}`);
      assert.equal(parsed.getFullYear(), 2026);
    }
  });

  it('returns undefined for a relative date, rather than guessing at today', () => {
    // "4:31 PM" with no day is exactly the ambiguity that makes a stale code
    // look fresh, so it must not be resolved by assuming today.
    assert.equal(parseGmailDate('4:31 PM'), undefined);
  });

  it('returns undefined for empty or unrecognised markup', () => {
    assert.equal(parseGmailDate(''), undefined);
    assert.equal(parseGmailDate('   '), undefined);
    assert.equal(parseGmailDate('yesterday'), undefined);
  });
});

describe('parseAccountFromTitle', () => {
  /**
   * A synthetic address, deliberately.
   *
   * This fixture used the real mailbox the PoC reads. That address is half of
   * an IMAP credential - `MFA_IMAP_USER`, whose other half is
   * `MFA_IMAP_APP_PASSWORD` - and rule 3 keeps values out of tracked files
   * whichever half they are. The parser only cares about the shape of Gmail's
   * title, so a realistic-looking address proves exactly as much.
   */
  it('reads the mailbox Gmail names in its title', () => {
    assert.equal(
      parseAccountFromTitle('Inbox (3) - mailbox@example.test - Gmail'),
      'mailbox@example.test',
    );
  });

  it('returns undefined when the title names no account', () => {
    // Better to say "unknown" than to claim the wrong mailbox was verified.
    assert.equal(parseAccountFromTitle('Gmail'), undefined);
  });
});

describe('GmailUiMfaProvider - grouped threads with several senders', () => {
  it('accepts a thread whose senders are ALL allow-listed', async () => {
    /**
     * This is the case that silently broke every real login. Conversation view
     * groups the carrier's original and the forwarded copy into ONE row, so the
     * row carries two senders. An earlier version kept a single sender and
     * discarded anything else as ambiguous - Gmail returned the message, and it
     * vanished before the security check ever saw it.
     */
    const matcherBoth: MfaMatcher = {
      ...matcher,
      fromAllowList: ['broker.anthem.com', 'carrierops@gusto.com'],
    };
    const thread = row({ senders: ['noreply@broker.anthem.com', 'carrierops@gusto.com'] });
    const page = new FakeGmailUiPage([thread]);

    const code = await harness(page).provider.waitForCode(request({ matcher: matcherBoth }));
    assert.equal(code, CODE);
    assert.deepEqual(page.marked, ['thread-1']);
  });

  it('refuses a thread carrying even one sender outside the allow-list', async () => {
    // Requiring ALL senders keeps the control meaningful: a thread that has
    // picked up an unknown participant is not a trustworthy source of a code.
    const thread = row({ senders: ['noreply@broker.anthem.com', 'attacker@evil.example'] });
    const page = new FakeGmailUiPage([thread]);

    await assert.rejects(
      harness(page).provider.waitForCode(request({ timeoutMs: 3_000 })),
      SystemException,
    );
    assert.deepEqual(page.marked, []);
  });

  it('refuses a row with no readable sender', async () => {
    const page = new FakeGmailUiPage([row({ senders: [] })]);
    await assert.rejects(
      harness(page).provider.waitForCode(request({ timeoutMs: 3_000 })),
      SystemException,
    );
  });
});

describe('GmailUiMfaProvider - a row that disappeared', () => {
  it('skips an unopenable row and takes the code from the next candidate', async () => {
    /**
     * The code usually arrives twice: the carrier's original, whose snippet
     * carries it, and a forwarded copy whose snippet is only preamble. An
     * earlier version aborted the whole poll when the forward could not be
     * opened - so it never reached the original sitting right behind it, and a
     * poll that effectively had the code returned nothing.
     */
    class OneBadRow extends FakeGmailUiPage {
      override async readBody(r: GmailRow): Promise<string> {
        throw new SystemException(`The Gmail row for "${r.id}" is no longer in the list`, {
          details: { reason: 'row-vanished' },
        });
      }
    }

    const forward = row({ id: 'forward', snippet: 'You have a new one-time code. Do not share it.' });
    const original = row({ id: 'original', snippet: `Your verification code is ${CODE}` });
    const page = new OneBadRow([forward, original]);

    assert.equal(await harness(page).provider.waitForCode(request()), CODE);
    // Only the row that actually supplied the code was consumed.
    assert.deepEqual(page.marked, ['original']);
  });

  it('reports a failure when EVERY candidate is unopenable', async () => {
    /**
     * Gmail puts no stable thread id on a row, so the id is its internal DOM id
     * and means nothing once the list re-renders. An earlier version fell back
     * to navigating `#all/<dom-id>`, a made-up address that could land on the
     * wrong message and mark somebody else's code read.
     */
    class VanishingPage extends FakeGmailUiPage {
      override async readBody(row: GmailRow): Promise<string> {
        throw new SystemException(`The Gmail row "${row.id}" is no longer in the list`, {
          details: { reason: 'row-vanished' },
        });
      }
    }

    const truncated = row({ snippet: 'Your verification code is below...' });
    const page = new VanishingPage([truncated]);

    // No code obtained, and nothing consumed on the way out.
    await assert.rejects(
      harness(page).provider.waitForCode(request({ timeoutMs: 3_000 })),
      SystemException,
    );
    assert.deepEqual(page.marked, []);
  });
});

describe('lastInstantOfMinute', () => {
  it('widens a minute-truncated row date to the last instant it could mean', () => {
    /**
     * Gmail's row reads "6:38 PM" with no seconds, so the true receive time is
     * somewhere in [19:38:00, 19:38:59]. Reporting the START of that interval
     * made the watermark reject a code that arrived in the very minute it was
     * requested - exactly what a fast delivery looks like.
     */
    const parsed = new Date('2026-09-02T10:00:00.000Z');
    assert.equal(lastInstantOfMinute(parsed)?.toISOString(), '2026-09-02T10:00:59.999Z');
  });

  it('leaves an unparseable date undefined, so it keeps failing closed', () => {
    assert.equal(lastInstantOfMinute(undefined), undefined);
  });

  it('lets a same-minute code through the watermark, but not an earlier one', async () => {
    const since = new Date('2026-09-02T10:00:40.000Z');

    // As the real page object reports it: end of the named minute.
    const sameMinute = new FakeGmailUiPage([
      row({ receivedAt: lastInstantOfMinute(new Date('2026-09-02T10:00:00.000Z')) }),
    ]);
    assert.equal(await harness(sameMinute).provider.waitForCode(request({ since })), CODE);

    // A minute earlier stays out: the tolerance is one minute, not open-ended,
    // so the previous attempt's code cannot sneak back in.
    const earlier = new FakeGmailUiPage([
      row({ receivedAt: lastInstantOfMinute(new Date('2026-09-02T09:58:00.000Z')) }),
    ]);
    await assert.rejects(
      harness(earlier).provider.waitForCode(request({ since, timeoutMs: 3_000 })),
      SystemException,
    );
    assert.deepEqual(earlier.marked, []);
  });
});

describe('GmailUiMfaProvider - consuming an unknown row', () => {
  it('does not mark anything read when the row is unknown, and does not throw', async () => {
    /**
     * Marking read is an audit trail, not the freshness mechanism - the
     * watermark is. An earlier version threw here, which discarded a code that
     * had already been read successfully.
     */
    const page = new FakeGmailUiPage([row()]);
    await harness(page).provider.consume('someone@example.test|never listed');
    assert.deepEqual(page.marked, [], 'must not guess at which message to mark');
  });

  it('still returns the code when marking it read fails', async () => {
    // Reading the body navigates off the list, so re-locating the row can fail -
    // and opening the message is itself what clears UNREAD. Losing a good code
    // to that bookkeeping step was a real failure, twice.
    class UnmarkablePage extends FakeGmailUiPage {
      override async markRead(): Promise<void> {
        throw new SystemException('The Gmail row is no longer in the list');
      }
    }

    const page = new UnmarkablePage([row()]);
    assert.equal(await harness(page).provider.waitForCode(request()), CODE);
  });
});
