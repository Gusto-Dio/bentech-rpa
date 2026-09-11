import type { SecretResolver } from '@rpa/core';
import type { AutomationConfig } from './config.ts';

/**
 * Who the submission is filed by, and which agency is paid for it.
 *
 * UHC asks for considerably more of this than Anthem does - a producer, a
 * general agent, that agency's franchise code and email, and a PCIS id - and
 * every one of them identifies a real licensed person or firm. So none of them
 * appear in config, in code or in a log line: config carries the NAMES of the
 * environment variables and this resolves them, exactly as the portal
 * credentials work. See docs/poc/sanitization.md, which records that these
 * values were committed to tracked files once already.
 *
 * Resolved per transaction rather than cached at Initialize: a resolution costs
 * a `process.env` lookup behind `SecretResolver`'s own cache, and keeping it out
 * of shared state means `initialize()` stays idempotent (rule 7) with nothing to
 * rebuild after a session recovery.
 */
export interface ProducerIdentity {
  readonly firstName: string;
  readonly lastName: string;
  /** `First Last`, the form the owner-assignment grid matches a row on. */
  readonly fullName: string;
  readonly generalAgentName: string;
  readonly generalAgentFranchiseCode: string;
  readonly generalAgentEmail: string;
  readonly pcisId: string;
  /**
   * The single placeholder PCP code Select Plus plans require per member.
   *
   * Out of scope for this PoC - real PCP assignment is part of employee
   * enrollment - but resolved here because it is environment data Benefits owns
   * and it must not sit in a tracked config file either.
   */
  readonly dummyPcpCode: string;
}

/**
 * A missing value here is a SystemException, from `SecretResolver.require` - the
 * environment is misconfigured and no different input data would fix it. That is
 * the correct classification: retrying the item cannot help, but the run must
 * not report the group as a business rejection either.
 */
export async function resolveProducerIdentity(
  secrets: SecretResolver,
  config: AutomationConfig,
): Promise<ProducerIdentity> {
  const [
    firstName,
    lastName,
    generalAgentName,
    generalAgentFranchiseCode,
    generalAgentEmail,
    pcisId,
    dummyPcpCode,
  ] = await Promise.all([
    secrets.require(config.producerFirstNameEnv),
    secrets.require(config.producerLastNameEnv),
    secrets.require(config.generalAgentNameEnv),
    secrets.require(config.generalAgentFranchiseCodeEnv),
    secrets.require(config.generalAgentEmailEnv),
    secrets.require(config.pcisIdEnv),
    secrets.require(config.dummyPcpCodeEnv),
  ]);

  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    generalAgentName,
    generalAgentFranchiseCode,
    generalAgentEmail,
    pcisId,
    dummyPcpCode,
  };
}
