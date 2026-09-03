import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BusinessException, SystemException } from '@rpa/core';
import { createTestTxContext } from '@rpa/testkit';
import type { AutomationConfig } from './config.ts';
import type { Payload } from './payload.ts';
import { processTransaction } from './processTransaction.ts';

/**
 * Transaction-level tests with no queue, no browser and no filesystem - the
 * whole point of @rpa/testkit. These run in milliseconds, which is what makes
 * it practical to cover every business rule rather than only the happy path.
 */

const CONFIG: AutomationConfig = {
  planCatalogFile: 'data/input/plan-catalog.csv',
  maxMonthsAhead: 120,
};

const VALID: Payload = {
  memberRef: 'MBR-000123',
  planCode: 'MED-PPO-1000',
  effectiveDate: '2027-01-01',
  coverageTier: 'employee-only',
};

function contextFor(payload: Payload, attempt = 1) {
  const ctx = createTestTxContext<Payload, AutomationConfig>({
    payload,
    automationConfig: CONFIG,
    attempt,
  });
  // initialize() would normally populate this from the catalog file.
  ctx.state.set('planCodes', new Set(['MED-PPO-1000', 'DEN-BASE-01']));
  return ctx;
}

describe('processTransaction', () => {
  it('accepts a valid election', async () => {
    await assert.doesNotReject(processTransaction(contextFor(VALID)));
  });

  it('rejects an unknown plan code as a business failure', async () => {
    await assert.rejects(
      processTransaction(contextFor({ ...VALID, planCode: 'MED-PPO-9999' })),
      BusinessException,
    );
  });

  it('rejects a mid-month effective date as a business failure', async () => {
    await assert.rejects(
      processTransaction(contextFor({ ...VALID, effectiveDate: '2027-01-15' })),
      BusinessException,
    );
  });

  it('raises a SystemException when the catalog is missing from run state', async () => {
    const ctx = createTestTxContext<Payload, AutomationConfig>({
      payload: VALID,
      automationConfig: CONFIG,
    });
    // No planCodes: initialize() did not complete. That is an environment
    // problem, so it must be retryable rather than a silent rejection.
    await assert.rejects(processTransaction(ctx), SystemException);
  });

  it('the injected system-once fault fails attempt 1 and clears on attempt 2', async () => {
    const payload: Payload = { ...VALID, injectFault: 'system-once' };
    await assert.rejects(processTransaction(contextFor(payload, 1)), SystemException);
    await assert.doesNotReject(processTransaction(contextFor(payload, 2)));
  });

  it('the injected system-always fault never clears', async () => {
    const payload: Payload = { ...VALID, injectFault: 'system-always' };
    await assert.rejects(processTransaction(contextFor(payload, 5)), SystemException);
  });
});
