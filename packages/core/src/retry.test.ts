import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BusinessException, SystemException } from './errors.ts';
import { computeBackoff, withRetry } from './retry.ts';

describe('withRetry', () => {
  it('returns the first successful result', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return 'ok';
      },
      { attempts: 3, label: 'action', delayMs: 0 },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries a system failure and then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new SystemException('flaky');
        return 'recovered';
      },
      { attempts: 3, label: 'action', delayMs: 0 },
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('never retries a BusinessException - the rule will not change its mind', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new BusinessException('ineligible');
        },
        { attempts: 5, label: 'action', delayMs: 0 },
      ),
      BusinessException,
    );
    assert.equal(calls, 1);
  });

  it('gives up after the configured number of attempts', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new SystemException('always down');
        },
        { attempts: 3, label: 'action', delayMs: 0 },
      ),
      SystemException,
    );
    assert.equal(calls, 3);
  });
});

describe('computeBackoff', () => {
  const policy = { baseMs: 1000, factor: 2, maxMs: 8000 };

  it('grows with each retry and stays jittered within half the target', () => {
    for (const [retry, target] of [[1, 1000], [2, 2000], [3, 4000]] as const) {
      const delay = computeBackoff(policy, retry);
      assert.ok(delay >= target / 2 && delay <= target, `retry ${retry} gave ${delay}`);
    }
  });

  it('never exceeds maxMs', () => {
    assert.ok(computeBackoff(policy, 20) <= policy.maxMs);
  });
});
