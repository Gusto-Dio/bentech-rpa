import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BusinessException, SystemException } from '../errors.ts';
import {
  isDuplicateReference,
  isRetryableStatus,
  mapOrchestratorError,
  parseErrorBody,
  parseRetryAfterMs,
  type OrchestratorHttpFailure,
} from './errors.ts';

function failure(overrides: Partial<OrchestratorHttpFailure> = {}): OrchestratorHttpFailure {
  return {
    status: 500,
    statusText: 'Internal Server Error',
    method: 'GET',
    path: '/QueueItems',
    body: undefined,
    rawBody: undefined,
    attempt: 1,
    ...overrides,
  };
}

describe('isRetryableStatus', () => {
  it('retries transient statuses only', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryableStatus(status), true, `${status} should be retryable`);
    }
    for (const status of [200, 400, 401, 403, 404, 409, 422]) {
      assert.equal(isRetryableStatus(status), false, `${status} should not be retryable`);
    }
  });
});

describe('mapOrchestratorError', () => {
  it('maps validation statuses to BusinessException', () => {
    for (const status of [400, 409, 422]) {
      assert.ok(mapOrchestratorError(failure({ status })) instanceof BusinessException, `${status}`);
    }
  });

  it('maps auth and permission statuses to SystemException', () => {
    // A missing scope or a revoked secret is an environment fault. Marking a
    // queue item as a business failure for it would be wrong and permanent.
    for (const status of [401, 403, 404, 429, 500, 503]) {
      assert.ok(mapOrchestratorError(failure({ status })) instanceof SystemException, `${status}`);
    }
  });

  it('maps an unknown 4xx to SystemException rather than guessing', () => {
    assert.ok(mapOrchestratorError(failure({ status: 418 })) instanceof SystemException);
  });

  it('maps a network failure to SystemException and keeps the cause', () => {
    const cause = new Error('ECONNRESET');
    const error = mapOrchestratorError(failure({ networkError: cause }));
    assert.ok(error instanceof SystemException);
    assert.equal(error.cause, cause);
  });

  it('preserves status, errorCode and traceId in details for triage', () => {
    const error = mapOrchestratorError(
      failure({ status: 409, body: { message: 'dup', errorCode: 1002, traceId: 'trace-1' } }),
    );
    assert.equal(error.details['status'], 409);
    assert.equal(error.details['errorCode'], 1002);
    assert.equal(error.details['traceId'], 'trace-1');
  });

  it('flags a duplicate reference distinctly, since a re-run should tolerate it', () => {
    const error = mapOrchestratorError(
      failure({ status: 409, body: { message: 'exists', errorCode: 1002 } }),
    );
    assert.ok(error instanceof BusinessException);
    assert.equal(error.details['duplicateReference'], true);
    assert.match(error.message, /reference already exists/i);
  });
});

describe('isDuplicateReference', () => {
  it('recognises any 409 as a conflict on a queue-item write', () => {
    assert.equal(isDuplicateReference(failure({ status: 409 })), true);
  });

  it('recognises the documented error code on a 400', () => {
    assert.equal(isDuplicateReference(failure({ status: 400, body: { errorCode: 1002 } })), true);
  });

  it('does not treat an ordinary validation 400 as a duplicate', () => {
    assert.equal(isDuplicateReference(failure({ status: 400, body: { errorCode: 1001 } })), false);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads a delay in seconds', () => {
    assert.equal(parseRetryAfterMs('30', 60_000), 30_000);
  });

  it('reads an HTTP-date', () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfterMs(future, 60_000);
    assert.ok(parsed !== undefined && parsed > 3_000 && parsed <= 6_000);
  });

  it('caps a hostile value so a run cannot be stalled out of its window', () => {
    assert.equal(parseRetryAfterMs('86400', 60_000), 60_000);
  });

  it('ignores a missing or unparseable header', () => {
    assert.equal(parseRetryAfterMs(null, 60_000), undefined);
    assert.equal(parseRetryAfterMs('soon', 60_000), undefined);
  });
});

describe('parseErrorBody', () => {
  it('parses an Orchestrator error envelope', () => {
    assert.deepEqual(parseErrorBody('{"message":"nope","errorCode":7}'), {
      message: 'nope',
      errorCode: 7,
    });
  });

  it('returns undefined for empty or non-JSON bodies', () => {
    assert.equal(parseErrorBody(undefined), undefined);
    assert.equal(parseErrorBody('   '), undefined);
    assert.equal(parseErrorBody('<html>502</html>'), undefined);
  });
});
