import { BusinessException } from '@rpa/core';
import { z } from 'zod';

/**
 * The shape of one queue item's payload (REFramework's SpecificContent).
 */
export const payloadSchema = z.strictObject({
  recordId: z.string().min(1),
  displayName: z.string().min(1),
});

export type Payload = z.infer<typeof payloadSchema>;

/**
 * A malformed payload is a BusinessException, never a SystemException.
 *
 * This is the distinction the whole framework turns on: retrying bad data
 * produces the identical failure, so the transaction is marked failed
 * immediately and the run moves on to the next item.
 */
export function parsePayload(raw: unknown): Payload {
  const result = payloadSchema.safeParse(raw);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');

  throw new BusinessException(`Queue item payload is not valid: ${detail}`);
}
