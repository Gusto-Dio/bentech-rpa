import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findRepoRoot } from '@rpa/core';
import { isCovered, type Box } from '../healing/mask-coverage.ts';

/**
 * Proves a masked before/after pair is safe to commit. Pure geometry.
 *
 *   pnpm tsx tooling/scripts/check-masked-evidence.ts --issue 412 --label county-picker
 *
 * ── WHY THIS IS THE STRONGEST PART OF THE EVIDENCE PIPELINE ─────────────────
 * These two PNGs get committed to the repository so a reviewer can see the pair
 * in the pull request. That means a masking miss is permanent git history, and
 * "we masked it" as an assertion is not good enough.
 *
 * So the capture writes a bounding box for every mask AND for every visible
 * value-bearing control, and this asserts each control is fully inside the
 * union of the masks. No image decoding, no new dependency - just containment.
 * A claim becomes a computed property.
 *
 * ── AND WHAT IT STILL CANNOT PROVE ──────────────────────────────────────────
 * It verifies coverage of the boxes it FOUND. A value rendered somewhere the
 * value-bearing selector does not reach - inside a canvas, a background image,
 * an `svg <text>`, a `::after` content string - would not appear in
 * `valueBearingBoxes` and so would not be flagged. That residual risk is why
 * the mask list is deny-by-default, why only two images per heal are permitted,
 * and why the pull-request template asks the reviewer to confirm no values are
 * visible. This check narrows the risk; it does not eliminate it, and the
 * template says so.
 * ────────────────────────────────────────────────────────────────────────────
 */

interface Manifest {
  issue: number;
  phase: 'before' | 'after';
  label: string;
  url: string;
  gitRev: string;
  maskListVersion: number;
  viewport: { width: number; height: number };
  maskBoxes: readonly Box[];
  valueBearingBoxes: readonly (Box & { describe: string })[];
  beforeUnreachable?: string;
}

interface Problem {
  severity: 'fail' | 'warn';
  message: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();
  const dir = path.join(repoRoot, 'artifacts', 'heal', String(args.issue));

  const before = await readManifest(path.join(dir, `${args.label}.before.manifest.json`));
  const after = await readManifest(path.join(dir, `${args.label}.after.manifest.json`));

  const problems: Problem[] = [];

  console.log(`check-masked-evidence  issue #${args.issue}  label "${args.label}"`);
  console.log();

  // ── 1. Coverage, per side. ──
  for (const [phase, manifest] of [['before', before], ['after', after]] as const) {
    if (manifest === undefined) continue;

    const uncovered = manifest.valueBearingBoxes.filter(
      (box) => !isCovered(box, manifest.maskBoxes),
    );

    console.log(
      `  ${uncovered.length === 0 ? 'ok  ' : 'FAIL'}  ${phase.padEnd(7)} ` +
        `${manifest.valueBearingBoxes.length} value-bearing control(s), ` +
        `${manifest.valueBearingBoxes.length - uncovered.length} covered by ${manifest.maskBoxes.length} mask(s)`,
    );

    for (const box of uncovered) {
      problems.push({
        severity: 'fail',
        message:
          `${phase}: "${box.describe}" at (${Math.round(box.x)},${Math.round(box.y)}) ` +
          `${Math.round(box.width)}x${Math.round(box.height)} is NOT fully masked`,
      });
    }
  }

  // ── 2. Is it actually a pair? ──
  if (after === undefined) {
    problems.push({ severity: 'fail', message: 'there is no "after" capture, so there is nothing to compare' });
  } else if (before === undefined) {
    /**
     * A single-sided pair is legitimate but must be declared. Everything past
     * `Create Quote` on a fresh group, the DocuSign ceremony and the
     * in-progress-application redirect are all unreachable read-only, so this
     * will be a normal outcome - but it has to be a stated one, not an omission.
     */
    if (after.beforeUnreachable === undefined || after.beforeUnreachable.trim() === '') {
      problems.push({
        severity: 'fail',
        message:
          'there is no "before" capture and no --before-unreachable reason. If the failing screen ' +
          'cannot be reached read-only, say so explicitly: the PR then carries a TEXT before/after ' +
          'from the READ_DIAGNOSTICS readings instead, which is often the higher-signal artifact ' +
          'anyway',
      });
    } else {
      console.log(`  warn  single-sided pair, declared: ${after.beforeUnreachable}`);
    }
  } else {
    // ── 3. The pair must be comparable. ──
    if (before.url !== after.url) {
      problems.push({
        severity: 'fail',
        message: `the two captures are of different screens (${before.url} vs ${after.url})`,
      });
    }
    if (before.maskListVersion !== after.maskListVersion) {
      problems.push({
        severity: 'fail',
        message:
          `mask list v${before.maskListVersion} vs v${after.maskListVersion} - a pair redacted under ` +
          'two different rule sets is not a comparison',
      });
    }
    if (before.viewport.width !== after.viewport.width || before.viewport.height !== after.viewport.height) {
      problems.push({ severity: 'fail', message: 'the two captures used different viewports' });
    }

    /**
     * A "pair" that is secretly two captures of the same revision proves
     * nothing at all - it is the same screen photographed twice, presented as
     * evidence that a change worked.
     */
    if (before.gitRev === after.gitRev && before.gitRev !== '(unknown)') {
      problems.push({
        severity: 'fail',
        message:
          `both captures are at git rev ${before.gitRev}, so nothing changed between them. A pair ` +
          'must be taken before and after the fix',
      });
    }
  }

  console.log();

  const failures = problems.filter((problem) => problem.severity === 'fail');
  for (const problem of problems) {
    console.log(`  ${problem.severity === 'fail' ? 'FAIL' : 'warn'}  ${problem.message}`);
  }

  if (failures.length > 0) {
    console.log();
    console.log(`${failures.length} problem(s). The pair must NOT be committed.`);
    console.log('Fix the mask list (src/pages/masks.ts) and re-capture. Do not relax this check:');
    console.log('these images go into git history, where a masking miss is permanent.');
    process.exitCode = 1;
    return;
  }

  console.log('  OK - every visible value-bearing control is inside the masked area.');
  console.log();
  console.log('Remember what this does NOT prove: it verifies the boxes it found. A value drawn');
  console.log('into a canvas, a background image or an svg <text> would not be among them. The');
  console.log('reviewer checklist asks for a human confirmation for exactly that reason.');
}

async function readManifest(file: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

function parseArgs(argv: readonly string[]): { issue: number; label: string } {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const issue = Number(get('issue'));
  const label = get('label');

  if (!Number.isInteger(issue) || issue <= 0 || label === undefined) {
    console.error('usage: check-masked-evidence.ts --issue <n> --label <slug>');
    process.exit(2);
  }

  return { issue, label };
}

await main();
