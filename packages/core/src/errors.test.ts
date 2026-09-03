import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BusinessException, SystemException, classifyError, serializeError, toError } from './errors.ts';

/**
 * The classifier is the single most consequential function in the framework: it
 * decides whether a transaction is retried with a full session recovery or
 * failed on the spot. These cases pin that behaviour down.
 */
describe('classifyError', () => {
  it('classifies a BusinessException as business', () => {
    assert.equal(classifyError(new BusinessException('rule violated')).reason, 'business');
  });

  it('classifies a SystemException as system', () => {
    assert.equal(classifyError(new SystemException('portal down')).reason, 'system');
  });

  it('treats a plain Error as system, so unrecognised failures stay retryable', () => {
    assert.equal(classifyError(new Error('who knows')).reason, 'system');
  });

  it('treats a Playwright-style TimeoutError as system', () => {
    const timeout = new Error('locator.click: Timeout 15000ms exceeded');
    timeout.name = 'TimeoutError';
    assert.equal(classifyError(timeout).reason, 'system');
  });

  it('survives a non-Error being thrown', () => {
    const { reason, error } = classifyError({ nope: true });
    assert.equal(reason, 'system');
    assert.match(error.message, /Non-error value thrown/);
  });

  it('does not let a look-alike object impersonate a business failure', () => {
    // Duck-typing would misread this. instanceof does not.
    assert.equal(classifyError({ reason: 'business', message: 'fake' }).reason, 'system');
  });
});

describe('toError', () => {
  it('passes an Error through unchanged', () => {
    const original = new Error('original');
    assert.equal(toError(original), original);
  });

  it('wraps a string', () => {
    assert.equal(toError('just a string').message, 'just a string');
  });
});

describe('serializeError', () => {
  it('captures the reason and details for artifacts', () => {
    const serialized = serializeError(
      new BusinessException('declined', { details: { groupId: 'GRP-0001' } }),
    );
    assert.equal(serialized.name, 'BusinessException');
    assert.equal(serialized.reason, 'business');
    assert.deepEqual(serialized.details, { groupId: 'GRP-0001' });
  });

  it('records the cause when one was chained', () => {
    const serialized = serializeError(
      new SystemException('outer', { cause: new Error('inner') }),
    );
    assert.equal(serialized.cause, 'Error: inner');
  });
});
