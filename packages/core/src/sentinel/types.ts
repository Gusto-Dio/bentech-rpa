import type { SerializedError } from '../errors.ts';

/**
 * The sentinel's vocabulary.
 *
 * Two distinct questions, deliberately kept apart everywhere below:
 *
 *   FAILURE - a probe could not do what it set out to do.
 *   DRIFT   - a probe succeeded, but the screen is not the screen we recorded.
 *
 * Conflating them loses the more valuable half. Drift is the early warning: a
 * field renamed today breaks a run next week, and catching it while the probe
 * still passes is the difference between a scheduled fix and an incident.
 */

/** What a probe concluded. */
export type ProbeVerdict =
  /** Did what it set out to do. */
  | 'pass'
  /** Could not. Something is wrong with the portal or with our code. */
  | 'fail'
  /**
   * Could not LOOK - the lock was held, config was invalid, the MFA budget was
   * spent, a baseline was written by a different signature version.
   *
   * Deliberately not a failure. "We could not look" reported as "the portal is
   * broken" is how a monitor loses its audience.
   */
  | 'inconclusive';

/** How a field's value looked, without recording the value. */
export type FieldKind = 'empty' | 'text' | 'digits' | 'date' | 'email' | 'phone' | 'money';

/**
 * A screen, reduced to the things an automation actually addresses.
 *
 * Every string here has been through the redactor. `fields` carries labels and
 * a KIND, never a value, because baselines are committed and diffed in pull
 * requests and rule 2 applies to a tracked file whatever its extension.
 */
export interface ScreenSignature {
  /**
   * Bumped when the normalization rules change.
   *
   * A version mismatch makes a baseline `inconclusive`, never `drifted`.
   * Comparing a signature normalized under one rule set against a baseline
   * normalized under another produces confident nonsense, and the failure would
   * look exactly like real drift on every screen at once.
   */
  version: 1;
  /** Stable and human-chosen: 'ptb-login', 'ptb-dashboard', 'fulcrum-home'. */
  screenId: string;
  /**
   * Query VALUES are dropped and only the KEYS kept, sorted.
   *
   * A quote id, a Salesforce record id and a `c__ContextId` all change per
   * transaction while meaning the same screen. The keys are the structure; the
   * values are the instance.
   */
  location: { host: string; path: string; queryKeys: readonly string[] };
  /** The portal's own messages. Sorted and deduped. */
  alerts: readonly string[];
  /**
   * Wizard-rail entries with their status word stripped.
   *
   * The rail reads `Untouched` / `In Progress` / `Completed` and lags the actual
   * work by up to a minute, so the status is explicitly not comparable. The
   * LABELS are: a new rail entry is a new wizard step.
   */
  railLabels: readonly string[];
  fields: readonly { label: string; kind: FieldKind }[];
  buttons: readonly string[];
  modal: { present: boolean; text: string };
  /** Reported so a large structural change is obvious at a glance in a diff. */
  counts: { alerts: number; fields: number; buttons: number; rail: number };
}

/** A committed baseline, and where it came from. */
export interface ScreenBaseline {
  signature: ScreenSignature;
  provenance: {
    blessedAt: string;
    runId: string;
    probeId: string;
    signatureVersion: number;
    /**
     * Why this baseline was taken. Required, because a baseline with no note is
     * indistinguishable from one blessed to make a failing check go green.
     *
     * There is deliberately no `blessedBy`: the pull-request author is the
     * record, and an employee identifier in a tracked file is what rule 2 exists
     * to prevent.
     */
    note: string;
  };
}

export type SignatureKey = 'location' | 'alerts' | 'railLabels' | 'fields' | 'buttons' | 'modal';

export interface SignatureChange {
  key: SignatureKey;
  direction: 'added' | 'removed' | 'changed';
  /** Already redacted. */
  value: string;
  /**
   * Would this plausibly break an automation?
   *
   * Every difference is recorded either way - a report that hides what it
   * judged uninteresting cannot be argued with, and the judgement is a
   * heuristic, not a fact.
   */
  meaningful: boolean;
  /** Why it was judged noise, when it was. */
  noiseReason?: string;
}

