import { fingerprint, fingerprintPartsFrom, type FindingFingerprint, type FindingKind } from './fingerprint.ts';
import { matchKnownCause, type CauseMatch, type KnownCause } from './known-causes.ts';
import type { ProbeEvidence } from './types.ts';

/**
 * What to do about one probe run. Pure, ordered, first match wins.
 *
 * ── WHY A TABLE AND WHY PURE ────────────────────────────────────────────────
 * Every rule is named, and the name travels into the printed report and the
 * issue body. A monitor whose decisions cannot be explained gets muted, and
 * "why did this file an issue?" has to be answerable without reading the code.
 *
 * Pure, because the alternative is untestable. Reaching a given failure on this
 * carrier can cost a real production quote, so the only practical coverage is
 * synthetic evidence records - which is exactly the argument `portal-errors.ts`
 * already makes for keeping `isPortalComplaint` a pure exported function.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type TriageAction =
  /** Recorded, nothing filed. */
  | 'none'
  /** Selector or flow drift. A coding-agent session should act. */
  | 'healable-issue'
  /** Still passing, but the screen moved. Pre-emptive, low priority. */
  | 'drift-issue'
  /** The environment is wrong. No code change fixes it. */
  | 'infra-issue'
  /** A person must act. */
  | 'human-issue';

export interface TriageResult {
  action: TriageAction;
  /** The rule that matched, by name. Printed, and put in the issue. */
  ruleId: string;
  /** One sentence a human can disagree with. */
  rationale: string;
  cause: KnownCause | undefined;
  fingerprint: FindingFingerprint;
  /** `AGENTS.md` rule numbers the reader - human or agent - must know. */
  rules: readonly string[];
}

export interface TriageOptions {
  /** Generic causes concatenated with the carrier's own. Order is behaviour. */
  causes: readonly KnownCause[];
  /** Is the sentinel switched off? Checked here so the reason is reported, not implied. */
  disabled?: boolean;
  /**
   * Set when the probe could not look at all - the lock was held, the MFA
   * budget was spent, config was invalid.
   */
  couldNotRun?: string;
}

/**
 * Rules every reader needs regardless of the finding.
 *
 * 10a because a session that does not know the freeze exists may try to verify
 * a fix by running the automation, which creates a real account and a real
 * quote. 2 because everything the sentinel writes is read by something that
 * might publish it.
 */
const ALWAYS_RULES: readonly string[] = ['10a', '2'];

