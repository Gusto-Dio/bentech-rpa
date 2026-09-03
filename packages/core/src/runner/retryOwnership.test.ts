import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  FailureReason,
  QueueItem,
  QueueProvider,
  QueueStats,
} from '../index.ts';
import { runAutomation } from './runner.ts';

/**
 * The single most consequential integration point of the Orchestrator work.
 *
 * In robot mode a System exception is reported as an ApplicationException and
 * Orchestrator's Auto-Retry produces the next attempt. If the runner also
 * retried, the two would multiply - three local attempts against three
 * Orchestrator retries is nine real submissions to a carrier. These tests pin
 * the guard down against the actual runner, not a mock of it.
 *
 * Driven through member-submission/roster-file-validation-demo because it is
 * sessionKind "none": no browser, so a full run costs milliseconds, and its
 * injectFault: "system-always" payload throws a SystemException on every attempt.
 */

const ALWAYS_FAILING_PAYLOAD = {
  memberRef: 'MBR-000999',
  planCode: 'MED-PPO-1000',
  effectiveDate: '2027-01-01',
  coverageTier: 'employee-only',
  injectFault: 'system-always',
};

class RecordingQueue implements QueueProvider {
  readonly calls: string[] = [];
  readonly failures: FailureReason[] = [];
  #handedOut = false;

  constructor(readonly retryOwner: 'runner' | 'orchestrator') {}

  async init(): Promise<void> {}

  async getNext(): Promise<QueueItem | null> {
    if (this.#handedOut) return null;
    this.#handedOut = true;
    this.calls.push('getNext');
    return {
      id: '1',
      reference: 'MBR-2099',
      priority: 'normal',
      payload: ALWAYS_FAILING_PAYLOAD,
      status: 'inProgress',
      retryCount: 0,
      createdAt: new Date(0).toISOString(),
    };
  }

  async complete(): Promise<void> {
    this.calls.push('complete');
  }

  async fail(_item: QueueItem, reason: FailureReason): Promise<void> {
    this.calls.push('fail');
    this.failures.push(reason);
  }

  async requeue(item: QueueItem): Promise<QueueItem> {
    this.calls.push('requeue');
    item.retryCount += 1;
    return item;
  }

  async stats(): Promise<QueueStats> {
    return { total: 1, new: 0, inProgress: 0, success: 0, failed: 1, abandoned: 0 };
  }

  async close(): Promise<void> {}
}

const AUTOMATION_ID = 'member-submission/roster-file-validation-demo';

/** Keeps test runs out of the real artifacts/ and data/ directories. */
const TEST_ENV = {
  ...process.env,
  LOG_LEVEL: 'silent',
  ARTIFACTS_DIR: '.tmp/test-artifacts',
  DATA_DIR: '.tmp/test-data',
};

describe('runner - retry ownership', () => {
  it('does not retry when the queue backend owns retries', async () => {
    const queue = new RecordingQueue('orchestrator');

    const { summary, exitCode } = await runAutomation({
      automationId: AUTOMATION_ID,
      env: 'dev',
      processEnv: TEST_ENV,
      queueProvider: queue,
    });

    assert.equal(summary.processed, 1);
    assert.equal(summary.system, 1);
    assert.equal(summary.retries, 0, 'the runner must not retry when Orchestrator owns retries');
    assert.equal(exitCode, 1);

    // Exactly one attempt, reported once as a system failure. No requeue.
    assert.deepEqual(queue.calls, ['getNext', 'fail']);
    assert.deepEqual(queue.failures, ['system']);
  });

  it('does retry when the runner owns retries', async () => {
    const queue = new RecordingQueue('runner');

    const { summary } = await runAutomation({
      automationId: AUTOMATION_ID,
      env: 'dev',
      processEnv: TEST_ENV,
      queueProvider: queue,
    });

    assert.equal(summary.processed, 1);
    assert.equal(summary.system, 1);
    assert.ok(summary.retries > 0, 'the runner owns retries here, so it must retry');

    // maxRetries for this automation is 2, so: attempt, requeue, attempt,
    // requeue, attempt, then the terminal failure.
    assert.deepEqual(queue.calls, ['getNext', 'requeue', 'requeue', 'fail']);
    assert.equal(summary.retries, 2);
  });

  /**
   * A provider that says nothing about retry ownership - every local provider -
   * must keep the original behaviour.
   */
  it('defaults to runner-owned retries when a provider does not declare ownership', async () => {
    const queue = new RecordingQueue('runner') as QueueProvider;
    delete (queue as { retryOwner?: unknown }).retryOwner;

    const { summary } = await runAutomation({
      automationId: AUTOMATION_ID,
      env: 'dev',
      processEnv: TEST_ENV,
      queueProvider: queue,
    });

    assert.equal(summary.retries, 2);
  });
});
