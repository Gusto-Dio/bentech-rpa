import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SystemException } from '../errors.ts';
import { createLogger } from '../logger.ts';
import { ManualMfaProvider } from './ManualMfaProvider.ts';
import { extractMfaCode, isAllowedSender, type MfaMatcher } from './MfaCodeProvider.ts';
import { StaticMfaProvider } from './StaticMfaProvider.ts';

const matcher: MfaMatcher = {
  label: 'carrier-mfa',
  fromAllowList: ['anthem.com', 'uhc.com'],
  codePattern: /\b(\d{6})\b/,
};

describe('extractMfaCode', () => {
  it('pulls a six-digit code out of a message body', () => {
    assert.equal(extractMfaCode('Your verification code is 483920. It expires in 10 minutes.', matcher), '483920');
  });

  it('returns the capture group, not the whole match', () => {
    const withPrefix: MfaMatcher = { ...matcher, codePattern: /code[:\s]+(\d{6})/i };
    assert.equal(extractMfaCode('Code: 112233', withPrefix), '112233');
  });

  it('returns the whole match when the pattern has no capture group', () => {
    assert.equal(extractMfaCode('code 998877 now', { ...matcher, codePattern: /\d{6}/ }), '998877');
  });

  it('returns undefined when nothing matches', () => {
    assert.equal(extractMfaCode('Your account was updated.', matcher), undefined);
  });

  /**
   * A /g pattern keeps lastIndex between calls, so the second poll would resume
   * from where the first stopped and miss the code. Providers reuse one matcher
   * across polls, so this is a real failure mode, not a hypothetical.
   */
  it('is safe to reuse a global pattern across polls', () => {
    const global: MfaMatcher = { ...matcher, codePattern: /\b(\d{6})\b/g };
    assert.equal(extractMfaCode('code 111111', global), '111111');
    assert.equal(extractMfaCode('code 222222', global), '222222');
    assert.equal(extractMfaCode('code 333333', global), '333333');
  });
});

describe('isAllowedSender', () => {
  it('accepts a sender on the allow-list', () => {
    assert.equal(isAllowedSender('Anthem Security <no-reply@anthem.com>', matcher), true);
    assert.equal(isAllowedSender('NO-REPLY@UHC.COM', matcher), true);
  });

  /**
   * The allow-list is the control that stops a phished or spoofed "your code
   * is 000000" mail in the same label from being used as a real code.
   */
  it('rejects a sender that is not on the list', () => {
    assert.equal(isAllowedSender('attacker@example.com', matcher), false);
  });
});

describe('StaticMfaProvider', () => {
  it('returns its fixed code and records the request', async () => {
    const provider = new StaticMfaProvider('654321');
    const since = new Date();
    const code = await provider.waitForCode({ since, timeoutMs: 1_000, matcher, purpose: 'anthem' });

    assert.equal(code, '654321');
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]?.purpose, 'anthem');
    assert.equal(provider.requests[0]?.since, since);
  });
});

describe('ManualMfaProvider', () => {
  /**
   * The failure this prevents: a scheduled run blocking on a prompt nobody can
   * see, until the transaction timeout kills it half an hour later.
   */
  it('refuses to prompt when stdin is not a terminal', async () => {
    const provider = new ManualMfaProvider(createLogger({ level: 'silent', pretty: false, base: {} }));
    const original = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      await assert.rejects(
        provider.waitForCode({ since: new Date(), timeoutMs: 1_000, matcher, purpose: 'anthem' }),
        (error: unknown) => {
          assert.ok(error instanceof SystemException);
          assert.match((error as Error).message, /stdin is not a terminal/);
          return true;
        },
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });
});
