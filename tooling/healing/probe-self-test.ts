import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findRepoRoot } from '@rpa/core';
import { evaluate } from './permission-handler.ts';
import { HEALING_MCP_ORIGINS, HEALING_SCOPE } from './policy.ts';

/**
 * Proves the guard rails are real before a heal is allowed to start.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * The permission handler only fires when the agent CHOOSES to ask. If the
 * agent-side configuration already permits a tool, no request is emitted and
 * the handler never runs - so a policy can be perfectly correct and completely
 * bypassed at the same time, with nothing to show for it.
 *
 * This is the direct analogue of the distinction `check-portal-access.ts`
 * draws: `rpa doctor` proves Chromium starts; only the probe proves the carrier
 * accepts it. Believing permissions are wired is not the same as measuring it.
 *
 * ── WHAT PASSING MEANS, AND WHAT IT DOES NOT ────────────────────────────────
 * The checks below are in two groups, and the difference matters.
 *
 * Group A (static) proves the POLICY is correct - that it denies the frozen
 * command and the shared engine, and permits a page object. It needs no agent
 * and runs in milliseconds.
 *
 * Group B (wiring) proves the policy is IN THE PATH - that a live agent's tool
 * call actually reaches it. That one needs a real session and is performed by
 * the supervisor, which calls `assertWiringObserved` with what it saw.
 *
 * A green Group A with an unproven Group B is exactly the dangerous state this
 * file exists to make visible, so `selfTest` reports them separately and the
 * supervisor refuses to proceed on Group A alone.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface SelfTestCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface SelfTestResult {
  checks: readonly SelfTestCheck[];
  passed: boolean;
}

const FROZEN_RUN = `pnpm rpa run ${HEALING_SCOPE.automationId}`;

/** Group A: is the policy itself correct? */
export async function selfTest(repoRoot = findRepoRoot()): Promise<SelfTestResult> {
  const checks: SelfTestCheck[] = [];

  const expect = (id: string, condition: boolean, detail: string): void => {
    checks.push({ id, passed: condition, detail });
  };

  // ── 1. The frozen command, in every shape that could reach a shell. ──
  const frozenShapes = [
    FROZEN_RUN,
    `pnpm check; ${FROZEN_RUN}`,
    `pnpm check && ${FROZEN_RUN}`,
    `echo go | ${FROZEN_RUN}`,
    `APP_ENV=dev ${FROZEN_RUN}`,
  ];
  const frozenDenied = frozenShapes.every(
    (command) => !evaluate({ toolName: 'Bash', input: { command } }, repoRoot).allowed,
  );
  expect(
    'denies-the-frozen-run',
    frozenDenied,
    frozenDenied
      ? `all ${frozenShapes.length} shapes of "${FROZEN_RUN}" are denied`
      : 'AT LEAST ONE SHAPE OF THE FROZEN RUN COMMAND WOULD BE PERMITTED',
  );

  // ── 2. The shared engine is not writable. ──
  const engineDenied = !evaluate(
    { toolName: 'Write', input: { file_path: 'packages/core/src/steps.ts', content: 'x' } },
    repoRoot,
  ).allowed;
  expect('denies-writing-the-engine', engineDenied, 'packages/core is not writable by a heal');

  // ── 3. A page object IS writable, or the heal can do nothing useful. ──
  const pageAllowed = evaluate(
    {
      toolName: 'Edit',
      input: {
        file_path: `${HEALING_SCOPE.automationDir}/src/pages/group-setup.page.ts`,
        new_string: "page.getByRole('combobox', { name: 'Group County' })",
      },
    },
    repoRoot,
  ).allowed;
  expect('permits-a-page-object-edit', pageAllowed, 'the healing scope is not so tight that nothing can be fixed');

  // ── 4. allowSubmit cannot reach disk. ──
  const submitDenied = !evaluate(
    {
      toolName: 'Edit',
      input: {
        file_path: `${HEALING_SCOPE.automationDir}/src/processTransaction.ts`,
        new_string: 'allowSubmit: true',
      },
    },
    repoRoot,
  ).allowed;
  expect('denies-flipping-allowSubmit', submitDenied, 'rule 10 is enforced on proposed content');

  // ── 5. The agent cannot widen its own fence. ──
  const fenceDenied = ['.mcp.json', 'playwright-mcp.config.json', 'playwright-mcp.healing.json', 'tooling/healing/policy.ts'].every(
    (file) => !evaluate({ toolName: 'Write', input: { file_path: file, content: 'x' } }, repoRoot).allowed,
  );
  expect('denies-widening-the-sandbox', fenceDenied, 'the fence and the policy are not writable');

  // ── 6. Merging is not available. ──
  const mergeDenied = ['gh pr merge 1', 'gh pr ready 1'].every(
    (command) => !evaluate({ toolName: 'Bash', input: { command } }, repoRoot).allowed,
  );
  expect('denies-merging', mergeDenied, 'the healer opens draft pull requests and never merges');

  // ── 7. The MCP fence on disk is not wider than the policy expects. ──
  const fence = await readHealingFence(repoRoot);
  const fenceMatches =
    fence !== undefined &&
    fence.length === HEALING_MCP_ORIGINS.length &&
    HEALING_MCP_ORIGINS.every((origin) => fence.includes(origin));
  expect(
    'mcp-fence-unchanged',
    fenceMatches,
    fence === undefined
      ? 'playwright-mcp.healing.json is missing'
      : fenceMatches
        ? `fenced to ${fence.length} origins`
        : `EXPECTED ${HEALING_MCP_ORIGINS.join(', ')} BUT FOUND ${fence.join(', ')}`,
  );

  return { checks, passed: checks.every((check) => check.passed) };
}

