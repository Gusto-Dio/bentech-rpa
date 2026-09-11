import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { driftLogTerms, parseDriftLog, scoreDriftLogRows } from './drift-log.ts';

/**
 * A synthetic log with the shapes the real one actually contains: a "how to add
 * an entry" worked example, a prose section header between tables, a repeated
 * header row, and a retraction.
 */
const LOG = `# Drift log

## How to add an entry

| Date | Documented step | What the portal actually does | What the automation does now |
|---|---|---|---|
| YYYY-MM-DD | 2.2.2 "Type the producer first name" | Field is now a typeahead | Waits for role=listbox |

## Entries

| Date | Documented step | What the portal actually does | What the automation does now |
|---|---|---|---|
| 2026-09-02 | (not documented) First button locator | Its visible text is "Continue" but its accessible name is "Login" | getByRole button name Login exact |
| 2026-09-02 | (our bug) Polling never refreshed the list | Each poll called goto on a URL differing only in its fragment | listSearch calls reload |

### 2026-09-03 — the quote flow moved to a different platform

Some prose that is not a table row at all.

| Date | Documented step | What the portal actually does | What the automation does now |
|---|---|---|---|
| 2026-09-03 | (not documented) Radios cannot be clicked | The input is 1x1 px hidden behind label.slds-radio__label | Click the label, not the input |
| 2026-09-04 | (root cause, third and correct reading) The SAML hop | The community session expires independently of the portal one | resolveSamlChallenge answers the password prompt |
`;

describe('parseDriftLog', () => {
  it('reads the four-column rows', () => {
    const rows = parseDriftLog(LOG);
    assert.equal(rows.length, 4);
    assert.equal(rows[0]?.date, '2026-09-02');
    assert.match(rows[0]?.actual ?? '', /accessible name is "Login"/);
  });

  /**
   * The worked example under "How to add an entry" is not prior art, and
   * quoting `YYYY-MM-DD` into an issue as though it were would be actively
   * misleading.
   */
  it('skips the worked example in the instructions', () => {
    assert.equal(
      parseDriftLog(LOG).some((row) => row.date === 'YYYY-MM-DD'),
      false,
    );
  });

  it('skips header rows, separators and prose between tables', () => {
    const rows = parseDriftLog(LOG);
    assert.equal(
      rows.some((row) => row.documented === 'Documented step'),
      false,
    );
    assert.equal(
      rows.some((row) => row.actual.includes('not a table row')),
      false,
    );
  });

  it('cites the line number, so an issue can point at the row', () => {
    const rows = parseDriftLog(LOG);
    const lines = LOG.split('\n');
    for (const row of rows) {
      assert.match(lines[row.line - 1] ?? '', new RegExp(row.date));
    }
  });

  /** The log's honesty vocabulary is signal, not decoration. */
  it('lifts the log tags out of column 2', () => {
    const rows = parseDriftLog(LOG);
    assert.deepEqual(rows[0]?.tags, ['not documented']);
    assert.deepEqual(rows[1]?.tags, ['our bug']);
    assert.deepEqual(rows[3]?.tags, ['root cause, third and correct reading']);
  });

  it('returns nothing for a log with no entries rather than throwing', () => {
    assert.deepEqual(parseDriftLog('# Drift log\n\nNothing yet.\n'), []);
    assert.deepEqual(parseDriftLog(''), []);
  });
});

describe('scoreDriftLogRows', () => {
  const rows = parseDriftLog(LOG);

  it('ranks the row about the thing being asked about', () => {
    const top = scoreDriftLogRows(rows, driftLogTerms({ portalMessage: 'radio label click' }))[0];
    assert.match(top?.actual ?? '', /1x1 px/);
  });

  it('reports which terms matched, so the ranking can be checked', () => {
    const top = scoreDriftLogRows(rows, driftLogTerms({ portalMessage: 'accessible name' }))[0];
    assert.ok(top?.matched.includes('accessible'));
  });

  /**
   * Column 3 says what the PORTAL does; column 4 says what we did about it.
   * The former is the stronger signal for "is this the same screen".
   */
  it('weights what the portal does above what the automation does', () => {
    const scored = scoreDriftLogRows(rows, driftLogTerms({ portalMessage: 'label' }));
    const portalSide = scored.find((row) => row.actual.includes('slds-radio__label'));
    assert.ok((portalSide?.score ?? 0) >= 3, 'a column-3 hit should score at least the column-3 weight');
  });

  /** The hypothesis a repair session is least likely to reach on its own. */
  it('nudges rows that admit our own mistake', () => {
    const scored = scoreDriftLogRows(rows, driftLogTerms({ portalMessage: 'poll fragment goto' }));
    const ourBug = scored.find((row) => row.tags.includes('our bug'));
    assert.ok(ourBug !== undefined);
    assert.ok(ourBug.score > 3, 'the (our bug) nudge should be visible in the score');
  });

  it('offers nothing rather than everything when the terms are all noise', () => {
    assert.deepEqual(scoreDriftLogRows(rows, ['the', 'portal', 'screen']), []);
    assert.deepEqual(scoreDriftLogRows(rows, []), []);
  });

  it('never returns a row that matched nothing', () => {
    for (const row of scoreDriftLogRows(rows, driftLogTerms({ portalMessage: 'radio' }))) {
      assert.ok(row.matched.length > 0);
      assert.ok(row.score > 0);
    }
  });
});

/**
 * A canary on the real file. If someone reformats the drift log, issue bodies
 * silently stop carrying prior art - and nothing else would notice.
 *
 * Asserts a floor rather than a count, because the log only grows and an exact
 * number would go stale on every entry. Same reasoning AGENTS.md gives for not
 * quoting a test count.
 */
describe('the real Anthem drift log still parses', () => {
  const file = path.join(
    import.meta.dirname,
    '..', '..', '..', '..',
    'docs', 'poc', 'anthem-ca-new-plans', 'drift-log.md',
  );

  it('yields a substantial number of rows', (t) => {
    if (!existsSync(file)) {
      t.skip('the Anthem drift log is not present in this checkout');
      return;
    }

    const rows = parseDriftLog(readFileSync(file, 'utf8'));
    assert.ok(rows.length > 50, `expected the log to still parse into many rows, got ${rows.length}`);
    assert.ok(
      rows.some((row) => row.tags.some((tag) => tag.includes('our bug'))),
      'the log records our own mistakes, and the tag extraction should still find them',
    );
    assert.equal(
      rows.some((row) => row.date === 'YYYY-MM-DD'),
      false,
      'the worked example must not be offered as prior art',
    );
  });
});
