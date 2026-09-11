import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fingerprint, readFingerprintMarker, fingerprintMarker } from './fingerprint.ts';
import { GENERIC_CAUSES, matchKnownCause, type KnownCause } from './known-causes.ts';
import { triage } from './triage.ts';
import type { ProbeEvidence, ScreenObservation, ScreenSignature, SignatureDelta } from './types.ts';

function signature(overrides: Partial<ScreenSignature> = {}): ScreenSignature {
  return {
    version: 1,
    screenId: 'ptb-login',
    location: { host: 'portal.example', path: '/apps/ptb/login', queryKeys: [] },
    alerts: [],
    railLabels: [],
    fields: [{ label: 'Username', kind: 'empty' }],
    buttons: ['Login'],
    modal: { present: false, text: '' },
    counts: { alerts: 0, fields: 1, buttons: 1, rail: 0 },
    ...overrides,
  };
}

function delta(overrides: Partial<SignatureDelta> = {}): SignatureDelta {
  return {
    screenId: 'ptb-login',
    changes: [{ key: 'fields', direction: 'removed', value: 'Username', meaningful: true }],
    meaningful: true,
    shape: 'fields:-1',
    ...overrides,
  };
}

function screen(overrides: Partial<ScreenObservation> = {}): ScreenObservation {
  return {
    screenId: 'ptb-login',
    signature: signature(),
    baseline: 'matched',
    delta: undefined,
    maskedScreenshot: undefined,
    ...overrides,
  };
}

function evidence(overrides: Partial<ProbeEvidence> = {}): ProbeEvidence {
  return {
    schemaVersion: 1,
    probeId: 'anthem-ca/portal-access',
    carrier: 'anthem-ca',
    runId: '20260910T140211Z-a1b2c3',
    startedAt: '2026-09-10T14:02:11.000Z',
    endedAt: '2026-09-10T14:02:41.000Z',
    durationMs: 30_000,
    verdict: 'pass',
    runtime: {
      headless: false,
      display: ':99',
      platform: 'linux/x64',
      inContainer: true,
      nodeVersion: 'v24.0.0',
      gitCommit: 'dfaa653',
      hostname: 'sentinel-host',
    },
    steps: [{ step: 'load the login page', gate: undefined, outcome: 'completed', durationMs: 1200 }],
    failedStep: undefined,
    failedGate: undefined,
    error: undefined,
    portalMessage: undefined,
    session: {
      storedSessionPresent: true,
      storedSessionAgeMs: 3_600_000,
      liveness: 'alive',
      signedInVia: 'reused',
      samlReauthenticated: false,
      mfaCodeSpent: false,
    },
    screens: [screen()],
    httpStatus: 200,
    ...overrides,
  };
}

const options = { causes: GENERIC_CAUSES };

describe('triage - the sentinel talking about itself', () => {
  it('reports being switched off, distinctly from being broken', () => {
    const result = triage(evidence(), { ...options, disabled: true });
    assert.equal(result.action, 'none');
    assert.equal(result.ruleId, 'disabled');
  });

  /**
   * "We could not look" reported as "the portal is broken" is how a monitor
   * loses its audience. It also must not file an issue about its own
   * environment on a single occurrence.
   */
  it('files nothing when it could not look at all', () => {
    const result = triage(evidence({ verdict: 'inconclusive' }), {
      ...options,
      couldNotRun: 'the portal lock was held by pid 4210',
    });
    assert.equal(result.action, 'none');
    assert.equal(result.ruleId, 'could-not-run');
    assert.match(result.rationale, /Not a portal verdict/);
  });

  /** Comparing across normalization versions produces confident nonsense. */
  it('treats a version-mismatched baseline as inconclusive, never as drift', () => {
    const result = triage(
      evidence({ screens: [screen({ baseline: 'version-mismatch' })] }),
      options,
    );
    assert.equal(result.action, 'none');
    assert.equal(result.ruleId, 'baseline-version-mismatch');
  });
});

