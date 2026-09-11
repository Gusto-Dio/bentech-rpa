import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { createLogger, type Logger } from '../logger.ts';
import { SecretResolver } from '../secrets.ts';
import { step } from '../steps.ts';
import { visible } from '../gates.ts';
import { BaselineStore, EvidenceStore } from './evidence.ts';
import { causesFor, decideMfaBudget, readRuntimeFacts, runProbe } from './engine.ts';
import { createRedactor } from './redact.ts';
import type { Probe, ProbeContext } from './probe.ts';
import type { RawScreenInput } from './signature.ts';
import { triage } from './triage.ts';
import { decideFiling } from './filing.ts';
import { SENTINEL_LABELS } from './labels.ts';
import { recordSighting, type SentinelState } from './state.ts';
import type { SentinelConfig } from '../config/schema.ts';

/**
 * The detection pipeline, end to end, against a real DOM.
 *
 * ── WHY AN INTEGRATION TEST AND NOT JUST THE UNITS ──────────────────────────
 * Each module is covered on its own, and every one of them passed while the
 * whole was still untested. The things that only break when they are wired
 * together are the interesting ones: whether a drifted screen actually reaches
 * the triage table as `drifted`, whether the evidence writer refuses a leaking
 * signature, whether a clean pass genuinely writes nothing.
 *
 * The browser is real (`page.setContent`) for the same reason `gates.test.ts`
 * uses one: a selector's behaviour against a string proves nothing.
 */

const PRODUCER = 'Featherstonehaugh';

function silent(): Logger {
  return createLogger({ level: 'silent', pretty: false, base: {} });
}

function redactor(): ReturnType<typeof createRedactor> {
  return createRedactor({ values: { [PRODUCER]: '<producer.last>', AG7741QX: '<agency.code>' } });
}

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

/**
 * A screen that looks like the Anthem dashboard enough to matter.
 *
 * The producer name is in a FIELD VALUE and the agency code is in an alert,
 * because those are the two places `READ_DIAGNOSTICS` actually reads text from -
 * it captures `fields[].value`, `alerts`, `buttons`, the rail and the modal, not
 * arbitrary divs. A fixture that hid the PII somewhere the real reader never
 * looks would make the redaction assertions pass without proving anything.
 */
const DASHBOARD = `
  <main>
    <h2>Book of Business</h2>
    <div role="button">Start Quote</div>
    <div role="button">Small Group Quote &amp; Enroll</div>
    <label for="agent">Writing Agent</label><input id="agent" value="${PRODUCER}" />
    <label for="zip">Group ZIP Code</label><input id="zip" value="94107" />
    <div role="alert">Agency AG7741QX is not licensed in this state.</div>
  </main>
`;

/**
 * The launchpad tile renamed. `Start Quote` is untouched, so the probe's gate
 * still passes - which is exactly the case drift detection exists for.
 */
const DASHBOARD_DRIFTED = DASHBOARD.replace(
  '<div role="button">Small Group Quote &amp; Enroll</div>',
  '<div role="button">Quote &amp; Enroll (new)</div>',
);

/**
 * `Start Quote` itself renamed, so the probe's postcondition genuinely FAILS
 * and the screen drifts at the same time. That pairing is the strongest signal
 * the triage table recognises.
 */
const DASHBOARD_BROKEN = DASHBOARD.replace(
  '<div role="button">Start Quote</div>',
  '<div role="button">Begin a Quote</div>',
);

/**
 * Reads the screen the way the real automation does. Structurally identical to
 * `read-screen.ts`'s output, which is what the engine takes.
 */
async function readScreen(page: Page): Promise<RawScreenInput | undefined> {
  return page.evaluate(`(() => {
    const sq = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
    const all = [...document.querySelectorAll('*')];
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      url: location.href,
      alerts: all.filter((el) => shown(el) && el.matches('[role=alert]')).map((el) => sq(el.textContent)),
      wizardStep: [],
      fields: all.filter((el) => el.matches('input') && shown(el)).map((el) => ({
        label: sq(document.querySelector('label[for="' + el.id + '"]')?.textContent),
        value: el.value,
      })),
      buttons: [...new Set(all.filter((el) => shown(el) && el.matches('[role=button],button')).map((el) => sq(el.textContent)).filter(Boolean))],
      answered: [],
      modal: null,
    };
  })()`) as Promise<RawScreenInput | undefined>;
}

interface Harness {
  browser: Browser;
  dir: string;
  evidence: EvidenceStore;
  baselines: BaselineStore;
}

