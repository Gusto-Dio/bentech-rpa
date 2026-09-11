import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BUDGETS } from './policy.ts';
import {
  BudgetExhausted,
  FAILURE_MATRIX,
  HEAL_PHASES,
  exhausted,
  newBudgetState,
  preflight,
  writeOutcome,
  type HealResult,
} from './session.ts';

const REPO = path.join(import.meta.dirname, '..', '..');

describe('budgets', () => {
  const quiet = { denialStreak: 0 };

  it('reports nothing while everything is within budget', () => {
    assert.equal(exhausted(newBudgetState(), quiet), undefined);
  });

  it('reports the wall clock in minutes a human can read', () => {
    const state = newBudgetState(Date.now() - BUDGETS.wallClockMs - 1000);
    assert.match(exhausted(state, quiet) ?? '', /wall clock: \d+ minutes/);
  });

  it('reports the prompt budget', () => {
    const state = newBudgetState();
    state.prompts = BUDGETS.maxPrompts + 1;
    assert.match(exhausted(state, quiet) ?? '', /prompt budget/);
  });

  /**
   * A portal-drift fix that touches seven files is probably not a portal-drift
   * fix, and the message says so rather than just stating the number.
   */
  it('reports the edited-file cap, and says what exceeding it implies', () => {
    const state = newBudgetState();
    for (let i = 0; i <= BUDGETS.maxEditedFiles; i += 1) state.editedFiles.add(`file-${i}.ts`);
    const reason = exhausted(state, quiet) ?? '';
    assert.match(reason, /edited \d+ files/);
    assert.match(reason, /probably not a portal-drift fix/);
  });

  it('reports the diff-size cap', () => {
    const state = newBudgetState();
    state.diffLines = BUDGETS.maxDiffLines + 1;
    assert.match(exhausted(state, quiet) ?? '', /diff is \d+ lines/);
  });

  /**
   * Left alone, an agent blocked by policy tries variants of the same
   * forbidden thing. Converted to an escalation, the denial reasons ARE the
   * diagnosis.
   */
  it('treats a denial streak as exhaustion', () => {
    const reason = exhausted(newBudgetState(), { denialStreak: BUDGETS.maxDeniedInARow }) ?? '';
    assert.match(reason, /consecutive denials/);
    assert.match(reason, /arguing with the policy rather than diagnosing/);
  });

  it('does not fire below the denial threshold', () => {
    assert.equal(exhausted(newBudgetState(), { denialStreak: BUDGETS.maxDeniedInARow - 1 }), undefined);
  });

  it('BudgetExhausted says plainly that this is an escalation', () => {
    const error = new BudgetExhausted('prompts', 60);
    assert.match(error.message, /This is an escalation, not a failure/);
  });
});

describe('preflight', () => {
  const base = {
    cleanWorkingTree: true,
    checkGreenOnMain: true,
    storedSessionAlive: true,
    repoRoot: REPO,
  };

  it('passes on a clean, green tree with the policy self-test green', async () => {
    const result = await preflight(base);
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.passed), null, 2));
  });

  it('refuses an unclean working tree', async () => {
    const result = await preflight({ ...base, cleanWorkingTree: false });
    assert.equal(result.ok, false);
    assert.match(result.checks.find((c) => c.id === 'clean-tree')?.detail ?? '', /UNCOMMITTED/);
  });

  /**
   * THE ONE THAT MATTERS MOST IN PREFLIGHT. A red baseline means the session
   * will attribute someone else's failure to portal drift and then "fix" it.
   */
  it('refuses to start when pnpm check is already red', async () => {
    const result = await preflight({ ...base, checkGreenOnMain: false });
    assert.equal(result.ok, false);
    const detail = result.checks.find((c) => c.id === 'baseline-green')?.detail ?? '';
    assert.match(detail, /ALREADY RED/);
    assert.match(detail, /attribute someone else's failure to portal drift/);
  });

  it('includes the policy self-test checks', async () => {
    const result = await preflight(base);
    for (const id of ['denies-the-frozen-run', 'denies-flipping-allowSubmit', 'denies-merging']) {
      assert.ok(result.checks.some((check) => check.id === id), `${id} must be part of preflight`);
    }
  });

  /**
   * A lapsed session does NOT abort: rungs 0-3 and 6 are still available and a
   * diagnosis is still worth having. It records that rung 4 is unavailable.
   */
  it('does not fail preflight for a lapsed session, but says rung 4 is unavailable', async () => {
    const result = await preflight({ ...base, storedSessionAlive: false });
    assert.equal(result.ok, true);
    const detail = result.checks.find((c) => c.id === 'session-alive')?.detail ?? '';
    assert.match(detail, /rung 4 is unavailable/);
    assert.match(detail, /Do NOT spend a code/);
  });
});

