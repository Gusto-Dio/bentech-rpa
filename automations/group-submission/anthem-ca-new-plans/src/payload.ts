import {
  parseGroupSubmissionPayload,
  type GroupSubmissionPayload,
} from '@auto/group-submission-shared';

/**
 * Anthem consumes the shared group-submission payload unchanged.
 *
 * The carrier-specific parts are data, not schema: `policies` carries Anthem
 * contract codes (8VDP, 8V9F, ...) and `medicalDeductibleReset` may be "Empty"
 * for Anthem where UHC sets "plan". One schema, two automations - which is why
 * it lives in the domain's _shared package.
 */
export type Payload = GroupSubmissionPayload;

export function parsePayload(raw: unknown): Payload {
  return parseGroupSubmissionPayload(raw);
}