describe('triage - the probe passed', () => {
  it('files nothing when every screen matched', () => {
    const result = triage(evidence(), options);
    assert.equal(result.action, 'none');
    assert.equal(result.ruleId, 'pass-clean');
  });

  it('files a healable issue for a screen it has never recorded', () => {
    const result = triage(
      evidence({ screens: [screen({ screenId: 'okta-consent', baseline: 'absent' })] }),
      options,
    );
    assert.equal(result.action, 'healable-issue');
    assert.equal(result.ruleId, 'pass-unknown-screen');
  });

  /** THE EARLY WARNING - the case that pays for the whole design. */
  it('files a drift issue when the probe passed but the screen moved', () => {
    const result = triage(
      evidence({ screens: [screen({ baseline: 'drifted', delta: delta() })] }),
      options,
    );
    assert.equal(result.action, 'drift-issue');
    assert.equal(result.ruleId, 'pass-drift');
    assert.match(result.rationale, /Nothing is broken yet/);
  });

  /** An unrecorded screen outranks a drifted one: we know less about it. */
  it('prefers the unknown screen over the drifted one when both are present', () => {
    const result = triage(
      evidence({
        screens: [screen({ baseline: 'drifted', delta: delta() }), screen({ screenId: 'new', baseline: 'absent' })],
      }),
      options,
    );
    assert.equal(result.ruleId, 'pass-unknown-screen');
  });
});

describe('triage - Business failures are not bugs', () => {
  /**
   * THE MOST IMPORTANT ROW IN THE TABLE. Rule 1: the portal looked at what we
   * sent and refused it. Filing a healing issue would send an agent to "fix"
   * correct behaviour, in an automation that files real applications.
   */
  it('files nothing for a Business rejection', () => {
    const result = triage(
      evidence({
        verdict: 'fail',
        failedStep: 'enter the SIC code',
        error: {
          name: 'BusinessException',
          message: "That SIC code isn't valid. Please double check it and try again.",
          reason: 'business',
          stack: undefined,
          details: undefined,
          cause: undefined,
        },
        portalMessage: {
          text: "That SIC code isn't valid. Please double check it and try again.",
          isComplaint: true,
        },
      }),
      options,
    );

    assert.equal(result.action, 'none');
    assert.equal(result.ruleId, 'business-rejection');
    assert.deepEqual(result.rules, ['10a', '2', '1']);
    assert.match(result.rationale, /SIC code/);
  });

  /**
   * A lockout ALSO surfaces as a Business failure, but a locked account needs a
   * person. That is why the human-cause row is checked first, and this pins the
   * ordering.
   */
  it('still routes a lockout to a human even though it is a Business failure', () => {
    const lockout: KnownCause = {
      id: 'account-locked',
      title: 'The portal account is locked',
      probes: 'any',
      match: { text: [/locked or throttled/i] },
      action: 'human',
      reference: 'AGENTS.md rule 1',
      remedy: 'A person must unlock the account with the carrier.',
    };

    const result = triage(
      evidence({
        verdict: 'fail',
        error: {
          name: 'BusinessException',
          message: 'The anthem-ca portal account is locked or throttled: too many attempts',
          reason: 'business',
          stack: undefined,
          details: undefined,
          cause: undefined,
        },
      }),
      { causes: [lockout, ...GENERIC_CAUSES] },
    );

    assert.equal(result.action, 'human-issue');
    assert.equal(result.ruleId, 'known-cause-human');
  });
});

describe('triage - known causes', () => {
  const failed = (message: string, runtime: Partial<ProbeEvidence['runtime']> = {}): ProbeEvidence =>
    evidence({
      verdict: 'fail',
      failedStep: 'load the login page',
      runtime: { ...evidence().runtime, ...runtime },
      error: {
        name: 'SystemException',
        message,
        reason: 'system',
        stack: undefined,
        details: undefined,
        cause: undefined,
      },
    });

  /** A deliberately headless run against a carrier that blocks headless. */
  it('files nothing for the documented headless block', () => {
    const result = triage(failed('Access Denied (reference #18)', { headless: true }), options);
    assert.equal(result.action, 'none');
    assert.equal(result.ruleId, 'known-cause-none');
    assert.equal(result.cause?.id, 'headless-blocked');
  });

  /** Headed and STILL refused is a different, real problem. */
  it('files an infra issue when a headed browser is refused', () => {
    const result = triage(failed('Access Denied (reference #18)', { headless: false }), options);
    assert.equal(result.action, 'infra-issue');
    assert.equal(result.cause?.id, 'carrier-bot-block');
  });

  it('routes an untrusted corporate CA to infra, never to healing', () => {
    const result = triage(failed('net::ERR_CERT_AUTHORITY_INVALID at https://portal.example'), options);
    assert.equal(result.action, 'infra-issue');
    assert.equal(result.cause?.id, 'corporate-ca');
    assert.match(result.rationale, /three trust stores/i);
  });

  it('routes an orphaned profile lock to infra and names the fix', () => {
    const result = triage(failed('the profile is already in use by another instance of Chromium'), options);
    assert.equal(result.action, 'infra-issue');
    assert.equal(result.cause?.id, 'orphan-profile-lock');
    assert.match(result.rationale, /xargs kill/);
  });

  it('does not raise a timeout as a remedy for a missing MFA code', () => {
    const result = triage(failed('no MFA code arrived within the budget'), options);
    assert.equal(result.cause?.id, 'mfa-code-never-arrived');
    assert.match(result.rationale, /Do NOT raise mfaTimeoutMs/);
  });
});

