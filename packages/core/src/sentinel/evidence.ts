import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Redactor } from './redact.ts';
import { findLeak } from './signature.ts';
import type { ProbeEvidence, ScreenBaseline, ScreenSignature } from './types.ts';

/**
 * Where a probe's evidence goes, and what is allowed to leave the host.
 *
 * ── A CLEAN PASS WRITES NOTHING ─────────────────────────────────────────────
 * The access probe runs every fifteen minutes - ninety-six times a day, times
 * however many carriers. If each of those left a directory behind, `artifacts/`
 * would become the append-only audit store `AGENTS.md` explicitly lists as
 * deliberately absent, by accident and without anyone deciding to build one.
 *
 * So: a pass with no meaningful drift writes a log line and nothing else.
 * Evidence exists for findings.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface EvidenceStoreOptions {
  /** Absolute path to `<repoRoot>/artifacts`. */
  artifactsDir: string;
  runId: string;
  logger: Logger;
}

/** What was written, for the issue body to cite by path. */
export interface WrittenEvidence {
  /** Repo-relative, because that is what a reader needs in an issue. */
  dir: string;
  files: readonly string[];
}

export class EvidenceStore {
  readonly #root: string;
  readonly #runId: string;
  readonly #logger: Logger;

  constructor(options: EvidenceStoreOptions) {
    /**
     * Under `artifacts/sentinel/` rather than directly in `artifacts/<runId>/`.
     *
     * A real run's directory and a probe's would otherwise be indistinguishable
     * by name, and the pruning below deletes by age - pointing that at the same
     * tree that holds a failed submission's trace would be an unpleasant
     * surprise.
     */
    this.#root = path.join(options.artifactsDir, 'sentinel');
    this.#runId = options.runId;
    this.#logger = options.logger;
  }

  /** Absolute directory for one probe's evidence within this run. */
  dirFor(probeId: string): string {
    return path.join(this.#root, this.#runId, slug(probeId));
  }

  /**
   * Writes the full record plus one file per screen.
   *
   * Refuses, loudly, if a known secret value survived redaction anywhere in the
   * record. Rule 2 is not a thing to warn about and carry on past, and the
   * moment to stop is before the bytes hit a disk that a human will later
   * copy-paste out of.
   */
  async write(
    evidence: ProbeEvidence,
    screens: readonly { screenId: string; redactedReading: unknown }[],
    redactor: Redactor,
  ): Promise<WrittenEvidence> {
    const dir = this.dirFor(evidence.probeId);

    for (const screen of evidence.screens) {
      const leak = findLeak(screen.signature, redactor);
      if (leak !== undefined) {
        throw new Error(
          `Refusing to write evidence for ${evidence.probeId}: a known secret value survived ` +
            `redaction at ${screen.screenId}.${leak}. Fix the redactor, not this check.`,
        );
      }
    }

    await mkdir(dir, { recursive: true });
    const written: string[] = [];

    await writeFile(path.join(dir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    written.push('evidence.json');

    for (const screen of evidence.screens) {
      const name = `signature.${slug(screen.screenId)}.json`;
      await writeFile(path.join(dir, name), `${JSON.stringify(screen.signature, null, 2)}\n`, 'utf8');
      written.push(name);
    }

    /**
     * The redacted raw reading, separately from the signature.
     *
     * The signature is normalized for COMPARISON - dates become `<date>`,
     * counters become `<n>` - which is exactly wrong for a human trying to
     * understand a screen. The reading keeps the portal's own wording, which
     * `gate-evidence.ts` already argues is the highest-value thing on a failing
     * screen.
     */
    for (const screen of screens) {
      const name = `screen.${slug(screen.screenId)}.json`;
      const scrubbed = redactor.deep(screen.redactedReading);
      await writeFile(path.join(dir, name), `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
      written.push(name);
    }

    this.#logger.info({ dir, files: written.length }, 'Wrote sentinel evidence');
    return { dir, files: written };
  }

  /**
   * Deletes evidence older than `days`.
   *
   * Bounded retention rather than none, because the alternative is either an
   * unbounded directory or an audit store nobody approved. Fourteen days is
   * long enough to investigate a finding that took a week to be noticed, and
   * the GitHub issue is the durable record either way.
   */
  async prune(days: number): Promise<number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;

    const runs = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
    for (const entry of runs) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.#root, entry.name);
      const stats = await stat(dir).catch(() => undefined);
      if (stats === undefined || stats.mtimeMs >= cutoff) continue;

      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }

    if (removed > 0) this.#logger.info({ removed, days }, 'Pruned old sentinel evidence');
    return removed;
  }
}

export interface BaselineStoreOptions {
  /** Absolute path to `<automationDir>/sentinel/baselines`. */
  dir: string;
  logger: Logger;
}

/**
 * Reads and writes the committed screen baselines.
 *
 * These are tracked files, reviewed in a pull request, and the JSON diff IS the
 * review artifact - which is why they are written sorted and pretty-printed
 * rather than compactly.
 */
export class BaselineStore {
  readonly #dir: string;
  readonly #logger: Logger;

  constructor(options: BaselineStoreOptions) {
    this.#dir = options.dir;
    this.#logger = options.logger;
  }

  fileFor(screenId: string): string {
    return path.join(this.#dir, `${slug(screenId)}.json`);
  }

  /** `undefined` means no baseline, which is itself a finding rather than an error. */
  async read(screenId: string): Promise<ScreenBaseline | undefined> {
    const file = this.fileFor(screenId);

    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return undefined;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isBaseline(parsed)) throw new Error('not a baseline document');
      return parsed;
    } catch (cause) {
      /**
       * Treated as absent rather than fatal, and logged. A hand-edited baseline
       * that no longer parses should produce "this screen is unbaselined",
       * which a human will act on - not a wedged monitor, which they will mute.
       */
      this.#logger.warn({ file, err: cause }, 'Baseline file is unreadable; treating the screen as unbaselined');
      return undefined;
    }
  }

  /**
   * Writes a blessed baseline.
   *
   * The caller is responsible for refusing to bless a failing verdict, a
   * missing note, or a non-interactive session - those are policy, and they
   * live in the CLI where the operator can see them. This is the file layer.
   */
  async write(signature: ScreenSignature, provenance: ScreenBaseline['provenance']): Promise<string> {
    const file = this.fileFor(signature.screenId);
    await mkdir(this.#dir, { recursive: true });
    const document: ScreenBaseline = { signature, provenance };
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    this.#logger.info({ file, screenId: signature.screenId }, 'Blessed a screen baseline');
    return file;
  }
}

function isBaseline(value: unknown): value is ScreenBaseline {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { signature?: unknown; provenance?: unknown };
  if (candidate.signature === null || typeof candidate.signature !== 'object') return false;
  if (candidate.provenance === null || typeof candidate.provenance !== 'object') return false;
  const signature = candidate.signature as { screenId?: unknown; version?: unknown };
  return typeof signature.screenId === 'string' && typeof signature.version === 'number';
}

/** Keeps a probe or screen id usable as a path segment without losing which it was. */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unnamed';
}
