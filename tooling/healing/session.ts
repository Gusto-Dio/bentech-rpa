import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUDGETS } from './policy.ts';
import { selfTest } from './probe-self-test.ts';
import { Transcript } from './transcript.ts';

/**
 * The phases of one repair session, and what each failure means.
 *
 * ── WHY THIS IS A STATE MACHINE AND NOT A PROMPT ────────────────────────────
 * The interesting decisions in a heal are not "what should the agent say next" -
 * they are "may it start", "has it proven anything", and "should this end as a
 * pull request or as an escalation". Those are the supervisor's, and they are
 * testable. What the agent does inside REPAIR is the agent's.
 *
 * ── ONE CLONE, A BRANCH, AND A LOCK. NOT A WORKTREE. ────────────────────────
 * `.env`, `data/sessions/anthem-ca.json`, the persistent Chromium profile and
 * CDP port 9222 are all repo-root singletons. `findRepoRoot()` inside a git
 * worktree resolves to the worktree, where `data/` and `.env` do not exist -
 * both are gitignored - and symlinking credential-equivalent material into a
 * worktree contradicts `docs/poc/sanitization.md`.
 *
 * Concurrency is not a feature here. Two sessions would fight over the browser
 * profile and the loser would report "the profile is already in use", which has
 * nothing to do with the portal; twenty orphaned browsers accumulated once for
 * exactly that reason.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const HEAL_PHASES = [
  'CLAIM',
  'PREFLIGHT',
  'BRANCH',
  'REPRODUCE',
  'DIAGNOSE',
  'REPAIR',
  'VERIFY',
  'EVIDENCE',
  'RECORD',
  'PUBLISH',
  'TEARDOWN',
] as const;

export type HealPhase = (typeof HEAL_PHASES)[number];

export type HealOutcome =
  /** A draft pull request is open. */
  | 'pull-request'
  /**
   * A diagnosis is on the issue and no PR was opened.
   *
   * A first-class SUCCESS, not an error path. A partial diagnosis honestly
   * labelled beats a guessed fix edited into an automation that files real
   * applications.
   */
  | 'escalated'
  /**
   * The automation is correct and the finding was noise.
   *
   * Worth its own outcome: it is a signal about the sentinel's thresholds, and
   * collapsing it into "escalated" would lose that.
   */
  | 'no-drift-found'
  /**
   * Infrastructure. An operator alarm, NOT an issue comment - this is not a
   * diagnosis of the portal, it is the healer being unable to run at all, and
   * commenting a non-diagnosis on the issue trains people to ignore comments.
   */
  | 'aborted';

export interface HealResult {
  issue: number;
  outcome: HealOutcome;
  phaseReached: HealPhase;
  reason: string;
  /** Rungs of the verification ladder that were climbed, by name. */
  rungsClimbed: readonly string[];
  rungsUnavailable: readonly { rung: string; why: string }[];
  prompts: number;
  wallClockMs: number;
  denials: number;
  editedFiles: readonly string[];
  diffLines: number;
  modelId: string | undefined;
}

export class BudgetExhausted extends Error {
  constructor(readonly what: string, readonly limit: number) {
    super(`Budget exhausted: ${what} (limit ${limit}). This is an escalation, not a failure.`);
    this.name = 'BudgetExhausted';
  }
}

export interface BudgetState {
  startedAt: number;
  prompts: number;
  editedFiles: Set<string>;
  diffLines: number;
}

export function newBudgetState(now = Date.now()): BudgetState {
  return { startedAt: now, prompts: 0, editedFiles: new Set(), diffLines: 0 };
}

/**
 * Which budget, if any, has run out.
 *
 * Returns the reason rather than throwing, because every one of these is an
 * ESCALATION - a thing to write up on the issue - and an exception would invite
 * a caller to treat it as a crash.
 */
export function exhausted(
  state: BudgetState,
  transcript: Pick<Transcript, 'denialStreak'>,
  now = Date.now(),
): string | undefined {
  if (now - state.startedAt > BUDGETS.wallClockMs) {
    return `wall clock: ${Math.round((now - state.startedAt) / 60_000)} minutes`;
  }
  if (state.prompts > BUDGETS.maxPrompts) {
    return `prompt budget: ${state.prompts} of ${BUDGETS.maxPrompts}`;
  }
  if (state.editedFiles.size > BUDGETS.maxEditedFiles) {
    return `edited ${state.editedFiles.size} files, cap is ${BUDGETS.maxEditedFiles} - a portal-drift fix that touches more than that is probably not a portal-drift fix`;
  }
  if (state.diffLines > BUDGETS.maxDiffLines) {
    return `diff is ${state.diffLines} lines, cap is ${BUDGETS.maxDiffLines}`;
  }

  /**
   * Three refusals in a row means the agent is trying variants of a forbidden
   * thing rather than diagnosing. Left alone it loops; converted to an
   * escalation, the denial reasons become the diagnosis.
   */
  if (transcript.denialStreak >= BUDGETS.maxDeniedInARow) {
    return `${transcript.denialStreak} consecutive denials - the session is arguing with the policy rather than diagnosing`;
  }

  return undefined;
}

