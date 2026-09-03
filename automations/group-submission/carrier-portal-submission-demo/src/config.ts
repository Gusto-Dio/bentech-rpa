import { z } from 'zod';

/**
 * Settings owned by this automation, validated at Initialize.
 *
 * Strict: a typo in config.dev.json fails at startup with the offending key,
 * rather than silently doing nothing 40 transactions later.
 */
export const automationConfigSchema = z.strictObject({
  portalUrl: z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL'),

  /** NAMES of the credential variables. The values never appear in config. */
  usernameEnv: z.string().min(1),
  passwordEnv: z.string().min(1),

  /**
   * A config-driven business rule, in REFramework's spirit: above this quoted
   * total the submission needs a human, so the automation must not submit it.
   */
  approvalThresholdCents: z.number().int().positive(),
});

export type AutomationConfig = z.infer<typeof automationConfigSchema>;