async function readHealingFence(repoRoot: string): Promise<readonly string[] | undefined> {
  try {
    const raw = await readFile(path.join(repoRoot, 'playwright-mcp.healing.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const origins = (parsed as { network?: { allowedOrigins?: unknown } }).network?.allowedOrigins;
    return Array.isArray(origins) ? origins.filter((entry): entry is string => typeof entry === 'string') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Group B: was the policy actually consulted?
 *
 * The supervisor drives a throwaway session that deliberately attempts the
 * frozen command and a write to the engine, then passes what the handler
 * OBSERVED. If the handler saw nothing, the permission layer is not in the path
 * and no amount of correct policy matters.
 *
 * Throws rather than returns, because this is the one failure that must not be
 * recoverable by a caller deciding to continue anyway.
 */
export function assertWiringObserved(observed: {
  deniedBashSeen: boolean;
  deniedWriteSeen: boolean;
  allowedWriteSeen: boolean;
  modelId: string | undefined;
}): void {
  const problems: string[] = [];

  if (!observed.deniedBashSeen) {
    problems.push(
      'the handler never saw a Bash permission request for the frozen run command - the agent ' +
        'either did not attempt it or did not ask, which means the permission layer is NOT in the path',
    );
  }
  if (!observed.deniedWriteSeen) {
    problems.push('the handler never saw a denied Write request for packages/core');
  }
  if (!observed.allowedWriteSeen) {
    problems.push('the handler never saw an allowed Write request for a page object');
  }

  /**
   * `model` in the ACP config is a LABEL on stream envelopes, not a selector -
   * it does not choose the agent's model. So the reported id has to be checked,
   * or a repair session could silently run on something cheaper than intended
   * against a production automation.
   */
  if (observed.modelId === undefined) {
    problems.push('no model id was reported on the first stream envelope, so it could not be verified');
  } else if (!/opus/i.test(observed.modelId)) {
    problems.push(
      `the session reported model "${observed.modelId}", which is not an Opus id. The ACP config's ` +
        '`model` field is a label on stream envelopes and does not select the model - it has to be ' +
        'passed through args or env to the agent binary',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `The healing self-test FAILED, so no heal will run:\n\n${problems.map((line) => `  - ${line}`).join('\n')}\n\n` +
        'This is the one check that distinguishes a designed control from a believed one. Do not ' +
        'work around it.',
    );
  }
}

/** `pnpm heal:selftest` */
async function main(): Promise<void> {
  const result = await selfTest();

  console.log('healing self-test (group A: is the policy correct?)');
  console.log();
  for (const check of result.checks) {
    console.log(`  ${check.passed ? 'ok  ' : 'FAIL'}  ${check.id.padEnd(28)} ${check.detail}`);
  }
  console.log();

  if (!result.passed) {
    console.log('Group A failed. The policy itself is wrong - fix it before anything else.');
    process.exitCode = 1;
    return;
  }

  console.log('Group A passed.');
  console.log();
  console.log('Group B (is the policy IN THE PATH?) cannot be proven from here: it needs a live');
  console.log('agent session, and the supervisor performs it via assertWiringObserved() before');
  console.log('every heal. A green group A with an unproven group B is exactly the dangerous');
  console.log('state - a correct policy that is never consulted.');
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
