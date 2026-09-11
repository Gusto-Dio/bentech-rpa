import { z } from 'zod';

/**
 * UHC (SAMx) settings, validated at Initialize.
 *
 * UHC asks for considerably more producer/general-agent identity than Anthem
 * does, and all of it is environment data Benefits owns. Credentials appear only
 * as env-var NAMES.
 */
export const automationConfigSchema = z.strictObject({
  portalUrl: z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL'),

  usernameEnv: z.string().min(1),
  passwordEnv: z.string().min(1),

  /**
   * ── PRODUCER AND GENERAL-AGENT IDENTITY ────────────────────────────────────
   * Every one of these identifies a real licensed person or firm, so config
   * carries the NAME of an environment variable and `resolveProducerIdentity`
   * resolves it - exactly as the portal credentials work.
   *
   * They used to be the values themselves, as `REPLACE_ME` placeholders in a
   * TRACKED file. That is the shape docs/poc/sanitization.md records as having
   * already leaked once across seven files: the only control against committing
   * a real producer's identity was remembering to scrub it, and it had been
   * forgotten. Filling a placeholder in place is the whole failure mode.
   * ───────────────────────────────────────────────────────────────────────────
   */
  producerFirstNameEnv: z.string().min(1),
  producerLastNameEnv: z.string().min(1),

  generalAgentNameEnv: z.string().min(1),
  generalAgentFranchiseCodeEnv: z.string().min(1),
  generalAgentEmailEnv: z.string().min(1),
  pcisIdEnv: z.string().min(1),

  /**
   * Select Plus plans require a PCP code per member. The runbook uses a single
   * placeholder code for all of them rather than real provider assignments -
   * still an env-var name, because it is a real code from the Benefits runbook.
   */
  dummyPcpCodeEnv: z.string().min(1),

  /** A policy number, not identity, so it stays a value in config. */
  commissionPercentage: z.number().int().min(0).max(100),

  // ── MFA ──
  mfaLabel: z.string().min(1),
  mfaSenderAllowList: z.array(z.string().min(1)).min(1),
  mfaTimeoutMs: z.number().int().min(10_000),

  /**
   * ── SAFETY GUARD ──
   * false means the automation stops before any attestation or Finalize. The
   * PoC runs against the PRODUCTION portal, so this defaults to false and
   * flipping it is a deliberate act.
   */
  allowSubmit: z.boolean(),
});

export type AutomationConfig = z.infer<typeof automationConfigSchema>;
