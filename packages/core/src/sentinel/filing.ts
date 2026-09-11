import type { SentinelConfig } from '../config/schema.ts';
import { findByFingerprint, isBeingWorkedOn, type IssueRef } from './github.ts';
import { SENTINEL_LABELS, carrierLabel, probeLabel } from './labels.ts';
import type { TriageAction, TriageResult } from './triage.ts';
import type { FingerprintRecord } from './state.ts';

/**
 * Whether to file, comment, or stay quiet - decided as a pure function.
 *
 * ── WHY THIS IS SEPARATE FROM TRIAGE ────────────────────────────────────────
 * Triage answers "what kind of finding is this?". This answers "has anyone been
 * told yet, and should they be told again?". Keeping them apart means the
 * decision to file can be rate-limited, capped and unit-tested without touching
 * the classification - and a change to a threshold cannot accidentally change
 * what a finding IS.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type FilingDecision =
  | { action: 'file'; labels: readonly string[]; reason: string }
  | { action: 'comment'; issueNumber: number; reason: string }
  | { action: 'skip'; reason: string };

export interface FilingInput {
  triage: TriageResult;
  probeId: string;
  carrier: string;
  /** This fingerprint's record, after the current sighting was recorded. */
  record: FingerprintRecord;
  /** Every currently-open sentinel issue, already fetched once for the run. */
  openIssues: readonly IssueRef[];
  /** How many issues the sentinel has filed today. */
  newIssuesToday: number;
  config: SentinelConfig;
  now?: Date;
}

export function decideFiling(input: FilingInput): FilingDecision {
  const { triage, record, config } = input;
  const now = input.now ?? new Date();

  if (triage.action === 'none') {
    return { action: 'skip', reason: `triage rule "${triage.ruleId}" files nothing` };
  }

  const existing = findByFingerprint(input.openIssues, triage.fingerprint.hash);

  if (existing !== undefined) {
    /**
     * Someone is on it. The sentinel adding "still failing" to an issue a
     * person or a repair session is actively working is noise at best, and at
     * worst it argues with the session that is fixing it.
     */
    if (isBeingWorkedOn(existing, SENTINEL_LABELS.healingInProgress)) {
      return {
        action: 'skip',
        reason: `#${existing.number} is already being worked on`,
      };
    }

    const cooldownUntil =
      record.cooldownUntil === undefined ? 0 : Date.parse(record.cooldownUntil);

    if (Number.isFinite(cooldownUntil) && now.getTime() < cooldownUntil) {
      return {
        action: 'skip',
        reason: `#${existing.number} is within its ${humanMs(config.perFingerprintCooldownMs)} cooldown`,
      };
    }

    return {
      action: 'comment',
      issueNumber: existing.number,
      reason: `still failing after ${record.occurrences} sightings`,
    };
  }

  /**
   * Persistence before escalation. One transient 502, or a single slow render,
   * must not file anything - and at ninety-six access runs a day a
   * file-on-first-sight policy would mostly report flapping.
   *
   * Drift is exempt: a screen does not change back, so a single sighting of
   * meaningful drift is already a durable fact rather than a flake.
   */
  if (triage.action !== 'drift-issue' && record.streak < config.minConsecutiveFailures) {
    return {
      action: 'skip',
      reason: `seen ${record.streak}x consecutively, below the threshold of ${config.minConsecutiveFailures}`,
    };
  }

  /**
   * ── THE RULE-11 ANALOGUE ───────────────────────────────────────────────────
   * At most one open healable issue per probe. Rule 11 exists because two
   * layers retrying one transaction turned three attempts into nine real
   * carrier submissions; the same shape applies here. Two open healable issues
   * for one probe means two repair sessions editing the same page objects, and
   * the second one's PR would be written against a working tree the first one
   * had already changed.
   *
   * A different fingerprint for a probe that already has an open finding gets a
   * COMMENT on that finding, not a second issue.
   */
  if (triage.action === 'healable-issue') {
    const openForProbe = input.openIssues.filter(
      (issue) =>
        issue.labels.includes(SENTINEL_LABELS.healable) &&
        issue.labels.includes(probeLabel(input.probeId)),
    );

    if (openForProbe.length >= config.maxOpenHealableIssuesPerProbe) {
      const first = openForProbe[0];
      if (first === undefined) {
        return { action: 'skip', reason: 'the per-probe healable cap is zero' };
      }
      return {
        action: 'comment',
        issueNumber: first.number,
        reason:
          `${input.probeId} already has an open healable issue (#${first.number}); adding a new ` +
          `fingerprint ${triage.fingerprint.hash} to it rather than opening a second, so two ` +
          'repair sessions cannot edit the same page objects at once',
      };
    }
  }

  /**
   * The daily cap, and the reason it is not silent.
   *
   * A portal-wide outage produces a distinct fingerprint per probe per screen,
   * and filing all of them is exactly the storm this guards against. But a cap
   * that just stops filing makes the sentinel look healthy while it is
   * suppressing findings - so the caller files ONE `sentinel:storm` issue and
   * exits non-zero.
   */
  if (input.newIssuesToday >= config.maxNewIssuesPer24h) {
    return {
      action: 'skip',
      reason:
        `the daily cap of ${config.maxNewIssuesPer24h} new issues is spent - this finding is ` +
        'recorded in state and will be filed once the cap resets. Raise a storm issue instead.',
    };
  }

  return {
    action: 'file',
    labels: labelsFor(triage.action, input.probeId, input.carrier),
    reason: `new finding, seen ${record.streak}x consecutively`,
  };
}