describe('triage - failures the catalog does not explain', () => {
  const systemFail = (overrides: Partial<ProbeEvidence> = {}): ProbeEvidence =>
    evidence({
      verdict: 'fail',
      error: {
        name: 'SystemException',
        message: 'Precondition failed for step "reach the quoting platform"',
        reason: 'system',
        stack: undefined,
        details: undefined,
        cause: undefined,
      },
      ...overrides,
    });

  /** THE STRONGEST SIGNAL: the gate and the screen corroborate each other. */
  it('flags a failed gate on a drifted screen as the clearest healable finding', () => {
    const result = triage(
      systemFail({
        failedStep: 'reach the quoting platform',
        failedGate: 'precondition',
        screens: [screen({ baseline: 'drifted', delta: delta() })],
      }),
      options,
    );

    assert.equal(result.action, 'healable-issue');
    assert.equal(result.ruleId, 'gate-failed-screen-drifted');
    assert.match(result.rationale, /agree that something changed/);
  });

  it('points at the locator, not the portal, when the screen did not move', () => {
    const result = triage(
      systemFail({ failedStep: 'reach the quoting platform', failedGate: 'precondition' }),
      options,
    );

    assert.equal(result.action, 'healable-issue');
    assert.equal(result.ruleId, 'gate-failed-screen-matched');
    assert.match(result.rationale, /suspect the locator/);
  });

  it('treats a failure before any step as environmental', () => {
    const result = triage(systemFail({ steps: [] }), options);
    assert.equal(result.action, 'infra-issue');
    assert.equal(result.ruleId, 'failed-before-any-step');
  });

  /** Guessing `healable` here would point an agent at an automation blind. */
  it('sends an unclassifiable failure to a human rather than to a repair session', () => {
    const result = triage(systemFail(), options);
    assert.equal(result.action, 'human-issue');
    assert.equal(result.ruleId, 'unclassified');
  });
});

describe('triage - every result carries the rules a reader must know', () => {
  it('always includes the production freeze and the PII rule', () => {
    for (const result of [
      triage(evidence(), options),
      triage(evidence({ screens: [screen({ baseline: 'drifted', delta: delta() })] }), options),
      triage(evidence({ verdict: 'fail', failedStep: 'x' }), options),
    ]) {
      assert.ok(result.rules.includes('10a'), `${result.ruleId} must carry rule 10a`);
      assert.ok(result.rules.includes('2'), `${result.ruleId} must carry rule 2`);
    }
  });

  it('names the rule that decided, on every path', () => {
    const result = triage(evidence(), options);
    assert.notEqual(result.ruleId, '');
    assert.notEqual(result.rationale, '');
  });
});

describe('fingerprint - identity of a finding', () => {
  const drift = evidence({ screens: [screen({ baseline: 'drifted', delta: delta() })] });

  it('is stable across runs of the same problem', () => {
    const first = triage(drift, options).fingerprint;
    const second = triage(
      { ...drift, runId: 'later-run', startedAt: 'later', durationMs: 999 },
      options,
    ).fingerprint;

    assert.equal(first.hash, second.hash);
  });

  it('differs when the failing step differs', () => {
    const a = triage(evidence({ verdict: 'fail', failedStep: 'one' }), options).fingerprint;
    const b = triage(evidence({ verdict: 'fail', failedStep: 'two' }), options).fingerprint;
    assert.notEqual(a.hash, b.hash);
  });

  it('differs when the drift shape differs', () => {
    const a = triage(
      evidence({ screens: [screen({ baseline: 'drifted', delta: delta({ shape: 'fields:-1' }) })] }),
      options,
    ).fingerprint;
    const b = triage(
      evidence({ screens: [screen({ baseline: 'drifted', delta: delta({ shape: 'fields:+2' }) })] }),
      options,
    ).fingerprint;
    assert.notEqual(a.hash, b.hash);
  });

  /**
   * The reason the shape is counts and not values: a portal rewording a button
   * must not mint a new fingerprint and re-file the same finding.
   */
  it('is unchanged when only the delta VALUES differ', () => {
    const a = triage(
      evidence({
        screens: [
          screen({
            baseline: 'drifted',
            delta: delta({ changes: [{ key: 'fields', direction: 'removed', value: 'Username', meaningful: true }] }),
          }),
        ],
      }),
      options,
    ).fingerprint;
    const b = triage(
      evidence({
        screens: [
          screen({
            baseline: 'drifted',
            delta: delta({ changes: [{ key: 'fields', direction: 'removed', value: 'User ID', meaningful: true }] }),
          }),
        ],
      }),
      options,
    ).fingerprint;

    assert.equal(a.hash, b.hash);
  });

  /**
   * Length-prefixed framing exists for this: with a separator that can occur
   * inside a field, these two different findings would hash identically.
   */
  it('does not collide when a field value contains the separator characters', () => {
    const a = fingerprint({ probeId: 'p', kind: 'failure', step: 'a:b', gate: undefined, errorClass: 'c' });
    const b = fingerprint({ probeId: 'p', kind: 'failure', step: 'a', gate: undefined, errorClass: 'b:c' });
    assert.notEqual(a.hash, b.hash);
  });

  it('round-trips through the issue-body marker', () => {
    const value = triage(drift, options).fingerprint;
    const body = `## What happened\n\nsomething\n\n${fingerprintMarker(value)}\n`;
    assert.deepEqual(readFingerprintMarker(body), { version: 1, hash: value.hash });
  });

  it('reads no marker out of a body that has none', () => {
    assert.equal(readFingerprintMarker('just prose'), undefined);
  });
});

