import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDelimited } from './delimited.ts';

describe('parseDelimited', () => {
  it('maps rows onto the header', () => {
    const rows = parseDelimited('plan_code,tier\nMED-PPO-1000,medical\n');
    assert.deepEqual(rows, [{ plan_code: 'MED-PPO-1000', tier: 'medical' }]);
  });

  /**
   * The reason this parser exists instead of split(','). Carrier files routinely
   * contain quoted commas, and a naive split shifts every subsequent column -
   * an off-by-one-column in a benefits roster is far worse than a crash.
   */
  it('keeps a quoted field containing a comma intact', () => {
    const rows = parseDelimited('plan_code,plan_name\nVIS-BASE-01,"Fictional Vision, Basic"\n');
    assert.equal(rows[0]?.['plan_name'], 'Fictional Vision, Basic');
  });

  it('unescapes a doubled quote', () => {
    const rows = parseDelimited('name\n"He said ""hello"""\n');
    assert.equal(rows[0]?.['name'], 'He said "hello"');
  });

  it('handles CRLF line endings, which vendor files usually have', () => {
    const rows = parseDelimited('a,b\r\n1,2\r\n');
    assert.deepEqual(rows, [{ a: '1', b: '2' }]);
  });

  it('skips blank lines rather than emitting empty records', () => {
    assert.equal(parseDelimited('a\n1\n\n2\n').length, 2);
  });

  it('tolerates a missing trailing newline', () => {
    assert.equal(parseDelimited('a,b\n1,2').length, 1);
  });

  it('throws on an empty file instead of returning nothing useful', () => {
    assert.throws(() => parseDelimited(''), /no header row/);
  });
});
