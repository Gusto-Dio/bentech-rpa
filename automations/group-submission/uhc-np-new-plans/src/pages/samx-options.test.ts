import { BusinessException, SystemException } from '@rpa/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  continuationOption,
  deductibleResetOption,
  DOCUMENT_TIMEOUT_MS,
  FIELD_TIMEOUT_MS,
  organizationType,
  primaryOption,
  samxDate,
  SCREEN_STEP_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
  waitingPeriodAnswer,
} from './samx-options.ts';

describe('samxDate', () => {
  it('renders an ISO date in the US format the portal shows', () => {
    assert.equal(samxDate('2026-09-01'), '09/01/2026');
    assert.equal(samxDate('  2024-01-03  '), '01/03/2024');
  });

  /**
   * Kept a string end to end. Anthem's port records what happens otherwise: an
   * ISO string read as UTC midnight and rendered in a US timezone shifted every
   * date back a day, which re-aged members and mis-rated the group silently.
   */
  it('refuses a non-ISO date rather than guessing what it means', () => {
    assert.throws(() => samxDate('09/01/2026'), BusinessException);
    assert.throws(() => samxDate('Sep 1, 2026'), BusinessException);
    assert.throws(() => samxDate(''), BusinessException);
  });
});

describe('the unrecorded vocabularies', () => {
  /**
   * These are the tests that prove the automation FAILS CLOSED while SAMx is
   * unmapped. They are meant to be replaced during the re-map, not worked
   * around: passing them today is what stops a plausible guess reaching an
   * attested application. Each one is a SystemException, because no group's data
   * would change the outcome - the automation is unfinished, and the group must
   * not be reported as a carrier rejection.
   */
  it('refuses an organisation type until the picklist is recorded', () => {
    assert.throws(() => organizationType('llc'), SystemException);
  });

  it('refuses a deductible-reset option until the picklist is recorded', () => {
    assert.throws(() => deductibleResetOption('plan'), SystemException);
    assert.throws(() => deductibleResetOption('Empty'), SystemException);
  });

  it('refuses a continuation option until the picklist is recorded', () => {
    assert.throws(() => continuationOption('state'), SystemException);
    assert.throws(() => continuationOption('cobra'), SystemException);
  });

  it('refuses a Medicare-primary option until the picklist is recorded', () => {
    assert.throws(() => primaryOption('medicare'), SystemException);
    assert.throws(() => primaryOption('plan-primary'), SystemException);
  });

  it('refuses a waiting period until the dropdown is recorded', () => {
    assert.throws(() => waitingPeriodAnswer('1st of month after hire'), SystemException);
  });
});

describe('inputs the vocabularies do not cover', () => {
  /**
   * A value the table has no ROW for is a different failure from a row that is
   * merely unrecorded: the input is unfamiliar, which is about this group's
   * data, so it is a BusinessException. Getting this backwards would report a
   * data problem as a broken automation and retry it three times.
   */
  it('treats an unknown entity type as a data problem, not an unfinished mapping', () => {
    assert.throws(() => organizationType('cooperative'), BusinessException);
  });

  it('treats an unknown waiting period as a data problem', () => {
    assert.throws(() => waitingPeriodAnswer('1st of month after 45 days'), BusinessException);
  });
});

describe('the timeout budgets', () => {
  /**
   * step() caps EVERY gate at the step's own budget, which defaults to 60s. A
   * field or screen timeout above that default is silently truncated and reads
   * as a mystery in the log, so the two screen budgets must stay under it and
   * anything longer must come with an explicit step timeoutMs.
   */
  it('keeps the field and screen budgets under step()\'s 60s default', () => {
    assert.ok(FIELD_TIMEOUT_MS < 60_000);
    assert.ok(SCREEN_TIMEOUT_MS < 60_000);
  });

  it('gives a step that waits a whole screen out more than the default', () => {
    assert.ok(SCREEN_STEP_TIMEOUT_MS > 60_000);
    assert.ok(SCREEN_STEP_TIMEOUT_MS > SCREEN_TIMEOUT_MS);
  });

  it('gives server-built documents their own much longer budget', () => {
    assert.ok(DOCUMENT_TIMEOUT_MS > SCREEN_TIMEOUT_MS);
  });
});