describe('matchKnownCause - order is behaviour', () => {
  /**
   * Reordering the array is an easy and silent way to change what gets filed,
   * so the one ordering that matters is pinned.
   */
  it('puts the specific headless row ahead of the general bot-block row', () => {
    const ids = GENERIC_CAUSES.map((cause) => cause.id);
    assert.ok(
      ids.indexOf('headless-blocked') < ids.indexOf('carrier-bot-block'),
      'headless-blocked must be matched before carrier-bot-block',
    );
  });

  it('requires every declared criterion to hold, not just one', () => {
    const both: KnownCause = {
      id: 'needs-both',
      title: 'x',
      probes: 'any',
      match: { text: [/boom/], env: (facts) => facts.headless },
      action: 'infra',
      reference: 'r',
      remedy: 'm',
    };

    const textOnly = evidence({
      verdict: 'fail',
      runtime: { ...evidence().runtime, headless: false },
      error: { name: 'SystemException', message: 'boom', reason: 'system', stack: undefined, details: undefined, cause: undefined },
    });

    assert.equal(matchKnownCause(textOnly, [both]), undefined);
    assert.equal(
      matchKnownCause({ ...textOnly, runtime: { ...textOnly.runtime, headless: true } }, [both])?.cause.id,
      'needs-both',
    );
  });

  it('scopes a cause to the probes that declare it', () => {
    const scoped: KnownCause = {
      id: 'only-navigation',
      title: 'x',
      probes: ['anthem-ca/portal-navigation'],
      match: { text: [/boom/] },
      action: 'infra',
      reference: 'r',
      remedy: 'm',
    };

    const failure = evidence({
      verdict: 'fail',
      error: { name: 'SystemException', message: 'boom', reason: 'system', stack: undefined, details: undefined, cause: undefined },
    });

    assert.equal(matchKnownCause(failure, [scoped]), undefined);
    assert.equal(
      matchKnownCause({ ...failure, probeId: 'anthem-ca/portal-navigation' }, [scoped])?.cause.id,
      'only-navigation',
    );
  });

  it('matches an HTTP status when one is declared', () => {
    const gone: KnownCause = {
      id: 'portal-410',
      title: 'x',
      probes: 'any',
      match: { status: [410] },
      action: 'healable',
      reference: 'r',
      remedy: 'm',
    };

    assert.equal(matchKnownCause(evidence({ httpStatus: 200 }), [gone]), undefined);
    assert.equal(matchKnownCause(evidence({ httpStatus: 410 }), [gone])?.cause.id, 'portal-410');
  });

  it('reads the portal wording and the screen alerts, not only the error message', () => {
    const alerting: KnownCause = {
      id: 'from-alert',
      title: 'x',
      probes: 'any',
      match: { text: [/not licensed in CA/] },
      action: 'human',
      reference: 'r',
      remedy: 'm',
    };

    const withAlert = evidence({
      verdict: 'fail',
      screens: [screen({ signature: signature({ alerts: ['<producer.last> is not licensed in CA'] }) })],
    });

    assert.equal(matchKnownCause(withAlert, [alerting])?.cause.id, 'from-alert');
  });
});
