import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFingerprintMarker } from './fingerprint.ts';
import { IssueBodyLeak, renderIssueBody, renderIssueTitle, type IssueBodyInput } from './issue-body.ts';
import { GENERIC_CAUSES } from './known-causes.ts';
import { createRedactor } from './redact.ts';
import { triage } from './triage.ts';
import type { ProbeEvidence, ScreenObservation } from './types.ts';

const PRODUCER = 'Featherstonehaugh';

function redactor(): ReturnType<typeof createRedactor> {
  return createRedactor({ values: { [PRODUCER]: '<producer.last>', AG7741QX: '<agency.code>' } });
}

function screen(overrides: Partial<ScreenObservation> = {}): ScreenObservation {
  return {
    screenId: 'ptb-dashboard',
    signature: {
      version: 1,
      screenId: 'ptb-dashboard',
      location: { host: 'portal.example', path: '/apps/ptb/', queryKeys: [] },
      alerts: [],
      railLabels: [],
      fields: [],
      buttons: ['Start Quote'],
      modal: { present: false, text: '' },
      counts: { alerts: 0, fields: 0, buttons: 1, rail: 0 },
    },
    baseline: 'matched',
    delta: undefined,
    maskedScreenshot: undefined,
    ...overrides,
  };
}

function evidence(overrides: Partial<ProbeEvidence> = {}): ProbeEvidence {
  return {
    schemaVersion: 1,
    probeId: 'anthem-ca/portal-navigation',
    carrier: 'anthem-ca',
    runId: '20260910T140211Z-a1b2c3',
    startedAt: '2026-09-10T14:02:11.000Z',
    endedAt: '2026-09-10T14:03:49.000Z',
    durationMs: 98_000,
    verdict: 'fail',
    runtime: {
      headless: false,
      display: ':99',
      platform: 'linux/x64',
      inContainer: true,
      nodeVersion: 'v24.0.0',
      gitCommit: 'dfaa653',
      hostname: 'rpa-sentinel-1',
    },
    steps: [
      { step: 'sign in', gate: undefined, outcome: 'skipped', durationMs: 4200 },
      { step: 'reach the quoting platform', gate: 'precondition', outcome: 'failed', durationMs: 20_014 },
    ],
    failedStep: 'reach the quoting platform',
    failedGate: 'precondition',
    error: {
      name: 'SystemException',
      message: 'Precondition failed for step "reach the quoting platform"',
      reason: 'system',
      stack: undefined,
      details: undefined,
      cause: undefined,
    },
    portalMessage: undefined,
    session: {
      storedSessionPresent: true,
      storedSessionAgeMs: 5_400_000,
      liveness: 'alive',
      signedInVia: 'reused',
      samlReauthenticated: true,
      mfaCodeSpent: false,
    },
    screens: [screen()],
    httpStatus: undefined,
    ...overrides,
  };
}

function input(overrides: Partial<IssueBodyInput> = {}): IssueBodyInput {
  const ev = overrides.evidence ?? evidence();
  return {
    evidence: ev,
    triage: overrides.triage ?? triage(ev, { causes: GENERIC_CAUSES }),
    priorArt: [],
    evidenceDir: 'artifacts/sentinel/20260910T140211Z-a1b2c3/anthem-ca-portal-navigation',
    reproduceCommand: 'pnpm tsx tooling/scripts/check-portal-navigation.ts',
    driftLogPath: 'docs/poc/anthem-ca-new-plans/drift-log.md',
    ...overrides,
  };
}

describe('renderIssueTitle', () => {
  it('names the probe and where it broke', () => {
    assert.equal(
      renderIssueTitle(input()),
      '[sentinel] anthem-ca/portal-navigation: precondition failed on "reach the quoting platform"',
    );
  });

  /** Dedup reads the marker in the BODY precisely so a retitle cannot orphan an issue. */
  it('carries no fingerprint, so a human can retitle it freely', () => {
    const built = input();
    assert.doesNotMatch(renderIssueTitle(built), new RegExp(built.triage.fingerprint.hash));
  });

  it('describes a drift finding that has no failing step', () => {
    const ev = evidence({
      verdict: 'pass',
      failedStep: undefined,
      failedGate: undefined,
      error: undefined,
      screens: [
        screen({
          baseline: 'drifted',
          delta: { screenId: 'ptb-dashboard', changes: [], meaningful: true, shape: 'buttons:-1' },
        }),
      ],
    });
    assert.match(renderIssueTitle(input({ evidence: ev })), /drift on ptb-dashboard/);
  });
});

