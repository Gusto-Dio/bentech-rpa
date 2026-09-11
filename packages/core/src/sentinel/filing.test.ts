import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SentinelConfig } from '../config/schema.ts';
import { decideFiling, labelsFor, recurrenceComment, stormIssue } from './filing.ts';
import { fingerprintMarker, type FindingFingerprint } from './fingerprint.ts';
import type { IssueRef } from './github.ts';
import { SENTINEL_LABELS, probeLabel } from './labels.ts';
import type { FingerprintRecord } from './state.ts';
import type { TriageAction, TriageResult } from './triage.ts';

const PROBE = 'anthem-ca/portal-navigation';
const HASH = 'abc123abc123';

function config(overrides: Partial<SentinelConfig> = {}): SentinelConfig {
  return {
    enabled: true,
    githubTokenEnv: 'SENTINEL_GITHUB_TOKEN',
    repo: 'Gusto/bentech-rpa',
    fileIssues: true,
    minConsecutiveFailures: 2,
    perFingerprintCooldownMs: 6 * 60 * 60 * 1_000,
    maxNewIssuesPer24h: 3,
    maxOpenHealableIssuesPerProbe: 1,
    maxMfaPerDay: 1,
    lockStaleAfterMs: 30 * 60 * 1_000,
    evidenceRetentionDays: 14,
    ...overrides,
  };
}

function fp(hash = HASH): FindingFingerprint {
  return {
    version: 1,
    probeId: PROBE,
    kind: 'failure',
    screenId: 'ptb-dashboard',
    step: 'reach the quoting platform',
    gate: 'precondition',
    errorClass: 'SystemException',
    causeId: undefined,
    deltaShape: 'buttons:-1',
    hash,
  };
}

function verdict(action: TriageAction, hash = HASH): TriageResult {
  return {
    action,
    ruleId: 'gate-failed-screen-drifted',
    rationale: 'the gate and the screen agree',
    cause: undefined,
    fingerprint: fp(hash),
    rules: ['10a', '2'],
  };
}

function record(overrides: Partial<FingerprintRecord> = {}): FingerprintRecord {
  return { firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-11T00:00:00.000Z', occurrences: 5, streak: 3, ...overrides };
}

function issue(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    number: 42,
    title: 'a finding',
    body: `prose\n\n${fingerprintMarker(fp())}\n`,
    labels: [SENTINEL_LABELS.all, SENTINEL_LABELS.healable, probeLabel(PROBE)],
    assignees: [],
    hasLinkedPullRequest: false,
    ...overrides,
  };
}

function decide(overrides: Partial<Parameters<typeof decideFiling>[0]> = {}) {
  return decideFiling({
    triage: verdict('healable-issue'),
    probeId: PROBE,
    carrier: 'anthem-ca',
    record: record(),
    openIssues: [],
    newIssuesToday: 0,
    config: config(),
    now: new Date('2026-09-11T12:00:00Z'),
    ...overrides,
  });
}

describe('decideFiling - nothing to say', () => {
  it('skips a finding triage decided files nothing', () => {
    const result = decide({ triage: verdict('none') });
    assert.equal(result.action, 'skip');
    assert.match(result.reason, /files nothing/);
  });
});

describe('decideFiling - persistence before escalation', () => {
  /**
   * At ninety-six access runs a day, filing on first sight would mostly report
   * flapping rather than breakage.
   */
  it('waits for the consecutive threshold before filing', () => {
    const result = decide({ record: record({ streak: 1 }) });
    assert.equal(result.action, 'skip');
    assert.match(result.reason, /below the threshold of 2/);
  });

  it('files once the threshold is met', () => {
    const result = decide({ record: record({ streak: 2 }) });
    assert.equal(result.action, 'file');
  });

  /**
   * Drift is exempt: a screen does not change back, so one sighting of
   * meaningful drift is a durable fact rather than a flake.
   */
  it('files drift on the first sighting', () => {
    const result = decide({ triage: verdict('drift-issue'), record: record({ streak: 1 }) });
    assert.equal(result.action, 'file');
  });
});

describe('decideFiling - the same finding again', () => {
  it('comments rather than filing a second issue', () => {
    const result = decide({ openIssues: [issue()] });
    assert.equal(result.action, 'comment');
    assert.equal(result.action === 'comment' ? result.issueNumber : 0, 42);
  });

  it('stays quiet inside the cooldown', () => {
    const result = decide({
      openIssues: [issue()],
      record: record({ cooldownUntil: '2026-09-11T18:00:00.000Z' }),
    });
    assert.equal(result.action, 'skip');
    assert.match(result.reason, /within its 6h cooldown/);
  });

  it('comments again once the cooldown has passed', () => {
    const result = decide({
      openIssues: [issue()],
      record: record({ cooldownUntil: '2026-09-11T06:00:00.000Z' }),
    });
    assert.equal(result.action, 'comment');
  });

  /**
   * The sentinel commenting "still failing" on an issue somebody is actively
   * fixing is noise at best; at worst it argues with the repair session.
   */
  it('says nothing when someone is already on it', () => {
    for (const held of [
      issue({ assignees: ['someone'] }),
      issue({ hasLinkedPullRequest: true }),
      issue({ labels: [SENTINEL_LABELS.healingInProgress] }),
    ]) {
      const result = decide({ openIssues: [held] });
      assert.equal(result.action, 'skip');
      assert.match(result.reason, /already being worked on/);
    }
  });
});

