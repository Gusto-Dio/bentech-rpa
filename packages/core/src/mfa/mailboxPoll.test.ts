import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SystemException } from '../errors.ts';
import { createLogger, type Logger } from '../logger.ts';
import type { MfaCodeRequest, MfaMatcher } from './MfaCodeProvider.ts';
import { pollForCode, selectCode, type MfaMailbox, type MfaMessage } from './mailboxPoll.ts';

const matcher: MfaMatcher = {
  label: 'carrier-mfa',
  fromAllowList: ['anthem.com', 'uhc.com'],
  codePattern: /\b(\d{6})\b/,
};

const SINCE = new Date('2026-09-02T10:00:00.000Z');

function request(overrides: Partial<MfaCodeRequest> = {}): MfaCodeRequest {
  return {
    since: SINCE,
    timeoutMs: 60_000,
    matcher,
    purpose: 'anthem-ca portal login',
    ...overrides,
  };
}

function message(overrides: Partial<MfaMessage> = {}): MfaMessage {
  return {
    id: 'msg-1',
    from: 'Anthem <no-reply@anthem.com>',
    subject: 'Your verification code',
    receivedAt: new Date(SINCE.getTime() + 1_000),
    text: 'Your code is 481923. It expires in 10 minutes.',
    ...overrides,
  };
}

function silentLogger(): Logger {
  return createLogger({ level: 'silent', pretty: false, base: {} });
}

/** Captures every log line so "the code is never logged" can be asserted. */
function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const base = createLogger({ level: 'trace', pretty: false, base: {} });
  const captured = base.child({});
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    (captured as unknown as Record<string, unknown>)[level] = (...args: unknown[]): void => {
      lines.push(JSON.stringify(args));
    };
  }
  (captured as unknown as Record<string, unknown>)['child'] = (): unknown => captured;
  return { logger: captured, lines };
}

/** A mailbox whose messages disappear from search once they are consumed, like `is:unread` does. */
class FakeMailbox implements MfaMailbox {
  readonly name = 'fake';
  readonly searches: MfaCodeRequest[] = [];
  readonly consumed: string[] = [];

  #messages: MfaMessage[];

  constructor(messages: readonly MfaMessage[] = []) {
    this.#messages = [...messages];
  }

  async search(req: MfaCodeRequest): Promise<readonly MfaMessage[]> {
    this.searches.push(req);
    return this.#messages;
  }

  async consume(id: string): Promise<void> {
    this.consumed.push(id);
    this.#messages = this.#messages.filter((m) => m.id !== id);
  }
}