/**
 * Labels for a finding.
 *
 * `agent-ready` is applied ONLY alongside `healable`. It is the handoff contract
 * to the repair half: a session that picks up an infra or human issue would be
 * asked to fix something no code change can fix.
 */
export function labelsFor(
  action: TriageAction,
  probeId: string,
  carrier: string,
): readonly string[] {
  const base = [SENTINEL_LABELS.all, carrierLabel(carrier), probeLabel(probeId)];

  /** Anthem is the frozen one, and the warning belongs where a list view shows it. */
  if (carrier.startsWith('anthem')) base.push(SENTINEL_LABELS.frozen);

  switch (action) {
    case 'healable-issue':
      return [...base, SENTINEL_LABELS.healable, SENTINEL_LABELS.agentReady];
    case 'drift-issue':
      return [...base, SENTINEL_LABELS.drift];
    case 'infra-issue':
      return [...base, SENTINEL_LABELS.infra];
    case 'human-issue':
      return [...base, SENTINEL_LABELS.human];
    case 'none':
      return base;
  }
}

/** `21600000` is not a duration a human reads. */
function humanMs(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1_000)}s`;
}

/** The comment body for a recurrence. Short on purpose - the issue carries the detail. */
export function recurrenceComment(input: {
  record: FingerprintRecord;
  evidenceDir: string;
  runId: string;
  reason: string;
}): string {
  return [
    `Still present. ${input.reason}.`,
    '',
    `| | |`,
    `|---|---|`,
    `| Occurrences | ${input.record.occurrences} |`,
    `| Consecutive | ${input.record.streak} |`,
    `| First seen | ${input.record.firstSeen} |`,
    `| Latest run | \`${input.runId}\` |`,
    '',
    `Latest evidence on the sentinel host: \`${input.evidenceDir}\``,
    '',
    '_Assign yourself, link a pull request, or add `sentinel:healing-in-progress` and the sentinel',
    'will stop commenting on this._',
  ].join('\n');
}

/**
 * The storm issue.
 *
 * Filed at most once a day, and the whole point is that the cap announces
 * itself. A rate limit that produces silence is indistinguishable from a
 * healthy portal.
 */
export function stormIssue(input: {
  suppressed: number;
  cap: number;
  probeIds: readonly string[];
}): { title: string; body: string; labels: readonly string[] } {
  return {
    title: `[sentinel] rate limit hit - ${input.suppressed} finding(s) suppressed`,
    body: [
      '## The sentinel hit its own rate limit',
      '',
      `It wanted to file ${input.suppressed} new issue(s) and its daily cap is ${input.cap}.`,
      'The remaining findings are recorded in the local state and will be filed once the cap',
      'resets, so nothing is lost - but until then the sentinel is suppressing findings, and',
      'a quiet monitor is indistinguishable from a healthy portal. Hence this issue.',
      '',
      `Probes involved: ${input.probeIds.map((id) => `\`${id}\``).join(', ')}`,
      '',
      'Either the portal has changed substantially, or the thresholds in `config/platform.json`',
      'under `sentinel` need calibrating for what this portal actually does.',
    ].join('\n'),
    labels: [SENTINEL_LABELS.all, SENTINEL_LABELS.storm],
  };
}
