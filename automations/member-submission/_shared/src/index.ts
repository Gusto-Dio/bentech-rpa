/**
 * Shared code for the Member Submission domain.
 *
 * Importable only by automations under automations/member-submission/ -
 * enforced by `rpa validate`.
 */
export const DOMAIN = 'member-submission';

export { parseDelimited, type DelimitedOptions } from './delimited.ts';
export {
  assertFirstOfMonth,
  assertKnownPlanCode,
  assertWithinEnrollmentWindow,
} from './eligibility.ts';
