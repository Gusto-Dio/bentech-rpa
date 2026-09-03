import {
  parseGroupSubmissionPayload,
  type GroupSubmissionPayload,
} from '@auto/group-submission-shared';

/**
 * UHC consumes the shared group-submission payload unchanged.
 *
 * The carrier-specific parts are data: `policies` carries UHC plan codes
 * (EPHE-L31S, EPG7-L31S) and `medicalDeductibleReset` is typically "plan" where
 * Anthem may be "Empty". One schema, two automations.
 */
export type Payload = GroupSubmissionPayload;

export function parsePayload(raw: unknown): Payload {
  return parseGroupSubmissionPayload(raw);
}
