import { BusinessException } from '@rpa/core';
import { z } from 'zod';

/**
 * One queue item = one member's election.
 *
 * Note what is NOT here: no name, no date of birth, no SSN, no wage. This
 * automation validates an election against a plan catalog, and none of those
 * fields are needed to do that. Carrying them would put PII in a JSON file on
 * disk, in logs, and in every artifact directory - for no functional gain.
 * Where a downstream system needs them, it looks them up by memberRef.
 */
export const payloadSchema = z.strictObject({
  /** Internal reference, not a government identifier. */
  memberRef: z.string().regex(/^MBR-\d{6}$/, 'must look like MBR-000123'),
  planCode: z.string().min(1),
  effectiveDate: z.string().min(1),
  coverageTier: z.enum(['employee-only', 'employee-spouse', 'employee-children', 'family']),

  /** DEMO SCAFFOLDING ONLY - remove when copying this automation. */
  injectFault: z.enum(['system-once', 'system-always']).optional(),

  $comment: z.string().optional(),
});

export type Payload = z.infer<typeof payloadSchema>;

export function parsePayload(raw: unknown): Payload {
  const result = payloadSchema.safeParse(raw);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');

  throw new BusinessException(`Queue item payload is not valid: ${detail}`);
}
