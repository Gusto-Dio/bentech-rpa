import { BusinessException } from '@rpa/core';
import { z } from 'zod';

/**
 * One queue item = one group's submission (REFramework's SpecificContent).
 *
 * Note what is absent: no SSN, no date of birth, no wages, no tax id. A
 * submission automation needs an internal group id and a contact, and nothing
 * more. Payload fields that would carry identifiers are redacted by the logger
 * (see REDACT_PATHS in @rpa/core) - but the better protection is not to put
 * them in the queue at all.
 */
export const payloadSchema = z.strictObject({
  groupId: z.string().min(1),
  groupName: z.string().min(1),
  contact: z.strictObject({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    postalCode: z.string().min(1),
  }),
  /** Plan names as the carrier catalog lists them. */
  requestedPlans: z.array(z.string().min(1)),

  /**
   * DEMO SCAFFOLDING ONLY. Forces a System exception so the retry and
   * session-recovery path can be observed end to end. A real automation would
   * never carry this field; delete it when you copy this file.
   */
  injectFault: z.enum(['system-once', 'system-always']).optional(),

  /** Seed files annotate themselves; the runtime ignores this. */
  $comment: z.string().optional(),
});

export type Payload = z.infer<typeof payloadSchema>;

/**
 * Malformed payload is a BusinessException, never a SystemException. Bad data
 * fails identically on every retry, so retrying it only wastes a browser
 * relaunch.
 */
export function parsePayload(raw: unknown): Payload {
  const result = payloadSchema.safeParse(raw);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');

  throw new BusinessException(`Queue item payload is not valid: ${detail}`);
}
