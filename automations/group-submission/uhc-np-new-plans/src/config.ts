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

  // ── Owner assignment (searched by first and last name) ──
  producerFirstName: z.string().min(1),
  producerLastName: z.string().min(1),

  // ── The producer screen, near the end of the employer application ──
  generalAgentName: z.string().min(1),
  generalAgentFranchiseCode: z.string().min(1),
  generalAgentEmail: z.string().min(3),
  pcisId: z.string().min(1),
  commissionPercentage: z.number().int().min(0).max(100),

  /**
   * Select Plus plans require a PCP code per member. The runbook uses a single
   * placeholder code for all of them rather than real provider assignments,
   * which is why it lives in config: it is a policy decision, not a constant.
   */
  dummyPcpCode: z.string().min(1),

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
