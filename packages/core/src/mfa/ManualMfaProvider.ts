import { createInterface } from 'node:readline/promises';
import type { Logger } from 'pino';
import { SystemException } from '../errors.ts';
import type { MfaCodeProvider, MfaCodeRequest } from './MfaCodeProvider.ts';

/**
 * Asks a human for the code on stdin.
 *
 * Useful for the very first run against a portal, when you want to prove the
 * browser flow before wiring mail access at all. It is the fallback, never the
 * production provider - an automation that needs a human is not unattended,
 * which is the entire premise of this framework.
 *
 * Refuses outright when stdin is not a TTY. Otherwise a scheduled run would sit
 * blocked on a prompt nobody can see until the transaction timeout kills it,
 * which is the most confusing possible failure.
 */
export class ManualMfaProvider implements MfaCodeProvider {
  readonly name = 'manual';

  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async waitForCode(request: MfaCodeRequest): Promise<string> {
    if (process.stdin.isTTY !== true) {
      throw new SystemException(
        'mfa.provider is "manual" but stdin is not a terminal, so nobody can answer the prompt. ' +
          'Use the Gmail provider for unattended runs.',
        { details: { provider: this.name, purpose: request.purpose } },
      );
    }

    this.#logger.warn(
      { provider: this.name, purpose: request.purpose },
      'Waiting for an MFA code to be typed in - this run is NOT unattended',
    );

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(`\nMFA code for ${request.purpose}: `);
      const code = answer.trim();
      if (code.length === 0) {
        throw new SystemException('No MFA code was entered', {
          details: { provider: this.name, purpose: request.purpose },
        });
      }
      // The code itself is never logged.
      this.#logger.info({ provider: this.name, purpose: request.purpose }, 'MFA code supplied manually');
      return code;
    } finally {
      rl.close();
    }
  }
}