describe('decideFiling - the rule-11 analogue', () => {
  /**
   * Rule 11 exists because two layers retrying one transaction turned three
   * attempts into nine real carrier submissions. The same shape applies here:
   * two open healable issues for one probe means two repair sessions editing
   * the same page objects.
   */
  it('adds a NEW fingerprint to the probe\'s existing healable issue instead of opening a second', () => {
    const result = decide({
      triage: verdict('healable-issue', 'ffffffffffff'),
      openIssues: [issue()],
    });

    assert.equal(result.action, 'comment');
    assert.equal(result.action === 'comment' ? result.issueNumber : 0, 42);
    assert.match(result.reason, /already has an open healable issue/);
    assert.match(result.reason, /two\s+repair sessions cannot edit the same page objects/);
  });

  it('counts only issues for the SAME probe against the cap', () => {
    const other = issue({ number: 9, labels: [SENTINEL_LABELS.all, SENTINEL_LABELS.healable, 'probe:portal-access'] });
    const result = decide({ triage: verdict('healable-issue', 'ffffffffffff'), openIssues: [other] });
    assert.equal(result.action, 'file');
  });

  it('does not apply the healable cap to a drift finding', () => {
    const result = decide({ triage: verdict('drift-issue', 'ffffffffffff'), openIssues: [issue()] });
    assert.equal(result.action, 'file');
  });

  it('honours a raised per-probe cap', () => {
    const result = decide({
      triage: verdict('healable-issue', 'ffffffffffff'),
      openIssues: [issue()],
      config: config({ maxOpenHealableIssuesPerProbe: 2 }),
    });
    assert.equal(result.action, 'file');
  });
});

describe('decideFiling - the daily cap', () => {
  it('stops filing once the cap is spent, and says the finding is not lost', () => {
    const result = decide({ newIssuesToday: 3 });
    assert.equal(result.action, 'skip');
    assert.match(result.reason, /daily cap of 3/);
    assert.match(result.reason, /recorded in state and will be filed once the cap resets/);
  });

  it('files while the cap has room', () => {
    assert.equal(decide({ newIssuesToday: 2 }).action, 'file');
  });
});

describe('labelsFor', () => {
  it('marks a healable finding as agent-ready', () => {
    const labels = labelsFor('healable-issue', PROBE, 'anthem-ca');
    assert.ok(labels.includes(SENTINEL_LABELS.healable));
    assert.ok(labels.includes(SENTINEL_LABELS.agentReady));
  });

  /**
   * `agent-ready` is the handoff contract. A repair session picking up an infra
   * or human issue would be asked to fix something no code change can fix.
   */
  it('never marks an infra or human finding agent-ready', () => {
    for (const action of ['infra-issue', 'human-issue', 'drift-issue'] as const) {
      assert.equal(labelsFor(action, PROBE, 'anthem-ca').includes(SENTINEL_LABELS.agentReady), false);
    }
  });

  it('always carries the dedup label and the routing labels', () => {
    for (const action of ['healable-issue', 'drift-issue', 'infra-issue', 'human-issue', 'none'] as const) {
      const labels = labelsFor(action, PROBE, 'anthem-ca');
      assert.ok(labels.includes(SENTINEL_LABELS.all), `${action} must carry the dedup label`);
      assert.ok(labels.includes('carrier:anthem-ca'));
      assert.ok(labels.includes('probe:portal-navigation'));
    }
  });

  /** Visible in a list view, where the body is not. */
  it('puts the freeze warning on every Anthem finding', () => {
    assert.ok(labelsFor('healable-issue', PROBE, 'anthem-ca').includes(SENTINEL_LABELS.frozen));
    assert.equal(
      labelsFor('healable-issue', 'uhc-np/portal-access', 'uhc-np').includes(SENTINEL_LABELS.frozen),
      false,
    );
  });
});

describe('recurrenceComment', () => {
  it('states the counts and where the evidence is, and how to make it stop', () => {
    const body = recurrenceComment({
      record: record({ occurrences: 7, streak: 4 }),
      evidenceDir: 'artifacts/sentinel/x/y',
      runId: 'run-9',
      reason: 'still failing after 7 sightings',
    });

    assert.match(body, /Occurrences \| 7/);
    assert.match(body, /Consecutive \| 4/);
    assert.match(body, /artifacts\/sentinel\/x\/y/);
    assert.match(body, /sentinel:healing-in-progress/);
  });
});

describe('stormIssue', () => {
  /** A rate limit that produces silence is indistinguishable from a healthy portal. */
  it('announces that findings are being suppressed', () => {
    const storm = stormIssue({ suppressed: 9, cap: 3, probeIds: [PROBE] });

    assert.match(storm.title, /rate limit hit - 9 finding\(s\) suppressed/);
    assert.match(storm.body, /a quiet monitor is indistinguishable from a healthy portal/);
    assert.match(storm.body, /nothing is lost/);
    assert.ok(storm.labels.includes(SENTINEL_LABELS.storm));
  });
});
