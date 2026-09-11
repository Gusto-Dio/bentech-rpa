import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRedactor } from './redact.ts';

const PRODUCER = { first: 'Wilhelmina', last: 'Featherstonehaugh', agency: 'AG7741QX' };

function redactor(): ReturnType<typeof createRedactor> {
  return createRedactor({
    values: {
      [PRODUCER.first]: '<producer.first>',
      [PRODUCER.last]: '<producer.last>',
      [`${PRODUCER.first} ${PRODUCER.last}`]: '<producer.name>',
      [PRODUCER.agency]: '<agency.code>',
      'producer-bot': '<user>',
    },
  });
}

describe('createRedactor - known secret values', () => {
  it('removes a resolved value wherever it appears', () => {
    const out = redactor().text(`Welcome, ${PRODUCER.first}! Agency ${PRODUCER.agency}.`);
    assert.equal(out, 'Welcome, <producer.first>! Agency <agency.code>.');
  });

  it('matches case-insensitively, because portals reformat names', () => {
    assert.equal(redactor().text('AG7741qx'), '<agency.code>');
    assert.equal(redactor().text('WILHELMINA'), '<producer.first>');
  });

  /**
   * Longest first. Replacing the first name before the combined "First Last"
   * would leave `<producer.first> Featherstonehaugh` and then the combined
   * value could never match.
   */
  it('applies the longest value first so a shorter one cannot strand it', () => {
    assert.equal(redactor().text(`${PRODUCER.first} ${PRODUCER.last}`), '<producer.name>');
  });

  it('treats a value containing regex metacharacters literally', () => {
    const r = createRedactor({ values: { 'a.b+c(d)': '<odd>' } });
    assert.equal(r.text('a.b+c(d)'), '<odd>');
    assert.equal(r.text('axbxcxd'), 'axbxcxd');
  });

  /**
   * An unset env var resolves to '' and a producer initial is one character.
   * Either would match nearly every word and turn a signature into a row of
   * tokens, which hides drift rather than protecting anything.
   */
  it('ignores values too short to be meaningful', () => {
    const r = createRedactor({ values: { '': '<empty>', W: '<initial>', ' ': '<space>' } });
    assert.equal(r.text('Wilhelmina works Wednesdays'), 'Wilhelmina works Wednesdays');
  });
});

describe('createRedactor - leaks', () => {
  it('reports a surviving secret value', () => {
    assert.equal(redactor().leaks(`signed in as ${PRODUCER.last}`), true);
  });

  it('reports clean text as clean', () => {
    assert.equal(redactor().leaks('Group Setup - Progress: <n>%'), false);
  });

  /** A global regex keeps lastIndex between calls, so a second ask must agree. */
  it('gives the same answer when asked twice', () => {
    const r = redactor();
    const text = `agency ${PRODUCER.agency}`;
    assert.equal(r.leaks(text), true);
    assert.equal(r.leaks(text), true);
  });

  /**
   * `leaks` deliberately checks the exact values only. A class pattern
   * surviving is a scrubbing bug; a producer's real name surviving is an
   * incident, and conflating the two would make the fail-closed check fire on
   * cosmetic misses.
   */
  it('does not fail closed on a merely PII-shaped string', () => {
    assert.equal(redactor().leaks('call 555-010-9999'), false);
  });
});

describe('createRedactor - PII classes', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['Contact: ops.team+anthem@example.com', 'Contact: <email>'],
    ['SSN 000-45-6789', 'SSN <ssn>'],
    ['Employer Tax ID 94-1234567', 'Employer Tax ID <tin>'],
    ['Main Phone (415) 555-0134', 'Main Phone <phone>'],
    ['Contact Phone 415-555-0134', 'Contact Phone <phone>'],
    ['Cell +1 415 555 0134', 'Cell <phone>'],
    ['Premium $1,204.50 per month', 'Premium <money> per month'],
    ['Group ZIP Code 94107', 'Group ZIP Code <zip>'],
    ['ZIP 94107-1234', 'ZIP <zip>'],
  ];

  for (const [input, expected] of cases) {
    it(`scrubs ${JSON.stringify(input)}`, () => {
      assert.equal(redactor().text(input), expected);
    });
  }

  /** ZIP+4 must be tried before plain ZIP, or the `-1234` is left dangling. */
  it('does not leave a ZIP+4 suffix behind', () => {
    assert.doesNotMatch(redactor().text('ZIP 94107-1234'), /1234/);
  });

  /** SSN and EIN are both digit runs; the punctuated shapes must win first. */
  it('does not let the generic digit rule pre-empt an SSN or a TIN', () => {
    assert.equal(redactor().text('000-45-6789 and 94-1234567'), '<ssn> and <tin>');
  });
});

describe('createRedactor - volatile values that would fake drift', () => {
  const cases: readonly (readonly [string, string])[] = [
    // The four measured generated-id families.
    ['vlocity-radio-0-1-110', 'vlocity-<gen>'],
    ['comboboxId-604', 'comboboxId-<gen>'],
    ['input60', 'input<gen>'],
    // Counters and progress.
    ['Progress: 40%', 'Progress: <n>%'],
    ['3 out of 23 documents uploaded', '<n> out of <n> documents uploaded'],
    ['12 of 40 Employees Added', '<n> of <n> Employees Added'],
    ['This code expires in 4:37', 'This code expires in <mm:ss>'],
    // Dates and times.
    ['Effective 2026-09-10T14:02:11Z', 'Effective <datetime>'],
    ['Signed Sep 3, 2026', 'Signed <date>'],
    ['Due 09/10/2026', 'Due <date>'],
    ['Received 6:38 PM', 'Received <time>'],
    // Anthem's quote number shape.
    ['Quote 01234567', 'Quote <quote>'],
  ];

  for (const [input, expected] of cases) {
    it(`normalizes ${JSON.stringify(input)}`, () => {
      assert.equal(redactor().text(input), expected);
    });
  }

  /**
   * The generic digit run runs LAST for this reason: a quote number must read
   * as a quote, not as an anonymous number, or a signature diff stops being
   * legible.
   */
  it('leaves the specific rules ahead of the generic digit run', () => {
    assert.equal(redactor().text('Quote 01234567 has 5 plans'), 'Quote <quote> has 5 plans');
    assert.equal(redactor().text('reference 8827361'), 'reference <num>');
  });

  /** A wizard rail at 40% and at 60% is the same screen. */
  it('makes two readings of one screen agree', () => {
    const r = redactor();
    assert.equal(r.text('Group Setup Progress: 40%'), r.text('Group Setup Progress: 60%'));
  });
});

describe('createRedactor - deep', () => {
  it('rewrites every string leaf and leaves other types alone', () => {
    const out = redactor().deep({
      url: 'https://portal.example/apps/ptb/dashboard/AG7741QX',
      alerts: [`${PRODUCER.first} is not licensed in CA`],
      fields: [{ label: 'Group ZIP Code', value: '94107' }],
      count: 3,
      modal: null,
      ok: true,
    });

    assert.deepEqual(out, {
      url: 'https://portal.example/apps/ptb/dashboard/<agency.code>',
      alerts: ['<producer.first> is not licensed in CA'],
      fields: [{ label: 'Group ZIP Code', value: '<zip>' }],
      count: 3,
      modal: null,
      ok: true,
    });
  });

  it('does not mutate its input', () => {
    const input = { alerts: [PRODUCER.last] };
    redactor().deep(input);
    assert.deepEqual(input, { alerts: [PRODUCER.last] });
  });
});
