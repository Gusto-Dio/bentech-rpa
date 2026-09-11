import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findRepoRoot } from '@rpa/core';
import type { Page } from 'playwright';
import {
  MASK_COLOR,
  MASK_LIST_VERSION,
  VALUE_BEARING_SELECTOR,
  describeMasks,
  redactionMasks,
} from '../../automations/group-submission/anthem-ca-new-plans/src/pages/masks.ts';
import { attachToReconBrowser, detach } from './heal-attach.ts';

/**
 * Captures one half of a masked before/after pair, from the screen the recon
 * browser is parked on.
 *
 *   pnpm tsx tooling/scripts/capture-masked-pair.ts --issue 412 --phase before --label county-picker
 *
 * ── WHY "BEFORE" IS A RE-CAPTURE, NOT THE FAILING RUN'S SCREENSHOT ──────────
 * `mask` is a capture-time option of `page.screenshot()`. The screenshots the
 * failing probe already wrote are therefore UNMASKED and cannot be masked
 * retroactively - they stay in gitignored `artifacts/` and are referenced by
 * path.
 *
 * So "before" is taken from the same screen while the working tree is still at
 * the pre-fix revision, by this same script. One code path producing both
 * halves is what makes the pair comparable; two different capture routines
 * would differ in viewport, mask version or full-page behaviour and the
 * comparison would be of the capture rather than of the portal.
 *
 * ── THE MANIFEST IS THE POINT ───────────────────────────────────────────────
 * Every capture writes bounding boxes for the masks AND for every value-bearing
 * control, so `check-masked-evidence.ts` can prove containment geometrically.
 * That turns "we masked it" from a claim into a computed property.
 * ────────────────────────────────────────────────────────────────────────────
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Manifest {
  issue: number;
  phase: 'before' | 'after';
  label: string;
  url: string;
  capturedAt: string;
  gitRev: string;
  maskListVersion: number;
  maskColor: string;
  viewport: { width: number; height: number };
  maskBoxes: readonly Box[];
  /** One per value-bearing control found, with its label for a useful failure message. */
  valueBearingBoxes: readonly (Box & { describe: string })[];
  maskRules: readonly { selector: string; why: string }[];
  /**
   * Set when the failing screen can no longer be reached read-only. The check
   * script permits a single-sided pair only with this present and explained.
   */
  beforeUnreachable?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();

  const { browser, page } = await attachToReconBrowser();

  try {
    const dir = path.join(repoRoot, 'artifacts', 'heal', String(args.issue));
    await mkdir(dir, { recursive: true });

    const base = path.join(dir, `${args.label}.${args.phase}`);
    const masks = redactionMasks(page, { payloadStrings: args.payloadStrings });

    /**
     * Boxes collected BEFORE the screenshot, from the same live DOM the
     * screenshot will capture. Collecting them afterwards would race a
     * re-render and could report a control as covered that had moved.
     */
    const maskBoxes = await collectMaskBoxes(masks);
    const valueBearingBoxes = await collectValueBearingBoxes(page);

    await page.screenshot({
      path: `${base}.masked.png`,
      fullPage: true,
      mask: masks,
      maskColor: MASK_COLOR,
    });

    const viewport = page.viewportSize() ?? { width: 0, height: 0 };

    const manifest: Manifest = {
      issue: args.issue,
      phase: args.phase,
      label: args.label,
      url: page.url(),
      capturedAt: new Date().toISOString(),
      gitRev: await gitRev(),
      maskListVersion: MASK_LIST_VERSION,
      maskColor: MASK_COLOR,
      viewport,
      maskBoxes,
      valueBearingBoxes,
      maskRules: describeMasks(),
      ...(args.beforeUnreachable === undefined ? {} : { beforeUnreachable: args.beforeUnreachable }),
    };

    await writeFile(`${base}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(`captured ${args.phase}: ${path.relative(repoRoot, `${base}.masked.png`)}`);
    console.log(`  url             : ${manifest.url}`);
    console.log(`  git rev         : ${manifest.gitRev}`);
    console.log(`  mask list       : v${manifest.maskListVersion}`);
    console.log(`  masks           : ${maskBoxes.length} region(s)`);
    console.log(`  value controls  : ${valueBearingBoxes.length}`);
    console.log();
    console.log('Now run check-masked-evidence.ts. It will refuse the pair if any value-bearing');
    console.log('control is not fully inside the masked area - nothing gets committed unchecked.');
  } finally {
    await detach(browser);
  }
}

/**
 * Playwright masks the bounding box of every element a mask locator resolves,
 * so the union of these boxes is exactly what ends up painted over.
 */
async function collectMaskBoxes(masks: readonly ReturnType<typeof redactionMasks>[number][]): Promise<readonly Box[]> {
  const boxes: Box[] = [];

  for (const mask of masks) {
    for (const element of await mask.all()) {
      const box = await element.boundingBox().catch(() => null);
      if (box !== null) boxes.push(box);
    }
  }

  return boxes;
}

async function collectValueBearingBoxes(page: Page): Promise<readonly (Box & { describe: string })[]> {
  const boxes: (Box & { describe: string })[] = [];

  for (const element of await page.locator(VALUE_BEARING_SELECTOR).all()) {
    const box = await element.boundingBox().catch(() => null);
    /**
     * A zero-size element is not on screen and therefore not in the image.
     * Vlocity pre-renders every branch, so most of these are hidden - counting
     * them would make the coverage check fail on controls that were never
     * visible.
     */
    if (box === null || box.width === 0 || box.height === 0) continue;

    const describe = await element
      .evaluate((node) => {
        const el = node as unknown as { getAttribute: (n: string) => string | null; tagName: string; id: string };
        return (
          el.getAttribute('aria-label') ??
          el.getAttribute('name') ??
          el.getAttribute('placeholder') ??
          el.id ??
          el.tagName.toLowerCase()
        );
      })
      .catch(() => 'unknown');

    boxes.push({ ...box, describe: String(describe).slice(0, 60) });
  }

  return boxes;
}

async function gitRev(): Promise<string> {
  /**
   * Read from the filesystem rather than by running `git`. The healing policy
   * denies compound and unlisted shell commands, and a capture script that
   * needed to shell out would be one more thing to allow-list.
   */
  const { readFile } = await import('node:fs/promises');
  const repoRoot = findRepoRoot();

  try {
    const head = (await readFile(path.join(repoRoot, '.git', 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 12);
    const ref = head.slice(5).trim();
    const sha = (await readFile(path.join(repoRoot, '.git', ref), 'utf8')).trim();
    return sha.slice(0, 12);
  } catch {
    return '(unknown)';
  }
}

interface Args {
  issue: number;
  phase: 'before' | 'after';
  label: string;
  payloadStrings: readonly string[];
  beforeUnreachable: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const issue = Number(get('issue'));
  const phase = get('phase');
  const label = get('label');

  if (!Number.isInteger(issue) || issue <= 0 || (phase !== 'before' && phase !== 'after') || label === undefined) {
    console.error(
      'usage: capture-masked-pair.ts --issue <n> --phase before|after --label <slug>\n' +
        '                            [--payload "<value>" ...] [--before-unreachable "<why>"]',
    );
    process.exit(2);
  }

  const payloadStrings: string[] = [];
  for (const [index, token] of argv.entries()) {
    if (token === '--payload') {
      const value = argv[index + 1];
      if (value !== undefined) payloadStrings.push(value);
    }
  }

  return {
    issue,
    phase,
    label: label.replace(/[^A-Za-z0-9._-]+/g, '-'),
    payloadStrings,
    beforeUnreachable: get('before-unreachable'),
  };
}

await main();
