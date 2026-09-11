/**
 * Scrubbing, and why it runs BEFORE every other normalization step.
 *
 * A sentinel reads real screens from a signed-in production portal. Those
 * screens carry a licensed producer's name, an agency code that doubles as an
 * encrypted TIN, group names, FEINs, phone numbers and email addresses. The
 * readings become committed baselines and GitHub issue bodies, so rule 2 ("no
 * PII, no real customer data, anywhere") applies to them exactly as it applies
 * to a seed file.
 *
 * ── ORDER IS LOAD-BEARING ───────────────────────────────────────────────────
 * Known secret VALUES are replaced first, before the generic class patterns.
 * Do it the other way round and a rule like `\d{4,}` -> `<num>` can consume
 * part of an agency code, leaving a fragment that the exact-value pass then no
 * longer recognises - so a partially-scrubbed identifier survives into a
 * committed file. Scrubbing the specific before the general is what stops a
 * generic rule from hiding a specific one.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Replaces the resolved values of the environment variables this automation
 * signs in with, plus anything shaped like PII.
 *
 * Built from values, not from variable names, because the value is what appears
 * on screen. The names are never interesting; `SecretResolver` already keeps
 * config free of values, and this is the mirror-image concern - keeping
 * OUTPUT free of them.
 */
export interface Redactor {
  /** Scrubs one string. Returns it unchanged when there was nothing to do. */
  text(value: string): string;
  /** Scrubs every string in a structure, in place of a JSON round trip. */
  deep<T>(value: T): T;
  /**
   * Does this text still contain a known secret value?
   *
   * The fail-closed check every writer runs before committing anything. It
   * looks for the exact values only: a class pattern surviving is a scrubbing
   * bug worth fixing, but a producer's actual name surviving is an incident.
   */
  leaks(value: string): boolean;
}

export interface RedactorOptions {
  /**
   * Resolved secret values to remove wherever they appear, mapped to the token
   * that replaces them. Longest first is applied automatically, so a value that
   * contains another cannot leave the shorter one behind.
   */
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Patterns for things we cannot enumerate by value.
 *
 * A group's name or a contact's name is not in `.env`, so no exact-value pass
 * can find it. These catch the shapes instead. They are deliberately broad:
 * an over-scrub costs a reviewer one question, an under-scrub is permanent once
 * committed, and that asymmetry is the same one `PROBLEM_WORDING` was widened
 * for after Anthem's real SIC message never matched.
 */
const CLASS_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // Email before anything digit-shaped, or the local part can be mangled first.
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>'],
  // SSN before the generic digit runs, and before EIN: 9 digits punctuated 3-2-4.
  [/\b\d{3}-\d{2}-\d{4}\b/g, '<ssn>'],
  // EIN / TIN, punctuated 2-7.
  [/\b\d{2}-\d{7}\b/g, '<tin>'],
  /**
   * One pattern, three shapes, and the bracket branch is why it cannot
   * simply start with `\b`: there is no word boundary between a space and a
   * `(`, so an optional `\(?` never fires and `(415) 555-0134` scrubs to
   * `(<phone>` - leaving the bracket as a tell. The `+1` prefix has the same
   * problem, hence it sits outside the boundary too.
   *
   * The separator between prefix and line number stays MANDATORY so ten
   * unpunctuated digits are not read as a phone number; the generic digit
   * run catches those.
   */
  [/(?:\+1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]\d{4}\b/g, '<phone>'],
  [/\$\s?\d[\d,]*(?:\.\d{2})?/g, '<money>'],
  // ZIP+4 before plain ZIP, or the suffix is left dangling.
  [/\b\d{5}-\d{4}\b/g, '<zip>'],
  [/\b\d{5}\b/g, '<zip>'],
];

/**
 * Volatility, not privacy: values that change between two readings of a screen
 * that has not actually changed. Left in a signature they would report drift on
 * every single run.
 */
const VOLATILE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // ── Generated ids. All four families are measured, not guessed. ──
  // Vlocity carries a re-render counter: `vlocity-radio-0-1-110`.
  [/\bvlocity-[a-z]+-\d+(?:-\d+)*\b/gi, 'vlocity-<gen>'],
  [/\bcomboboxId-\d+\b/g, 'comboboxId-<gen>'],
  // Okta's generated field ids: `input60`.
  [/\binput\d+\b/g, 'input<gen>'],

  // ── Counters and progress. A screen at 40% is the same screen as at 60%. ──
  [/\bProgress:\s*\d+\s*%/gi, 'Progress: <n>%'],
  [/\b\d+\s+out\s+of\s+\d+\b/gi, '<n> out of <n>'],
  [/\b\d+\s+of\s+\d+\b/gi, '<n> of <n>'],
  // "This code expires in 4:37" - the countdown, which moves every second.
  [/\bexpires? in \d{1,2}:\d{2}\b/gi, 'expires in <mm:ss>'],

  // ── Dates and times. ──
  [/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<datetime>'],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '<date>'],
  [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi,
    '<date>',
  ],
  [/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)\b/gi, '<time>'],

  /**
   * Quote numbers. Anthem's are eight digits with a leading zero, which the
   * generic digit-run rule below would also catch - but naming them keeps a
   * signature diff readable rather than turning every identifier into `<num>`.
   */
  [/\b0\d{7}\b/g, '<quote>'],

  // Long digit runs, LAST, so nothing more specific is pre-empted.
  [/\b\d{4,}\b/g, '<num>'],
];

export function createRedactor(options: RedactorOptions): Redactor {
  /**
   * Longest first. `ANTHEM_PRODUCER_LAST_NAME` could be a substring of a
   * combined "First Last" value, and replacing the short one first would leave
   * the long one unmatchable.
   */
  const exact = Object.entries(options.values)
    .filter(([value]) => value.trim().length >= MIN_SECRET_LENGTH)
    .sort(([a], [b]) => b.length - a.length)
    .map(([value, token]) => [new RegExp(escapeRegExp(value), 'gi'), token] as const);

  const text = (value: string): string => {
    let out = value;
    for (const [pattern, token] of exact) out = out.replace(pattern, token);
    for (const [pattern, token] of CLASS_PATTERNS) out = out.replace(pattern, token);
    for (const [pattern, token] of VOLATILE_PATTERNS) out = out.replace(pattern, token);
    return out;
  };

  return {
    text,
    deep: <T,>(value: T): T => mapStrings(value, text) as T,
    leaks: (value: string): boolean =>
      exact.some(([pattern]) => {
        // A global regex carries lastIndex between calls, so reset it.
        pattern.lastIndex = 0;
        return pattern.test(value);
      }),
  };
}

/**
 * Below this, an "exact value" does more harm than good.
 *
 * A one- or two-character secret - an empty env var, or a producer initial -
 * would match almost every word on the page and turn a signature into a row of
 * tokens, which hides real drift rather than protecting anything.
 */
const MIN_SECRET_LENGTH = 3;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Walks arrays and plain objects, rewriting every string leaf. */
function mapStrings(value: unknown, rewrite: (input: string) => string): unknown {
  if (typeof value === 'string') return rewrite(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, rewrite));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, rewrite)]),
    );
  }
  return value;
}