describe('renderIssueBody - the freeze warning comes first', () => {
  /**
   * The most expensive thing a reader of this issue can do is verify a fix by
   * running the automation. Putting that after the interesting part is putting
   * it where an impatient reader will not see it.
   */
  it('leads with rule 10a, before the diagnosis', () => {
    const body = renderIssueBody(input(), redactor());
    const warning = body.indexOf('Before you touch anything');
    const diagnosis = body.indexOf('What happened');

    assert.ok(warning >= 0 && warning < diagnosis, 'the freeze warning must precede the diagnosis');
    assert.match(body, /forbidden at any `allowSubmit`/);
    assert.match(body, /creates a real account and a real quote/);
  });

  it('lists only the commands the freeze permits', () => {
    const body = renderIssueBody(input(), redactor());
    assert.match(body, /check-portal-access\.ts/);
    assert.match(body, /check-portal-navigation\.ts/);
    /**
     * The forbidden command is mentioned more than once - the warning states it
     * and the rule 10a quote restates it, which is fine. What matters is that
     * EVERY mention is a prohibition, never a suggestion. Asserting the count
     * would only pin how many times we happen to repeat ourselves.
     */
    const lines = body.split('\n').filter((line) => line.includes('rpa run group-submission/anthem-ca-new-plans'));
    assert.ok(lines.length > 0, 'the freeze prohibition must name the command it forbids');
    for (const line of lines) {
      assert.match(line, /forbidden|NOT allowed/, `presented without a prohibition: ${line}`);
    }
  });
});