/** Fake clock so a three-minute timeout takes microseconds. */
function fakeClock(): { now: () => number; sleepImpl: (ms: number) => Promise<void> } {
  let nowMs = SINCE.getTime();
  return {
    now: () => nowMs,
    sleepImpl: async (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('selectCode - the watermark', () => {
  it('rejects a code that arrived before `since`, because a retry must not reuse it', () => {
    const stale = message({ receivedAt: new Date(SINCE.getTime() - 1_000) });
    assert.equal(selectCode([stale], request(), silentLogger()), undefined);
  });

  it('rejects a code that arrived exactly at `since`', () => {
    // It cannot be a response to a submission made in the same millisecond.
    const simultaneous = message({ receivedAt: SINCE });
    assert.equal(selectCode([simultaneous], request(), silentLogger()), undefined);
  });

  it('accepts a code that arrived after `since`', () => {
    const selected = selectCode([message()], request(), silentLogger());
    assert.equal(selected?.code, '481923');
    assert.equal(selected?.messageId, 'msg-1');
  });
});

describe('selectCode - the sender allow-list', () => {
  it('rejects a message in the right label from a sender outside the allow-list', () => {
    // A spoofed "your code is 000000" dropped into the same label.
    const spoofed = message({ from: 'Support <no-reply@anthem-security.example>', text: 'code 000000' });
    assert.equal(selectCode([spoofed], request(), silentLogger()), undefined);
  });

  it('accepts any sender at an allow-listed domain', () => {
    const other = message({ from: 'noreply@uhc.com' });
    assert.ok(selectCode([other], request(), silentLogger()) !== undefined);
  });

  it('rejects a message with no sender at all', () => {
    assert.equal(selectCode([message({ from: '' })], request(), silentLogger()), undefined);
  });
});

describe('selectCode - narrowing and extraction', () => {
  it('honours subjectContains when the sender emits more than one kind of mail', () => {
    const narrowed = request({ matcher: { ...matcher, subjectContains: 'verification code' } });

    assert.ok(selectCode([message()], narrowed, silentLogger()) !== undefined);
    assert.equal(
      selectCode([message({ subject: 'Your monthly statement' })], narrowed, silentLogger()),
      undefined,
    );
  });

  it('skips a matching message with no code in it and keeps looking', () => {
    const noCode = message({ id: 'msg-noise', text: 'Your account was accessed from a new device.' });
    const withCode = message({ id: 'msg-real' });

    const selected = selectCode([noCode, withCode], request(), silentLogger());
    assert.equal(selected?.messageId, 'msg-real');
  });

  it('never logs the code or the message body when it rejects one', () => {
    const { logger, lines } = capturingLogger();
    selectCode([message({ receivedAt: new Date(SINCE.getTime() - 5_000) })], request(), logger);

    const everything = lines.join('\n');
    assert.ok(lines.length > 0, 'the rejection should be logged at all');
    assert.ok(!everything.includes('481923'), 'the code leaked into a log line');
    assert.ok(!everything.includes('expires in 10 minutes'), 'the body leaked into a log line');
  });
});

describe('pollForCode - consumption', () => {
  it('marks the message read, so a retry cannot pick up the same code twice', async () => {
    const mailbox = new FakeMailbox([message()]);
    const clock = fakeClock();

    const code = await pollForCode(mailbox, request(), {
      logger: silentLogger(),
      pollIntervalMs: 1_000,
      ...clock,
    });

    assert.equal(code, '481923');
    assert.deepEqual(mailbox.consumed, ['msg-1']);

    // The second attempt finds nothing, because the first one consumed it.
    await assert.rejects(
      pollForCode(mailbox, request({ timeoutMs: 5_000 }), {
        logger: silentLogger(),
        pollIntervalMs: 1_000,
        ...fakeClock(),
      }),
      SystemException,
    );
  });

  it('does not return the code when marking it read fails', async () => {
    // Returning it anyway would let the next attempt accept the same message as
    // new and submit a code the portal has already invalidated.
    class UnconsumableMailbox extends FakeMailbox {
      override async consume(): Promise<void> {
        throw new Error('gmail modify failed');
      }
    }

    await assert.rejects(
      pollForCode(new UnconsumableMailbox([message()]), request(), {
        logger: silentLogger(),
        pollIntervalMs: 1_000,
        ...fakeClock(),
      }),
      /gmail modify failed/,
    );
  });
});

describe('pollForCode - waiting and timing out', () => {
  it('polls repeatedly until the code shows up', async () => {
    let searches = 0;
    const late = new FakeMailbox();
    late.search = async () => {
      searches += 1;
      // Arrives on the third look.
      return searches < 3 ? [] : [message()];
    };

    const code = await pollForCode(late, request(), {
      logger: silentLogger(),
      pollIntervalMs: 1_000,
      ...fakeClock(),
    });

    assert.equal(code, '481923');
    assert.equal(searches, 3);
    assert.deepEqual(late.consumed, ['msg-1']);
  });

  it('treats late mail as a System failure, never Business', async () => {
    // Business would abandon the group permanently; a retry with a fresh login
    // trigger can genuinely work.
    const error = await pollForCode(new FakeMailbox(), request({ timeoutMs: 10_000 }), {
      logger: silentLogger(),
      pollIntervalMs: 1_000,
      ...fakeClock(),
    }).catch((thrown: unknown) => thrown);

    assert.ok(error instanceof SystemException);
    assert.equal(error.reason, 'system');
    assert.match(error.message, /No MFA code arrived/);
    // The message has to name the label and the sender, or nobody can debug it at 03:00.
    assert.match(error.message, /carrier-mfa/);
    assert.match(error.message, /anthem\.com/);
    assert.equal(error.details['label'], 'carrier-mfa');
  });

  it('stops waiting when the run is shutting down', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      pollForCode(new FakeMailbox(), request(), {
        logger: silentLogger(),
        pollIntervalMs: 1_000,
        abortSignal: controller.signal,
        ...fakeClock(),
      }),
      (error: unknown) =>
        error instanceof SystemException && /shutting down/.test(error.message),
    );
  });

  it('propagates a search failure instead of retrying it, so a signed-out profile fails loudly', async () => {
    const broken = new FakeMailbox();
    broken.search = async () => {
      throw new SystemException('The Gmail MFA profile is not signed in');
    };

    await assert.rejects(
      pollForCode(broken, request(), { logger: silentLogger(), pollIntervalMs: 1_000, ...fakeClock() }),
      /not signed in/,
    );
  });
});
