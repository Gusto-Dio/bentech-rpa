import type { SecretResolver } from '@rpa/core';
import type { AutomationConfig } from './config.ts';

/**
 * Who the submission is filed by.
 *
 * A real licensed producer and a real agency, so the values never appear in
 * config, in code or in a log line - config carries the NAMES of the
 * environment variables and this resolves them, exactly as the portal
 * credentials work. See docs/poc/sanitization.md.
 *
 * Resolved per transaction rather than cached at Initialize: a resolution costs
 * a `process.env` lookup behind `SecretResolver`'s own cache, and keeping it out
 * of shared state means `initialize()` stays idempotent (rule 7) with nothing to
 * rebuild after a session recovery.
 */
export interface ProducerIdentity {
  readonly firstName: string;
  readonly lastName: string;
  /** Also the agency's encrypted TIN and the portal's account id. Asserted, never typed. */
  readonly agencyCode: string;
}

/**
 * A missing value here is a SystemException, from `SecretResolver.require` -
 * the environment is misconfigured and no different input data would fix it.
 * That is the correct classification: retrying the item cannot help, but the
 * run must not report the group as a business rejection either.
 */
export async function resolveProducerIdentity(
  secrets: SecretResolver,
  config: AutomationConfig,
): Promise<ProducerIdentity> {
  const [firstName, lastName, agencyCode] = await Promise.all([
    secrets.require(config.producerFirstNameEnv),
    secrets.require(config.producerLastNameEnv),
    secrets.require(config.paidAgencyCodeEnv),
  ]);

  return { firstName, lastName, agencyCode };
}
