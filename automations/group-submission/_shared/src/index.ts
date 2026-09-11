/**
 * Shared code for the Group Submission domain.
 *
 * Importable only by automations under automations/group-submission/ -
 * enforced by `rpa validate`, so member-submission cannot quietly grow a
 * dependency on a carrier portal it does not use.
 */
export const DOMAIN = 'group-submission';

// ── The demo automation's portal (saucedemo). Reference implementation. ──
export { PortalLoginPage } from './portal-login.page.ts';
export { assertHasRequestedItems, assertValidGroupId } from './rules.ts';

// ── The real carrier submissions ──
export {
  assertOwnershipTotals100,
  contactSchema,
  findBasePolicy,
  groupSubmissionPayloadSchema,
  ownerSchema,
  parseGroupSubmissionPayload,
  policySchema,
  type Contact,
  type GroupSubmissionPayload,
  type Owner,
  type Policy,
} from './group-submission-payload.ts';

export {
  classifyPortalError,
  createCarrierPortalSession,
  probeStoredSession,
  type CarrierLoginFlow,
  type CarrierPortalSession,
  type CarrierPortalSessionOptions,
  type SignInOutcome,
  type StoredSessionLiveness,
} from './carrier-portal-session.ts';

export {
  HIPPO_CENSUS_COLUMNS,
  WAIVER_REASON_TO_UHC,
  relationshipSchema,
  type CensusReader,
  type HippoCensusColumn,
  type HippoCensusRow,
  type SplitCensus,
} from './census/hippo-census.ts';

export { HippoCensusReader, excelSerialToIsoDate, splitCsvLine } from './census/hippo-census-reader.ts';

// ── Salesforce Lightning / Vlocity, shared by every automation on that platform ──
export {
  DOCUMENT_TIMEOUT_MS,
  FIELD_TIMEOUT_MS,
  RAIL_POLL_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
  answer,
  answerIfPresent,
  button,
  check,
  choose,
  chosen,
  dismissModal,
  field,
  isAnswered,
  isSelected,
  picker,
  question,
  sameDigits,
  select,
  selected,
  stepIs,
  type,
  typeahead,
} from './lightning.ts';