export interface SignatureDelta {
  screenId: string;
  changes: readonly SignatureChange[];
  meaningful: boolean;
  /**
   * Counts only, e.g. `fields:+2,buttons:-1`.
   *
   * This, not the values, is what enters the fingerprint. A delta whose VALUES
   * vary run to run would otherwise mint a new fingerprint every cycle and file
   * an issue each time.
   */
  shape: string;
}

/** How a baseline comparison turned out. */
export type BaselineStatus = 'matched' | 'drifted' | 'absent' | 'version-mismatch';

/**
 * Facts about the machine, not the portal.
 *
 * Roughly half the known causes are runtime causes - a headless browser, a
 * missing display, an untrusted corporate CA - so a report without these
 * cannot distinguish "the portal changed" from "this box is misconfigured".
 */
export interface RuntimeFacts {
  headless: boolean;
  display: string | undefined;
  platform: string;
  inContainer: boolean;
  nodeVersion: string;
  gitCommit: string | undefined;
  hostname: string;
}

export interface StepTrace {
  step: string;
  gate: 'precondition' | 'postcondition' | undefined;
  outcome: 'skipped' | 'completed' | 'repaired' | 'failed';
  durationMs: number;
}

/**
 * What the probe did to the stored session, and whether it cost a code.
 *
 * This is the MFA audit trail. On this carrier a code takes a measured
 * 132-600s to arrive and expires on a countdown, so "did that run spend one?"
 * is a question the schedule has to be able to answer without an audit store.
 */
export interface SessionFacts {
  storedSessionPresent: boolean;
  storedSessionAgeMs: number | undefined;
  liveness: 'alive' | 'lapsed' | 'absent' | 'not-probed';
  signedInVia: 'reused' | 'password-and-mfa' | 'not-attempted';
  /**
   * A SAML re-challenge costs the PASSWORD only - the device is already
   * trusted, so Okta does not ask for a factor. It is therefore tracked
   * separately from `mfaCodeSpent`, because treating it as a code spend would
   * make the daily budget refuse work it can actually afford.
   */
  samlReauthenticated: boolean;
  mfaCodeSpent: boolean;
}

export interface ScreenObservation {
  screenId: string;
  signature: ScreenSignature;
  baseline: BaselineStatus;
  delta: SignatureDelta | undefined;
  /** Repo-relative path of the masked capture, when one was written. */
  maskedScreenshot: string | undefined;
}

/** Everything one probe run learned. The file a human and an agent both read. */
export interface ProbeEvidence {
  schemaVersion: 1;
  probeId: string;
  carrier: string;
  /** Same shape as a real run's id, so evidence sorts alongside `artifacts/`. */
  runId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  verdict: ProbeVerdict;
  runtime: RuntimeFacts;

  /** Every step in order. The last failed one is the headline. */
  steps: readonly StepTrace[];
  failedStep: string | undefined;
  failedGate: 'precondition' | 'postcondition' | undefined;

  /** From `serializeError`, whose `details` is already declared PII-free. */
  error: SerializedError | undefined;
  /**
   * The portal's own wording, and whether the repo's own classifier calls it a
   * complaint.
   *
   * Reusing `isPortalComplaint` rather than re-deriving it matters: that
   * function carries the scar tissue from a success toast being read as a
   * validation error, and from Anthem's real SIC rejection never matching at
   * all.
   */
  portalMessage: { text: string; isComplaint: boolean } | undefined;

  session: SessionFacts;
  screens: readonly ScreenObservation[];

  /**
   * HTTP status of the probe's main navigation, when it performed one.
   *
   * Only the credential-free access probe has a meaningful one - it is the
   * probe that answers "does the carrier serve us a page at all". Left
   * undefined elsewhere, because a status read partway through a signed-in
   * single-page app describes an XHR rather than the screen.
   *
   * Worth carrying separately from the signature: a 200 that renders an
   * interstitial and a 403 are different problems, and a status is not part of
   * what a screen LOOKS like, so putting it in the signature would report drift
   * every time a CDN changed its mind.
   */
  httpStatus: number | undefined;
}
