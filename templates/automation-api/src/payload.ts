import { BusinessException } from '@rpa/core';
import { z } from 'zod';

export const payloadSchema = z.strictObject({
  recordId: z.string().min(1),
  amountCents: z.number().int().nonnegative(),
});

export type Payload = z.infer<typeof payloadSchema>;

/**
 * A malformed payload is a BusinessException, never a SystemException: retrying
 * bad data produces the identical failure.
 */
export function parsePayload(raw: unknown): Payload {
  const result = payloadSchema.safeParse(raw);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');

  throw new BusinessException(`Queue item payload is not valid: ${detail}`);
}
