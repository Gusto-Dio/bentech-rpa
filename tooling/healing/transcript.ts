import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { REDACT_PATHS } from '@rpa/core';

/**
 * The audit log of one repair session.
 *
 * ── WHY A TRANSCRIPT AT ALL ─────────────────────────────────────────────────
 * An unattended agent editing a production automation is only reviewable if
 * what it was ALLOWED to do, and what it was refused, is recorded. The pull
 * request shows the diff; the transcript shows the attempts - including the
 * ones that were denied, which are often the more interesting half. Three
 * consecutive denials is itself a signal that the agent is arguing with a wall
 * rather than diagnosing.
 *
 * ── WHERE IT LIVES, AND WHERE IT DOES NOT GO ────────────────────────────────
 * Gitignored `artifacts/heal/<issue>/transcript.jsonl` on the healing host. The
 * pull request links its path and quotes the decision table; the file itself is
 * never uploaded, because a tool call's raw input can carry a portal URL with a
 * group's record id in it.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type TranscriptEvent =
  | {
      kind: 'permission';
      tool: string;
      decision: 'allow' | 'deny';
      ruleId: string;
      reason: string;
      /**
       * The tool input as given. Scrubbed structurally on the way out - see
       * `#scrub` - rather than pre-stringified by the caller, because once it
       * is a string the field names are behind escaped quotes and name-based
       * scrubbing silently stops matching.
       */
      input: unknown;
    }
  | { kind: 'tool-call'; tool: string; status: 'started' | 'finished' | 'failed' }
  | { kind: 'state'; state: string }
  | { kind: 'model'; modelId: string }
  | { kind: 'phase'; phase: string; detail?: string }
  | { kind: 'error'; message: string };

export interface TranscriptOptions {
  /** Absolute path to `artifacts/heal/<issue>`. */
  dir: string;
  /** Values to scrub. The same set the sentinel's redactor uses. */
  secretValues: readonly string[];
}

export class Transcript {
  readonly #file: string;
  readonly #secrets: readonly string[];
  #denialStreak = 0;

  constructor(options: TranscriptOptions) {
    this.#file = path.join(options.dir, 'transcript.jsonl');
    /** Longest first, so a value containing another cannot strand the shorter. */
    this.#secrets = [...options.secretValues]
      .filter((value) => value.trim().length >= 3)
      .sort((a, b) => b.length - a.length);
  }

  /** How many permission requests have been denied back to back. */
  get denialStreak(): number {
    return this.#denialStreak;
  }

  async record(event: TranscriptEvent): Promise<void> {
    if (event.kind === 'permission') {
      this.#denialStreak = event.decision === 'deny' ? this.#denialStreak + 1 : 0;
    }

    await mkdir(path.dirname(this.#file), { recursive: true });
    await appendFile(
      this.#file,
      `${JSON.stringify({ at: new Date().toISOString(), ...this.#scrub(event) })}\n`,
      'utf8',
    );
  }

  /**
   * Scrubs known secret values and anything matching the platform's own redact
   * paths.
   *
   * Reusing `REDACT_PATHS` rather than inventing a second list matters: that
   * list is where "which field names are sensitive here" already lives, and two
   * lists would diverge on the day someone adds a field to one of them.
   */
  #scrub(event: TranscriptEvent): TranscriptEvent {
    if (event.kind !== 'permission') return event;
    return { ...event, input: JSON.stringify(this.#scrubValue(event.input)).slice(0, 600) };
  }

  /**
   * Walks the structure, replacing sensitive VALUES by name and known secret
   * values wherever they appear.
   *
   * Structural rather than textual, and that is the whole point: an earlier
   * version scrubbed the stringified form, where `"password"` has become
   * `\"password\"` and a name-based pattern silently matches nothing. The bug
   * was invisible - the transcript looked scrubbed because the SECRET-value
   * pass still worked, while every field-name rule had quietly stopped firing.
   */
  #scrubValue(value: unknown, keyName?: string): unknown {
    if (typeof value === 'string') {
      if (keyName !== undefined && SENSITIVE_FIELD_NAMES.has(keyName.toLowerCase())) {
        return '[REDACTED]';
      }

      let out = value;
      for (const secret of this.#secrets) out = out.split(secret).join('<redacted>');

      /**
       * A nested JSON document arriving as a string - a file's proposed
       * content, typically. Parsed and scrubbed rather than left alone, because
       * "the credential was inside a string" is not a reason to keep it.
       */
      const trimmed = out.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.stringify(this.#scrubValue(JSON.parse(trimmed)));
        } catch {
          // Not JSON after all. The secret-value pass above still applied.
        }
      }

      return out;
    }

    if (Array.isArray(value)) return value.map((entry) => this.#scrubValue(entry));

    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.#scrubValue(entry, key)]),
      );
    }

    return value;
  }
}

/**
 * Field names worth scrubbing from a tool input, derived from the platform's
 * own `REDACT_PATHS` rather than guessed.
 */
const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set(
  REDACT_PATHS.flatMap((entry) => entry.split('.'))
    .filter((segment) => segment !== '' && segment !== '*' && !segment.includes('['))
    .map((segment) => segment.replace(/\[\]$/, '').toLowerCase()),
);

/** A compact decision table for the pull-request body. */
export function summariseDecisions(
  events: readonly TranscriptEvent[],
): { allowed: number; denied: number; byRule: Record<string, number> } {
  const byRule: Record<string, number> = {};
  let allowed = 0;
  let denied = 0;

  for (const event of events) {
    if (event.kind !== 'permission') continue;
    if (event.decision === 'allow') allowed += 1;
    else denied += 1;
    byRule[event.ruleId] = (byRule[event.ruleId] ?? 0) + 1;
  }

  return { allowed, denied, byRule };
}