describe('the failure matrix', () => {
  /**
   * The distinction that is easy to get wrong in the moment: a diagnosis goes
   * on the issue; an infrastructure failure alarms an operator and says
   * NOTHING on the issue. Commenting a non-diagnosis trains people to ignore
   * comments.
   */
  it('never comments a diagnosis for an infrastructure abort', () => {
    for (const row of FAILURE_MATRIX.filter((entry) => entry.outcome === 'aborted')) {
      assert.match(row.action, /alarm the operator/i, row.situation);
      assert.match(row.action, /do NOT comment|says nothing about the portal|Nothing else may run/i, row.situation);
    }
  });

  it('escalates rather than guessing whenever the cause is not established', () => {
    const ambiguous = FAILURE_MATRIX.find((row) => row.situation.includes('more than one root cause'));
    assert.equal(ambiguous?.outcome, 'escalated');
    assert.match(ambiguous?.action ?? '', /cheapest experiment/);
  });

  /** The classic autohealer pathology, named in the matrix itself. */
  it('never weakens a check to make a rung go green', () => {
    const red = FAILURE_MATRIX.find((row) => row.situation.includes('ladder rung went red'));
    assert.match(red?.action ?? '', /NEVER weaken a check/);
  });

  it('keeps no-drift-found distinct, because it is a signal about the sentinel', () => {
    const none = FAILURE_MATRIX.find((row) => row.outcome === 'no-drift-found');
    assert.ok(none !== undefined);
    assert.match(none.action, /sentinel threshold/);
  });

  it('covers every outcome the session can end with', () => {
    const covered = new Set(FAILURE_MATRIX.map((row) => row.outcome));
    for (const outcome of ['aborted', 'escalated', 'pull-request', 'no-drift-found'] as const) {
      assert.ok(covered.has(outcome), `${outcome} has no row in the failure matrix`);
    }
  });
});

describe('phases', () => {
  it('captures evidence BEFORE repairing, so a before image is still possible', () => {
    const phases = [...HEAL_PHASES];
    assert.ok(
      phases.indexOf('REPRODUCE') < phases.indexOf('REPAIR'),
      'the pre-fix screen has to be captured while the tree is still pre-fix',
    );
  });

  it('verifies before it publishes', () => {
    const phases = [...HEAL_PHASES];
    assert.ok(phases.indexOf('VERIFY') < phases.indexOf('PUBLISH'));
    assert.ok(phases.indexOf('EVIDENCE') < phases.indexOf('PUBLISH'));
  });

  it('tears down last, so the recon browser is always released', () => {
    assert.equal(HEAL_PHASES.at(-1), 'TEARDOWN');
  });
});

describe('writeOutcome', () => {
  it('records every terminal outcome as a file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'heal-outcome-'));
    try {
      const result: HealResult = {
        issue: 412,
        outcome: 'escalated',
        phaseReached: 'DIAGNOSE',
        reason: 'two hypotheses survived',
        rungsClimbed: ['0 static', '1 suite'],
        rungsUnavailable: [{ rung: '4 navigation', why: 'the portal session had lapsed' }],
        prompts: 18,
        wallClockMs: 22 * 60_000,
        denials: 1,
        editedFiles: [],
        diffLines: 0,
        modelId: 'claude-opus-5',
      };

      const file = await writeOutcome(dir, result);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')) as HealResult, result);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
