import { z } from 'zod';

export const automationConfigSchema = z.strictObject({
  /** Relative to this automation's folder. Resolved with path.join at use time. */
  planCatalogFile: z.string().min(1),
  /** How far ahead an effective date may be. Tighter in production. */
  maxMonthsAhead: z.number().int().positive(),
});

export type AutomationConfig = z.infer<typeof automationConfigSchema>;
