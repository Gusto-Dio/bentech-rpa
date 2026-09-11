import { z } from 'zod';

/**
 * This automation's own settings, validated at Initialize.
 *
 * Declaring a schema is what turns a missing or misspelled setting into a
 * precise startup error instead of `undefined` surfacing halfway through
 * transaction 40. Strict, so a typo in config.dev.json is loud.
 *
 * Credentials appear here only as the NAME of an environment variable. The
 * value is fetched through ctx.secrets, which is the seam a real secret store plugs
 * into later - so no config file in this repo is ever sensitive.
 */
export const automationConfigSchema = z.strictObject({
  appUrl: z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL'),
  usernameEnv: z.string().min(1),
  passwordEnv: z.string().min(1),
});

export type AutomationConfig = z.infer<typeof automationConfigSchema>;
