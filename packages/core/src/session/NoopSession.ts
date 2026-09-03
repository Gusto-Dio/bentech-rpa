import type { Logger } from 'pino';
import type { Session } from '../contracts/Session.ts';

/**
 * For automations with `sessionKind: "none"` - file, API and database work.
 *
 * A large share of any RPA portfolio is not UI-driven, and launching Chromium
 * for those would cost seconds of startup and a few hundred MB of container
 * memory per run for nothing. recover() is a no-op because there is no
 * stateful application to relaunch; the retry itself is the recovery.
 */
export class NoopSession implements Session {
  readonly kind = 'none';

  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async init(): Promise<void> {
    this.#logger.debug('Session kind "none": no application to start');
  }

  async recover(): Promise<void> {
    this.#logger.debug('Session kind "none": nothing to recover');
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
}