export interface PreflightResult {
  ok: boolean
  checks: readonly { id: string; passed: boolean; detail: string }[];
}

/**
 * May a heal start at all?
 *
 * ── WHY `pnpm check` ON MAIN COMES FIRST ────────────────────────────────────
 * A red baseline means the next thing that happens is the session attributing
 * somebody else's failure to portal drift, then "fixing" it. Establishing that
 * the tree was green BEFORE any edit is what makes "rung 1 passed" mean
 * anything at all.
 */
export async function preflight(input: {
  cleanWorkingTree: boolean;
  checkGreenOnMain: boolean;
  storedSessionAlive: boolean;
  repoRoot: string;
}): Promise<PreflightResult> {
  const checks: { id: string; passed: boolean; detail: string }[] = [];

  checks.push({
    id: 'clean-tree',
    passed: input.cleanWorkingTree,
    detail: input.cleanWorkingTree
      ? 'the working tree is clean'
      : 'UNCOMMITTED CHANGES: a heal would mix them into its own diff',
  });

  checks.push({
    id: 'baseline-green',
    passed: input.checkGreenOnMain,
    detail: input.checkGreenOnMain
      ? '`pnpm check` is green before any edit'
      : 'PNPM CHECK IS ALREADY RED: fix that first, or this session will attribute someone else\'s failure to portal drift',
  });

  const policy = await selfTest(input.repoRoot);
  for (const check of policy.checks) checks.push(check);

  /**
   * A lapsed PORTAL session is an escalation rather than an abort: the heal
   * cannot climb rung 4, but rungs 0-3 and 6 are still available and a
   * diagnosis is still worth having. Recorded as a check so the PR can say the
   * rung was unavailable and why.
   */
  checks.push({
    id: 'session-alive',
    passed: true,
    detail: input.storedSessionAlive
      ? 'the stored session is alive, so rung 4 is available and costs no MFA code'
      : 'the stored session has LAPSED: rung 4 is unavailable. Do NOT spend a code to climb it - escalate instead',
  });

  return { ok: checks.every((check) => check.passed), checks };
}

/**
 * What each failure mode ends as.
 *
 * A table rather than scattered branches, because the distinction that matters
 * - "comment a diagnosis on the issue" versus "alarm an operator and say
 * nothing on the issue" - is easy to get wrong in the moment and expensive to
 * get wrong repeatedly.
 */
export const FAILURE_MATRIX: readonly {
  situation: string;
  outcome: HealOutcome;
  action: string;
}[] = [
  {
    situation: '`pnpm check` was already red before any edit',
    outcome: 'aborted',
    action: 'alarm the operator. Do NOT comment a diagnosis - this says nothing about the portal',
  },
  {
    situation: 'the policy self-test failed',
    outcome: 'aborted',
    action: 'alarm the operator. Nothing else may run: the guard rails are not proven',
  },
  {
    situation: 'the portal session lapsed and a sign-in would cost an MFA code',
    outcome: 'escalated',
    action: 'comment "needs an MFA code", with the measured cost and why one was not spent',
  },
  {
    situation: 'the failing screen cannot be reached read-only',
    outcome: 'pull-request',
    action: 'continue degraded: diagnose from artifacts, mark the missing rungs and the missing BEFORE',
  },
  {
    situation: 'more than one root cause survives the evidence',
    outcome: 'escalated',
    action: 'comment every surviving hypothesis and the cheapest experiment that separates them',
  },
  {
    situation: 'the fix needs a write-denied path, or the freeze lifted',
    outcome: 'escalated',
    action: 'comment the diagnosis AND the proposed patch as a fenced diff. Do not apply it',
  },
  {
    situation: 'three consecutive policy denials',
    outcome: 'escalated',
    action: 'comment. The denial reasons are the diagnosis',
  },
  {
    situation: 'a ladder rung went red after the edit',
    outcome: 'escalated',
    action: 'loop back to REPAIR at most three times, then escalate. NEVER weaken a check to go green',
  },
  {
    situation: 'wall clock, prompts, edits or diff size exhausted',
    outcome: 'escalated',
    action: 'comment what was established and what was ruled out. A partial diagnosis beats silence',
  },
  {
    situation: 'the automation is correct and the screen matches its baseline',
    outcome: 'no-drift-found',
    action: 'comment the evidence, and suggest reviewing the sentinel threshold that filed it',
  },
];

/**
 * Every terminal outcome writes this, and comments on the issue - except
 * `aborted`, which alarms an operator instead.
 */
export async function writeOutcome(dir: string, result: HealResult): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'outcome.json');
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return file;
}
