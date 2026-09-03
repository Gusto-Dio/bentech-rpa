import type { Session, SessionKind } from '@rpa/core';

/**
 * A Session that records its lifecycle instead of launching anything.
 *
 * The counters are the point: asserting that `recoverCount` is 1 after a system
 * exception is how you prove the recovery path ran, without waiting for four
 * real browser launches.
 */
export class FakeSession implements Session {
  readonly kind: SessionKind = 'none';

  initCount = 0;
  recoverCount = 0;
  closeCount = 0;

  /** Set to make init() throw, to exercise the INIT_FAILED path. */
  failOnInit: Error | undefined;

  async init(): Promise<void> {
    this.initCount += 1;
    if (this.failOnInit !== undefined) throw this.failOnInit;
  }

  async recover(): Promise<void> {
    this.recoverCount += 1;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}
