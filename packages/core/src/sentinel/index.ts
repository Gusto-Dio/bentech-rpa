/**
 * The sentinel: portal monitoring that distinguishes FAILURE from DRIFT.
 *
 * Re-exported from `@rpa/core`'s own index, so an automation's probe module
 * imports it the same way it imports `step()` - deep imports into these files
 * are blocked by `rpa validate` for the same reason as everywhere else.
 *
 * Nothing here knows a carrier. Probes, carrier-specific known causes and the
 * committed baselines live beside the automation they belong to, and are handed
 * in. That is what keeps this shippable at a hundred automations.
 */

export { createRedactor, type Redactor, type RedactorOptions } from './redact.ts';

export {
  SIGNATURE_VERSION,
  buildSignature,
  findLeak,
  type RawScreenInput,
  type SignatureOptions,
} from './signature.ts';

export { diffSignatures } from './delta.ts';

export {
  fingerprint,
  fingerprintMarker,
  fingerprintPartsFrom,
  readFingerprintMarker,
  type FindingFingerprint,
  type FindingKind,
  type FingerprintInput,
} from './fingerprint.ts';

export {
  BOT_REFUSAL_PATTERNS,
  GENERIC_CAUSES,
  matchKnownCause,
  type CauseAction,
  type CauseMatch,
  type KnownCause,
} from './known-causes.ts';

export { filesAnIssue, triage, type TriageAction, type TriageOptions, type TriageResult } from './triage.ts';

export {
  driftLogTerms,
  parseDriftLog,
  scoreDriftLogRows,
  type DriftLogRow,
  type ScoredDriftLogRow,
} from './drift-log.ts';

export { GOTCHA_HINTS, resolveRules, type RuleReference } from './rule-map.ts';

export {
  IssueBodyLeak,
  renderIssueBody,
  renderIssueTitle,
  type IssueBodyInput,
} from './issue-body.ts';

export type {
  BaselineStatus,
  FieldKind,
  ProbeEvidence,
  ProbeVerdict,
  RuntimeFacts,
  ScreenBaseline,
  ScreenObservation,
  ScreenSignature,
  SessionFacts,
  SignatureChange,
  SignatureDelta,
  SignatureKey,
  StepTrace,
} from './types.ts';

export {
  GitHubError,
  GitHubIssuesClient,
  findByFingerprint,
  isBeingWorkedOn,
  type CreateIssueInput,
  type GitHubIssuesClientOptions,
  type IssueRef,
} from './github.ts';

export {
  LABEL_DEFINITIONS,
  SENTINEL_LABELS,
  carrierLabel,
  probeLabel,
  type LabelDefinition,
} from './labels.ts';

export {
  decideFiling,
  labelsFor,
  recurrenceComment,
  stormIssue,
  type FilingDecision,
  type FilingInput,
} from './filing.ts';