describe('renderIssueBody - the handoff contract', () => {
  const body = (): string => renderIssueBody(input({ occurrences: 3 }), redactor());

  it('names the triage rule that decided, and why', () => {
    assert.match(body(), /Triage rule \| `gate-failed-screen-drifted`|Triage rule \| `gate-failed-screen-matched`/);
    assert.match(body(), /\*\*Why this was filed\.\*\*/);
  });

  it('carries the runtime facts, because half the causes are runtime causes', () => {
    const out = body();
    for (const fact of ['headless', 'DISPLAY', 'in container', 'commit', 'host']) {
      assert.match(out, new RegExp(fact));
    }
  });

  /** "Did that run spend a code?" must be answerable without an audit store. */
  it('states plainly whether an MFA code was spent', () => {
    assert.match(body(), /\*\*MFA code spent: false\*\*/);
  });

  it('reports the occurrence count when this is not the first sighting', () => {
    assert.match(body(), /Occurrences \| 3/);
  });

  it('points at evidence by path and uploads nothing', () => {
    const out = body();
    assert.match(out, /artifacts\/sentinel\/20260910T140211Z-a1b2c3/);
    assert.match(out, /Paths only\. Nothing is uploaded/);
    assert.doesNotMatch(out, /!\[/, 'no inline images');
  });

  it('gives the exact reproduce command, and the container form when supplied', () => {
    const out = renderIssueBody(
      input({ reproduceInContainer: 'docker compose run --rm rpa echo hi' }),
      redactor(),
    );
    assert.match(out, /pnpm tsx tooling\/scripts\/check-portal-navigation\.ts/);
    assert.match(out, /docker compose run/);
    // The entrypoint trap is worth restating where someone will copy the command.
    assert.match(out, /overriding it outright loses the/);
  });

  it('quotes the rules the triage result selected', () => {
    const out = body();
    assert.match(out, /Rule 10a — ANTHEM PRODUCTION IS FROZEN/);
    assert.match(out, /Rule 2 — No PII/);
  });

  it('offers both legitimate outcomes, so code is not contorted to fit a stale baseline', () => {
    const out = body();
    assert.match(out, /The automation is wrong/);
    assert.match(out, /The portal genuinely changed/);
    assert.match(out, /--bless --note/);
  });

  it('ends with a machine-readable fingerprint marker', () => {
    const built = input();
    const marker = readFingerprintMarker(renderIssueBody(built, redactor()));
    assert.deepEqual(marker, { version: 1, hash: built.triage.fingerprint.hash });
  });
});

describe('renderIssueBody - the delta table', () => {
  const drifted = evidence({
    screens: [
      screen({
        baseline: 'drifted',
        delta: {
          screenId: 'ptb-dashboard',
          changes: [
            { key: 'buttons', direction: 'removed', value: 'Small Group Quote & Enroll', meaningful: true },
            {
              key: 'buttons',
              direction: 'added',
              value: 'Download PDF',
              meaningful: false,
              noiseReason: 'a new button that does not read like an interstitial blocks nothing',
            },
          ],
          meaningful: true,
          shape: 'buttons:-1',
        },
      }),
    ],
  });

  it('marks which changes are meaningful and still lists the rest', () => {
    const out = renderIssueBody(input({ evidence: drifted }), redactor());
    assert.match(out, /\*\*yes\*\* \| buttons \| removed \| Small Group Quote & Enroll/);
    assert.match(out, /no \| buttons \| added \| Download PDF/);
    assert.match(out, /the judgement is a heuristic, not a fact/);
  });

  it('explains why a change was judged noise', () => {
    assert.match(
      renderIssueBody(input({ evidence: drifted }), redactor()),
      /Download PDF` — a new button that does not read like an interstitial/,
    );
  });

  /** A raw pipe or newline in a value would break the table it sits in. */
  it('escapes markdown table metacharacters in a value', () => {
    const nasty = evidence({
      screens: [
        screen({
          baseline: 'drifted',
          delta: {
            screenId: 'ptb-dashboard',
            changes: [
              { key: 'alerts', direction: 'added', value: 'Choose A | B\nthen continue', meaningful: true },
            ],
            meaningful: true,
            shape: 'alerts:+1',
          },
        }),
      ],
    });

    const out = renderIssueBody(input({ evidence: nasty }), redactor());
    assert.match(out, /Choose A \\\| B then continue/);
  });

  it('says so plainly when a screen has no baseline to compare against', () => {
    const unmapped = evidence({
      verdict: 'pass',
      failedStep: undefined,
      failedGate: undefined,
      error: undefined,
      screens: [screen({ screenId: 'okta-consent', baseline: 'absent' })],
    });
    assert.match(
      renderIssueBody(input({ evidence: unmapped }), redactor()),
      /No baseline exists for this screen/,
    );
  });

  it('handles a failure that never reached a screen', () => {
    const out = renderIssueBody(input({ evidence: evidence({ screens: [] }) }), redactor());
    assert.match(out, /None were read/);
  });
});

describe('renderIssueBody - prior art', () => {
  it('quotes the log rows with their line numbers', () => {
    const out = renderIssueBody(
      input({
        priorArt: [
          {
            line: 66,
            date: '2026-09-03',
            documented: '(not documented) What Create Quote does',
            actual: 'It opens a NEW TAB on a different host',
            now: 'The automation must handle the popup',
            tags: ['not documented'],
            score: 7,
            matched: ['quote', 'tab'],
          },
        ],
      }),
      redactor(),
    );

    assert.match(out, /\| 66 \| 2026-09-03 \|/);
    assert.match(out, /Read these before changing a locator/);
    assert.match(out, /A retraction is a contribution/);
  });

  it('still tells the reader to read the log when nothing matched', () => {
    const out = renderIssueBody(input({ priorArt: [] }), redactor());
    assert.match(out, /Nothing in `docs\/poc\/anthem-ca-new-plans\/drift-log\.md` matched/);
    assert.match(out, /Read the log anyway/);
  });
});

describe('renderIssueBody - rule 2 is enforced, not warned about', () => {
  /**
   * The last thing between a producer's name and a GitHub issue. It throws
   * rather than returning, because a caller that can ignore the result will.
   */
  it('refuses to render a body that still contains a secret value', () => {
    const leaking = evidence({
      error: {
        name: 'SystemException',
        message: `Sign-in failed for ${PRODUCER} at agency AG7741QX`,
        reason: 'system',
        stack: undefined,
        details: undefined,
        cause: undefined,
      },
    });

    assert.throws(() => renderIssueBody(input({ evidence: leaking }), redactor()), IssueBodyLeak);
  });

  it('names the line, so the leak can be found', () => {
    const leaking = evidence({
      portalMessage: { text: `${PRODUCER} is not licensed in CA`, isComplaint: true },
    });

    try {
      renderIssueBody(input({ evidence: leaking }), redactor());
      assert.fail('expected a leak to be refused');
    } catch (error) {
      assert.ok(error instanceof IssueBodyLeak);
      assert.match(error.where, /^line \d+$/);
      assert.match(error.message, /Fix the redactor rather than the assertion/);
    }
  });

  it('renders normally once the value has been scrubbed', () => {
    const scrubbed = evidence({
      portalMessage: { text: '<producer.last> is not licensed in CA', isComplaint: true },
    });
    const out = renderIssueBody(input({ evidence: scrubbed }), redactor());
    assert.match(out, /<producer\.last> is not licensed in CA/);
  });
});

describe('renderIssueBody - a Business rejection reads as one', () => {
  it('quotes the portal wording and the classifier verdict', () => {
    const business = evidence({
      error: {
        name: 'BusinessException',
        message: "That SIC code isn't valid.",
        reason: 'business',
        stack: undefined,
        details: undefined,
        cause: undefined,
      },
      portalMessage: { text: "That SIC code isn't valid.", isComplaint: true },
    });

    const out = renderIssueBody(input({ evidence: business }), redactor());
    assert.match(out, /isPortalComplaint` → `true`/);
    assert.match(out, /> That SIC code isn't valid\./);
    assert.match(out, /Rule 1 — Business vs System/);
  });
});
