import { z } from 'zod';

/**
 * This automation's own settings, validated at Initialize. Strict, so a typo in
 * config.dev.json fails loudly at startup instead of silently doing nothing.
 *
 * Paths are relative to the repo root and joined with path.join at use time -
 * never absolute, so the same config works on macOS and in the container.
 */
export const automationConfigSchema = z.strictObject({
  inputFile: z.string().min(1),
});

export type AutomationConfig = z.infer<typeof automationConfigSchema>;