export function triage(evidence: ProbeEvidence, options: TriageOptions): TriageResult {
  const parts = fingerprintPartsFrom(evidence);
  const decide = (
    action: TriageAction,
    ruleId: string,
    rationale: string,
    kind: FindingKind,
    extra: { cause?: CauseMatch; rules?: readonly string[] } = {},
  ): TriageResult => ({
    action,
    ruleId,
    rationale,
    cause: extra.cause?.cause,
    fingerprint: fingerprint({ ...parts, kind, causeId: extra.cause?.cause.id }),
    rules: [...new Set([...ALWAYS_RULES, ...(extra.rules ?? [])])],
  });

  // ── 1. Off, and saying so. ──
  if (options.disabled === true) {
    return decide('none', 'disabled', 'The sentinel is switched off.', 'infra');
  }

  /**
   * ── 2. We could not LOOK. ──
   * Deliberately not a failure and deliberately files nothing on its own.
   * "We could not look" reported as "the portal is broken" is how a monitor
   * loses its audience, and a sentinel that files issues about its own
   * environment is noise with extra steps. Persistence is what makes it real,
   * and the caller counts occurrences.
   */
  if (options.couldNotRun !== undefined) {
    return decide(
      'none',
      'could-not-run',
      `The probe could not run: ${options.couldNotRun}. Not a portal verdict.`,
      'infra',
    );
  }

  const matched = matchKnownCause(evidence, options.causes);
  const drifted = evidence.screens.find((screen) => screen.delta?.meaningful === true);
  const unbaselined = evidence.screens.find((screen) => screen.baseline === 'absent');
  const mismatched = evidence.screens.find((screen) => screen.baseline === 'version-mismatch');

  // ── 3. A baseline from a different normalization version proves nothing. ──
  if (mismatched !== undefined) {
    return decide(
      'none',
      'baseline-version-mismatch',
      `The baseline for "${mismatched.screenId}" was written under a different signature version. ` +
        'Comparing across versions produces confident nonsense, so this is inconclusive rather ' +
        'than drift. Re-bless the baselines in one reviewed pull request.',
      'infra',
    );
  }

  if (evidence.verdict === 'pass') {
    // ── 4. Passed, and the screens are the screens we recorded. ──
    if (unbaselined === undefined && drifted === undefined) {
      return decide('none', 'pass-clean', 'The probe passed and every screen matched its baseline.', 'drift');
    }

    /**
     * ── 5. Passed, but we have never recorded this screen. ──
     * The sentinel's analogue of `describeCurrentScreen`: arriving somewhere
     * unmapped is itself the finding, because the next thing the automation
     * does there is undefined.
     */
    if (unbaselined !== undefined) {
      return decide(
        'healable-issue',
        'pass-unknown-screen',
        `The probe reached "${unbaselined.screenId}", which has no baseline. Either the screen is ` +
          'new, or a screen we do know changed enough to be unrecognisable.',
        'unknown-screen',
        { rules: ['5'] },
      );
    }

    /**
     * ── 6. Passed, but the screen moved. THE EARLY WARNING. ──
     * This is the case that pays for the whole design: a field renamed today
     * breaks a run next week, and catching it while the probe still passes is
     * the difference between a scheduled fix and an incident.
     */
    return decide(
      'drift-issue',
      'pass-drift',
      `The probe passed, but "${drifted?.screenId}" no longer matches its baseline ` +
        `(${drifted?.delta?.shape}). Nothing is broken yet.`,
      'drift',
      { rules: ['5'] },
    );
  }

  // ── 7. A locked account is a person's problem, and a known cause says so. ──
  if (matched?.cause.action === 'human') {
    return decide('human-issue', 'known-cause-human', matched.cause.remedy, 'human', { cause: matched });
  }

  /**
   * ── 8. THE MOST IMPORTANT ROW. A Business failure is not a bug. ──
   *
   * Rule 1: the portal looked at what we sent and refused it. No retry and no
   * code change will alter that answer, so filing a healing issue would send an
   * agent to "fix" correct behaviour - and on this carrier the agent would be
   * editing an automation that files real applications.
   *
   * It is checked AFTER the human-cause row because a lockout also surfaces as
   * a Business failure, and a locked account does need a person.
   */
  if (evidence.error?.reason === 'business') {
    return decide(
      'none',
      'business-rejection',
      'The portal rejected the data on its own terms, which is a Business failure: not a code ' +
        'defect, never retried, and not something a repair session should touch. ' +
        (evidence.portalMessage?.text === undefined
          ? ''
          : `The portal said: "${evidence.portalMessage.text}"`),
      'failure',
      { cause: matched, rules: ['1'] },
    );
  }

  // ── 9. Documented, self-correcting, or an invocation mistake. ──
  if (matched?.cause.action === 'none') {
    return decide('none', 'known-cause-none', matched.cause.remedy, 'infra', { cause: matched });
  }

  // ── 10. The environment. No code change fixes it, so never `healable`. ──
  if (matched?.cause.action === 'infra') {
    return decide('infra-issue', 'known-cause-infra', matched.cause.remedy, 'infra', { cause: matched });
  }

  // ── 11. A known cause we already believe is our code's fault. ──
  if (matched?.cause.action === 'healable') {
    return decide('healable-issue', 'known-cause-healable', matched.cause.remedy, 'failure', {
      cause: matched,
      rules: ['5', '9b'],
    });
  }

  /**
   * ── 12. THE STRONGEST SIGNAL IN THE SYSTEM. ──
   * A named gate failed AND that screen moved. The two halves corroborate each
   * other: we know where it broke and we know what changed underneath it. This
   * is the finding a repair session can act on with the least guessing.
   */
  if (evidence.failedStep !== undefined && drifted !== undefined) {
    return decide(
      'healable-issue',
      'gate-failed-screen-drifted',
      `The "${evidence.failedStep}" ${evidence.failedGate ?? 'step'} failed and "${drifted.screenId}" ` +
        `also moved (${drifted.delta?.shape}). The gate and the screen agree that something changed.`,
      'failure',
      { rules: ['1', '5', '9b'] },
    );
  }

  /**
   * ── 13. A gate failed, but the screen is exactly as recorded. ──
   * So the screen did not change - which means either the locator was always
   * wrong and only now got unlucky, or the question was asked wrong (a gate
   * that does not wait, or one whose budget the step silently truncates).
   * Still healable, but it deserves persistence before anyone is called out.
   */
  if (evidence.failedStep !== undefined) {
    return decide(
      'healable-issue',
      'gate-failed-screen-matched',
      `The "${evidence.failedStep}" ${evidence.failedGate ?? 'step'} failed on a screen that still ` +
        'matches its baseline. The screen did not change, so suspect the locator or the way the ' +
        'question is asked before suspecting the portal.',
      'failure',
      { rules: ['1', '5', '9b'] },
    );
  }

  // ── 14. It fell over before any step ran. Usually the environment. ──
  if (evidence.steps.length === 0) {
    return decide(
      'infra-issue',
      'failed-before-any-step',
      'The probe failed before its first step, so it never reached the portal logic. That is ' +
        'almost always the browser, the network or the certificate chain rather than a selector.',
      'infra',
    );
  }

  /**
   * ── 15. The table could not explain it. ──
   * A human, not a healing session. A finding this table cannot classify is
   * itself worth someone looking at the table - and guessing `healable` here
   * would point an agent at an automation with no idea what is wrong.
   */
  return decide(
    'human-issue',
    'unclassified',
    'The probe failed in a way the triage table does not recognise. That is worth a human reading ' +
      'both the evidence and the table, rather than a repair session guessing.',
    'failure',
    { rules: ['1'] },
  );
}

/** Does this action put something in front of a person? */
export function filesAnIssue(action: TriageAction): boolean {
  return action !== 'none';
}
