/**
 * Reading the drift log, so a finding arrives with its own history attached.
 *
 * ── WHY THIS IS WORTH A PARSER ──────────────────────────────────────────────
 * `docs/poc/<carrier>/drift-log.md` holds around 130 rows of "what the portal
 * actually does" - including several that retract an earlier, wrong diagnosis of
 * the very same failure. Whoever picks up a portal-drift issue, human or agent,
 * should not have to go and find that. The three most relevant rows quoted in
 * the issue body is the difference between debugging a screen and re-debugging
 * one somebody already understood.
 *
 * The log's own header states the norm this serves: "An empty drift log after
 * re-mapping a week-old runbook against a live portal means the re-mapping did
 * not happen."
 *
 * Kept deliberately simple. This is a relevance heuristic for a report, not a
 * search engine, and a wrong ranking costs a reader one glance.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface DriftLogRow {
  /** 1-indexed line in the source file, so the issue can cite it. */
  line: number;
  date: string;
  /** Column 2: the step as documented, or `(not documented)` / `(our bug)`. */
  documented: string;
  /** Column 3: what the portal actually does. The highest-value column. */
  actual: string;
  /** Column 4: what the automation does about it now. */
  now: string;
  /**
   * The log's own honesty vocabulary, lifted out of column 2.
   *
   * `(our bug)` and `(root cause, third and correct reading)` are load-bearing
   * signals: a row tagged `(our bug)` says the portal was fine and we were
   * wrong, which is exactly the hypothesis a repair session should weigh
   * earliest.
   */
  tags: readonly string[];
}

/**
 * Parses the four-column tables out of a drift log.
 *
 * Tolerant by design: the file has several `### <date> — <prose>` section
 * headers between tables, repeats its header row per section, and carries a
 * worked example under "How to add an entry". Anything that is not a
 * four-column data row is skipped rather than treated as an error - a report
 * that fails to render because the log grew a paragraph would be worse than one
 * that quotes slightly less.
 */
export function parseDriftLog(markdown: string): readonly DriftLogRow[] {
  const rows: DriftLogRow[] = [];

  for (const [index, raw] of markdown.split('\n').entries()) {
    const line = raw.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;

    // `| a | b | c | d |` -> ['a','b','c','d'].
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length !== 4) continue;

    const [date = '', documented = '', actual = '', now = ''] = cells;

    // The header row, and the `|---|---|` separator beneath it.
    if (/^-{2,}$/.test(date.replace(/[:\s]/g, ''))) continue;
    if (date.toLowerCase() === 'date') continue;

    /**
     * A data row's first cell is a date or a parenthetical. The worked example
     * in "How to add an entry" uses the literal `YYYY-MM-DD`, which would
     * otherwise be quoted into an issue as if it were real prior art.
     */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    rows.push({
      line: index + 1,
      date,
      documented,
      actual,
      now,
      tags: extractTags(documented),
    });
  }

  return rows;
}

/** `(not documented)`, `(our bug)`, `(measured)`, `(harness limit)`, ... */
function extractTags(documented: string): readonly string[] {
  return [...documented.matchAll(/\(([^)]{1,60})\)/g)]
    .map((match) => (match[1] ?? '').trim().toLowerCase())
    .filter((tag) => tag !== '');
}

export interface ScoredDriftLogRow extends DriftLogRow {
  score: number;
  /** Which terms hit, so a reader can see why the row was offered. */
  matched: readonly string[];
}

/**
 * Ranks rows by overlap with the terms a finding is about.
 *
 * Terms come from the delta values, the failed step name and the portal's own
 * wording - the three things we know about the problem.
 */
export function scoreDriftLogRows(
  rows: readonly DriftLogRow[],
  terms: readonly string[],
): readonly ScoredDriftLogRow[] {
  const wanted = [...new Set(terms.flatMap(tokenize))].filter((term) => !STOP_WORDS.has(term));
  if (wanted.length === 0) return [];

  return rows
    .map((row) => {
      /**
       * Column 3 is weighted highest because it is the column that says what
       * the PORTAL does. Column 4 says what we did about it, which is useful
       * context but a weaker signal of "is this the same screen".
       */
      const haystacks: readonly (readonly [string, number])[] = [
        [row.actual, 3],
        [row.documented, 2],
        [row.now, 1],
      ];

      const matched = new Set<string>();
      let score = 0;

      for (const [text, weight] of haystacks) {
        const tokens = new Set(tokenize(text));
        for (const term of wanted) {
          if (!tokens.has(term)) continue;
          score += weight;
          matched.add(term);
        }
      }

      /**
       * A small nudge for rows that admit a mistake. `(our bug)` means the
       * portal was fine and we were wrong - the hypothesis a repair session
       * should weigh earliest, and the one it is least likely to reach on its
       * own.
       */
      if (score > 0 && row.tags.some((tag) => tag.includes('our bug'))) score += 1;

      return { ...row, score, matched: [...matched].sort() };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || a.line - b.line);
}

/**
 * Terms too common in this corpus to discriminate.
 *
 * Every row is about a portal, a screen, a field or a step, so those words
 * match everything and rank nothing. Kept short on purpose: an aggressive stop
 * list starts discarding real signal like "modal" or "radio".
 */
const STOP_WORDS = new Set([
  'the', 'and', 'not', 'for', 'with', 'that', 'this', 'from', 'into', 'was', 'are', 'its',
  'portal', 'screen', 'page', 'step', 'field', 'value', 'does', 'now', 'when', 'which',
  'anthem', 'automation', 'documented',
]);

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

/**
 * The terms worth searching the log for, given a finding.
 *
 * Deliberately narrow. Feeding it the whole evidence record would match
 * everything, which is the same as matching nothing.
 */
export function driftLogTerms(input: {
  step?: string;
  screenId?: string;
  portalMessage?: string;
  deltaValues?: readonly string[];
}): readonly string[] {
  return [
    input.step ?? '',
    input.screenId ?? '',
    input.portalMessage ?? '',
    ...(input.deltaValues ?? []),
  ].filter((term) => term !== '');
}