async function withHarness<T>(body: (harness: Harness) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sentinel-e2e-'));
  const browser = await chromium.launch();

  try {
    return await body({
      browser,
      dir,
      evidence: new EvidenceStore({ artifactsDir: path.join(dir, 'artifacts'), runId: 'run-1', logger: silent() }),
      baselines: new BaselineStore({ dir: path.join(dir, 'baselines'), logger: silent() }),
    });
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function probeFor(html: string): Probe {
  return {
    id: 'anthem-ca/portal-access',
    carrier: 'anthem-ca',
    title: 'test probe',
    sets: ['access'],
    needsCredentials: false,
    maySpendMfa: false,
    screenIds: ['ptb-dashboard'],
    knownCauses: [],
    async run(ctx: ProbeContext): Promise<void> {
      await ctx.page.setContent(html);

      /**
       * Observe BEFORE the gate, so a gate failure still leaves a screen
       * observation behind. The real probes do the same: the delta is most
       * valuable precisely when the gate failed, and a `finally` that recorded
       * nothing would throw away half the finding.
       */
      await ctx.observe('ptb-dashboard');

      await step(ctx.steps, {
        name: 'reach the dashboard',
        alwaysRun: true,
        timeoutMs: 15_000,
        action: async () => undefined,
        /** A real waiting gate, so a failure goes through `onGateFailure`. */
        postcondition: () =>
          visible(ctx.page.getByRole('button', { name: 'Start Quote', exact: true }), 2_000),
      });
    },
    explain: () => ['test'],
  };
}

async function run(harness: Harness, probe: Probe): ReturnType<typeof runProbe> {
  return runProbe({
    probe,
    browser: harness.browser,
    runId: 'run-1',
    secrets: new SecretResolver(),
    logger: silent(),
    redactor: redactor(),
    evidence: harness.evidence,
    baselines: harness.baselines,
    paths: { repoRoot: harness.dir, dataDir: path.join(harness.dir, 'data') },
    runtime: readRuntimeFacts({ headless: true }),
    mfaBudget: { allowed: false, reason: 'not-requested' },
    readScreen,
  });
}

describe('the pipeline, end to end', () => {
  it('a first sighting of an unmapped screen is a healable finding', async () => {
    await withHarness(async (harness) => {
      const { evidence } = await run(harness, probeFor(DASHBOARD));

      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.screens[0]?.baseline, 'absent', 'no baseline has been written yet');

      const verdict = triage(evidence, { causes: causesFor(probeFor(DASHBOARD)) });
      assert.equal(verdict.ruleId, 'pass-unknown-screen');
      assert.equal(verdict.action, 'healable-issue');
    });
  });

  it('once blessed, the same screen reports clean and writes no evidence', async () => {
    await withHarness(async (harness) => {
      const first = await run(harness, probeFor(DASHBOARD));
      const signature = first.evidence.screens[0]?.signature;
      assert.ok(signature !== undefined);

      await harness.baselines.write(signature, {
        blessedAt: new Date().toISOString(),
        runId: 'run-0',
        probeId: 'anthem-ca/portal-access',
        signatureVersion: signature.version,
        note: 'first baseline, from the test harness',
      });

      const second = await run(harness, probeFor(DASHBOARD));
      assert.equal(second.evidence.screens[0]?.baseline, 'matched');

      const verdict = triage(second.evidence, { causes: [] });
      assert.equal(verdict.ruleId, 'pass-clean');
      assert.equal(verdict.action, 'none');
    });
  });

  /**
   * THE CASE THE WHOLE DESIGN EXISTS FOR. The probe still passes - `Start
   * Quote` is still there - but the launchpad tile the navigation probe depends
   * on has gone. Catching that now is the difference between a scheduled fix
   * and an incident next week.
   */
  it('detects drift on a screen that still passes', async () => {
    await withHarness(async (harness) => {
      const baseline = await run(harness, probeFor(DASHBOARD));
      const signature = baseline.evidence.screens[0]?.signature;
      assert.ok(signature !== undefined);

      await harness.baselines.write(signature, {
        blessedAt: new Date().toISOString(),
        runId: 'run-0',
        probeId: 'anthem-ca/portal-access',
        signatureVersion: signature.version,
        note: 'before the tile was renamed',
      });

      const drifted = await run(harness, probeFor(DASHBOARD_DRIFTED));

      assert.equal(drifted.evidence.verdict, 'pass', 'the probe still passes');
      assert.equal(drifted.evidence.screens[0]?.baseline, 'drifted');

      const removed = drifted.evidence.screens[0]?.delta?.changes.filter(
        (change) => change.meaningful && change.direction === 'removed',
      );
      assert.ok(
        removed?.some((change) => change.value.includes('Small Group Quote')),
        'the vanished launchpad tile must be the meaningful change',
      );

      const verdict = triage(drifted.evidence, { causes: [] });
      assert.equal(verdict.ruleId, 'pass-drift');
      assert.equal(verdict.action, 'drift-issue');
    });
  });

  it('a failed gate on a drifted screen is the strongest finding', async () => {
    await withHarness(async (harness) => {
      const baseline = await run(harness, probeFor(DASHBOARD));
      const signature = baseline.evidence.screens[0]?.signature;
      assert.ok(signature !== undefined);
      await harness.baselines.write(signature, {
        blessedAt: new Date().toISOString(),
        runId: 'run-0',
        probeId: 'anthem-ca/portal-access',
        signatureVersion: signature.version,
        note: 'baseline',
      });

      const failed = await run(harness, probeFor(DASHBOARD_BROKEN));
      assert.equal(failed.evidence.verdict, 'fail');

      const verdict = triage(failed.evidence, { causes: [] });
      assert.equal(verdict.ruleId, 'gate-failed-screen-drifted');
      assert.equal(verdict.action, 'healable-issue');
    });
  });

  /** Rule 2, at the last moment before bytes hit a disk someone will read. */
  it('the signature carries no portal value, and the evidence writer enforces it', async () => {
    await withHarness(async (harness) => {
      const { evidence, readings } = await run(harness, probeFor(DASHBOARD));

      assert.doesNotMatch(
        JSON.stringify(evidence.screens[0]?.signature),
        new RegExp(PRODUCER),
        'the producer name must not survive into the signature',
      );

      const written = await harness.evidence.write(evidence, readings, redactor());
      const onDisk = await readFile(path.join(written.dir, 'evidence.json'), 'utf8');
      assert.doesNotMatch(onDisk, new RegExp(PRODUCER));
      assert.doesNotMatch(onDisk, /AG7741QX/);

      /** And the raw reading, which is the more likely place for a leak. */
      const screen = await readFile(
        path.join(written.dir, 'screen.ptb-dashboard.json'),
        'utf8',
      );
      assert.doesNotMatch(screen, new RegExp(PRODUCER));
      assert.match(screen, /<producer\.last>/);
    });
  });

  it('refuses to write evidence whose signature still leaks', async () => {
    await withHarness(async (harness) => {
      /** Built with a redactor that does not know the value. */
      const { evidence, readings } = await runProbe({
        probe: probeFor(DASHBOARD),
        browser: harness.browser,
        runId: 'run-1',
        secrets: new SecretResolver(),
        logger: silent(),
        redactor: createRedactor({ values: {} }),
        evidence: harness.evidence,
        baselines: harness.baselines,
        paths: { repoRoot: harness.dir, dataDir: path.join(harness.dir, 'data') },
        runtime: readRuntimeFacts({ headless: true }),
        mfaBudget: { allowed: false, reason: 'not-requested' },
        readScreen,
      });

      await assert.rejects(
        harness.evidence.write(evidence, readings, redactor()),
        /a known secret value survived redaction/,
      );
    });
  });

  /**
   * The filing layer's contribution: a first sighting of a FAILURE waits for the
   * consecutive threshold, so one transient failure files nothing.
   */
  it('a single failure files nothing; the second one files', async () => {
    await withHarness(async (harness) => {
      const failed = await run(harness, probeFor(DASHBOARD_BROKEN));
      const verdict = triage(failed.evidence, { causes: [] });

      const state: SentinelState = { version: 1, fingerprints: {}, daily: {} };

      const first = recordSighting(state, verdict.fingerprint.hash);
      const decisionOne = decideFiling({
        triage: verdict,
        probeId: 'anthem-ca/portal-access',
        carrier: 'anthem-ca',
        record: first,
        openIssues: [],
        newIssuesToday: 0,
        config: config(),
      });
      assert.equal(decisionOne.action, 'skip');

      const second = recordSighting(state, verdict.fingerprint.hash);
      const decisionTwo = decideFiling({
        triage: verdict,
        probeId: 'anthem-ca/portal-access',
        carrier: 'anthem-ca',
        record: second,
        openIssues: [],
        newIssuesToday: 0,
        config: config(),
      });
      assert.equal(decisionTwo.action, 'file');
      assert.ok(decisionTwo.action === 'file' && decisionTwo.labels.includes(SENTINEL_LABELS.agentReady));
    });
  });
});

describe('the MFA budget, wired', () => {
  it('never grants a budget to a probe that did not ask for one', () => {
    const budget = decideMfaBudget({
      probe: { maySpendMfa: false },
      liveness: 'lapsed',
      spentToday: 0,
      maxPerDay: 1,
    });
    assert.equal(budget.allowed, false);
    assert.equal(budget.reason, 'not-requested');
  });

  /** A living session costs nothing, so spending a code would be pure waste. */
  it('refuses when the session is alive', () => {
    const budget = decideMfaBudget({
      probe: { maySpendMfa: true },
      liveness: 'alive',
      spentToday: 0,
      maxPerDay: 1,
    });
    assert.equal(budget.reason, 'session-alive');
  });

  it('grants on a proven lapse, within the daily cap', () => {
    assert.equal(
      decideMfaBudget({ probe: { maySpendMfa: true }, liveness: 'lapsed', spentToday: 0, maxPerDay: 1 }).allowed,
      true,
    );
  });

  it('refuses once the daily cap is spent', () => {
    const budget = decideMfaBudget({
      probe: { maySpendMfa: true },
      liveness: 'lapsed',
      spentToday: 1,
      maxPerDay: 1,
    });
    assert.equal(budget.allowed, false);
    assert.equal(budget.reason, 'budget-spent');
  });
});
