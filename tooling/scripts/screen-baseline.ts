import path from 'node:path';
import {
  BaselineStore,
  buildSignature,
  createLogger,
  createRedactor,
  diffSignatures,
  findLeak,
  findRepoRoot,
  SecretResolver,
} from '@rpa/core';
import { readScreen } from '../../automations/group-submission/anthem-ca-new-plans/src/pages/read-screen.ts';
import { isPortalComplaint } from '../../automations/group-submission/anthem-ca-new-plans/src/pages/portal-errors.ts';
import { attachToReconBrowser, detach } from './heal-attach.ts';

/**
 * Reads the screen the recon browser is on, and either records it as a baseline
 * or diffs it against the recorded one.
 *
 *   pnpm tsx tooling/scripts/screen-baseline.ts diff  --screen ptb-dashboard
 *   pnpm tsx tooling/scripts/screen-baseline.ts write --screen ptb-dashboard --note "why"
 *
 * ── WHY THIS IS SEPARATE FROM `rpa sentinel --bless` ────────────────────────
 * `rpa sentinel --bless` records what a PROBE saw, which means walking a probe's
 * whole route. This records what is on screen RIGHT NOW, from a browser a human
 * or an agent has parked somewhere - which is the only way to baseline a screen
 * that no probe can reach without writing to the portal.
 *
 * The two share the signature builder, the redactor and the baseline store, so
 * a baseline written either way is the same document.
 * ────────────────────────────────────────────────────────────────────────────
 */

const AUTOMATION_DIR = path.join('automations', 'group-submission', 'anthem-ca-new-plans');

async function main(): Promise<void> {
  const mode = process.argv[2];
  const screenId = flag('screen');
  const note = flag('note');

  if ((mode !== 'write' && mode !== 'diff') || screenId === undefined) {
    console.error(
      'usage: screen-baseline.ts diff  --screen <screenId>\n' +
        '       screen-baseline.ts write --screen <screenId> --note "<why>"',
    );
    process.exit(2);
  }

  const repoRoot = findRepoRoot();
  const logger = createLogger({ level: 'warn', pretty: true, base: {} });
  const secrets = new SecretResolver();

  /**
   * The redactor is built from resolved secret VALUES, because the value is
   * what appears on screen. A missing one is fine - it cannot appear either.
   */
  const values: Record<string, string> = {};
  for (const [name, token] of [
    ['ANTHEM_PORTAL_USERNAME', '<user>'],
    ['ANTHEM_PRODUCER_FIRST_NAME', '<producer.first>'],
    ['ANTHEM_PRODUCER_LAST_NAME', '<producer.last>'],
    ['ANTHEM_PAID_AGENCY_CODE', '<agency.code>'],
  ] as const) {
    const value = await secrets.optional(name);
    if (value !== undefined && value.trim() !== '') values[value] = token;
  }
  const redactor = createRedactor({ values });

  const { browser, page } = await attachToReconBrowser();

  try {
    const raw = await readScreen(page);
    if (raw === undefined) {
      console.error('Could not read the screen. Is the browser on a rendered page?');
      process.exitCode = 1;
      return;
    }

    const signature = buildSignature(raw, {
      screenId,
      redactor,
      /** The carrier's own classifier, inverted - never a second string list. */
      isInformationalAlert: (text) => !isPortalComplaint(text),
    });

    /** Fail closed. A baseline is a tracked file, and rule 2 applies to it. */
    const leak = findLeak(signature, redactor);
    if (leak !== undefined) {
      console.error(
        `Refusing to continue: a known secret value survived redaction at ${leak}.\n` +
          'Fix the redactor rather than this check - a baseline is committed, and a leak there is ' +
          'permanent git history.',
      );
      process.exitCode = 1;
      return;
    }

    const store = new BaselineStore({
      dir: path.join(repoRoot, AUTOMATION_DIR, 'sentinel', 'baselines'),
      logger,
    });

    if (mode === 'diff') {
      const baseline = await store.read(screenId);

      if (baseline === undefined) {
        console.log(`No baseline for "${screenId}". This screen has never been recorded.`);
        console.log();
        console.log(JSON.stringify(signature, null, 2));
        return;
      }

      const delta = diffSignatures(baseline.signature, signature);

      console.log(`screen-baseline diff  "${screenId}"`);
      console.log(`  baseline blessed ${baseline.provenance.blessedAt}: ${baseline.provenance.note}`);
      console.log();

      if (delta.changes.length === 0) {
        console.log('  identical.');
        return;
      }

      for (const change of delta.changes) {
        console.log(
          `  ${change.meaningful ? 'MEANINGFUL' : 'noise     '}  ${change.key} ${change.direction}  ${change.value}`,
        );
        if (change.noiseReason !== undefined) console.log(`              (${change.noiseReason})`);
      }

      console.log();
      console.log(`  shape: ${delta.shape === '' ? '(no meaningful changes)' : delta.shape}`);
      process.exitCode = delta.meaningful ? 1 : 0;
      return;
    }

    // ── write ──
    if (note === undefined || note.trim() === '') {
      console.error(
        'Refusing to write a baseline without --note. A baseline with no note cannot be told ' +
          'apart from one recorded to make a failing check go green.',
      );
      process.exitCode = 2;
      return;
    }

    const file = await store.write(signature, {
      blessedAt: new Date().toISOString(),
      runId: 'recon',
      probeId: 'screen-baseline',
      signatureVersion: signature.version,
      note: note.trim(),
    });

    console.log(`wrote ${path.relative(repoRoot, file)}`);
    console.log('Commit it with the fix, so the JSON diff is part of the review.');
  } finally {
    await detach(browser);
  }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

await main();
