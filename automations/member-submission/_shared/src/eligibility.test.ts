import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BusinessException } from '@rpa/core';
import {
  assertFirstOfMonth,
  assertKnownPlanCode,
  assertWithinEnrollmentWindow,
} from './eligibility.ts';

describe('assertFirstOfMonth', () => {
  it('accepts the first of a month', () => {
    assert.doesNotThrow(() => assertFirstOfMonth('2027-01-01', 'MBR-000123'));
  });

  it('rejects any other day as a business failure', () => {
    assert.throws(() => assertFirstOfMonth('2027-01-15', 'MBR-000123'), BusinessException);
  });

  it('rejects a non-ISO format, which is ambiguous across locales', () => {
    assert.throws(() => assertFirstOfMonth('01/02/2027', 'MBR-000123'), BusinessException);
  });

  it('rejects a date that does not exist', () => {
    assert.throws(() => assertFirstOfMonth('2027-02-31', 'MBR-000123'), BusinessException);
  });

  /**
   * The reason the implementation parses as UTC. With local-time parsing, a
   * server west of UTC reads 2027-03-01 as 28 February and rejects a valid
   * date - a bug invisible on a laptop in the same timezone as the server, and
   * which appears the day the workload moves.
   */
  it('is not affected by the machine timezone', () => {
    const original = process.env['TZ'];
    try {
      for (const tz of ['UTC', 'America/Denver', 'Pacific/Kiritimati', 'Pacific/Midway']) {
        process.env['TZ'] = tz;
        assert.doesNotThrow(
          () => assertFirstOfMonth('2027-03-01', 'MBR-000123'),
          `should accept 2027-03-01 under TZ=${tz}`,
        );
      }
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });
});

describe('assertWithinEnrollmentWindow', () => {
  const now = new Date('2026-09-02T00:00:00Z');

  it('accepts a date inside the window', () => {
    assert.doesNotThrow(() =>
      assertWithinEnrollmentWindow('2027-01-01', 12, 'MBR-000123', now),
    );
  });

  it('rejects a date beyond the window', () => {
    assert.throws(
      () => assertWithinEnrollmentWindow('2029-01-01', 12, 'MBR-000123', now),
      BusinessException,
    );
  });
});

describe('assertKnownPlanCode', () => {
  const catalog = new Set(['MED-PPO-1000', 'DEN-BASE-01']);

  it('accepts a code in the catalog', () => {
    assert.doesNotThrow(() => assertKnownPlanCode('MED-PPO-1000', catalog, 'MBR-000123'));
  });

  it('rejects an unknown code as a business failure, never a system one', () => {
    assert.throws(() => assertKnownPlanCode('MED-PPO-9999', catalog, 'MBR-000123'), BusinessException);
  });
});
