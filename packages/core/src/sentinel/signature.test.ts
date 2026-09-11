import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRedactor } from './redact.ts';
import { buildSignature, findLeak, type RawScreenInput } from './signature.ts';

const PRODUCER_NAME = 'Featherstonehaugh';

function redactor(): ReturnType<typeof createRedactor> {
  return createRedactor({ values: { [PRODUCER_NAME]: '<producer.last>', AG7741QX: '<agency.code>' } });
}

function raw(overrides: Partial<RawScreenInput> = {}): RawScreenInput {
  return {
    url: 'https://portal.example/apps/ptb/dashboard',
    alerts: [],
    wizardStep: [],
    fields: [],
    buttons: [],
    modal: null,
    ...overrides,
  };
}

function sign(overrides: Partial<RawScreenInput> = {}, screenId = 'ptb-dashboard'): ReturnType<typeof buildSignature> {
  return buildSignature(raw(overrides), { screenId, redactor: redactor() });
}

describe('buildSignature - location', () => {
  it('keeps the host and path, and only the NAMES of query parameters', () => {
    const signature = sign({
      url: 'https://portal.example/broker/s/applicationrecordaction?c__ContextId=a0X8XX&c__isUploadDocument=true',
    });

    assert.deepEqual(signature.location, {
      host: 'portal.example',
      path: '/broker/s/applicationrecordaction',
      queryKeys: ['c__ContextId', 'c__isUploadDocument'],
    });
  });

  /**
   * The per-transaction record id is the instance; the presence of the
   * parameter is the structure. Keeping the value would report drift on every
   * single reading.
   */
  it('makes two transactions on one screen produce the same location', () => {
    const first = sign({ url: 'https://portal.example/s/quote?id=0Q1AAAA' });
    const second = sign({ url: 'https://portal.example/s/quote?id=0Q2BBBB' });
    assert.deepEqual(first.location, second.location);
  });

  it('reports an unparseable URL instead of throwing', () => {
    assert.equal(sign({ url: 'about:blank' }).location.host, '');
    assert.equal(sign({ url: 'nonsense' }).location.host, '(unparseable)');
  });
});

describe('buildSignature - fields carry kinds, never values', () => {
  it('records a shape rather than the value', () => {
    const signature = sign({
      fields: [
        { label: 'Group Contact Name', value: PRODUCER_NAME },
        { label: 'Contact Email Address', value: 'ops@example.com' },
        { label: 'Group ZIP Code', value: '94107' },
        { label: 'Effective Date', value: '01/01/2027' },
        { label: 'Benefit Period', value: 'Calendar Year' },
        { label: 'Main Phone Number', value: '(415) 555-0134' },
        { label: 'Employer Tax ID', value: null },
      ],
    });

    assert.deepEqual(signature.fields, [
      { label: 'Benefit Period', kind: 'text' },
      { label: 'Contact Email Address', kind: 'email' },
      { label: 'Effective Date', kind: 'date' },
      { label: 'Employer Tax ID', kind: 'empty' },
      { label: 'Group Contact Name', kind: 'text' },
      { label: 'Group ZIP Code', kind: 'digits' },
      { label: 'Main Phone Number', kind: 'phone' },
    ]);
  });

  /** The whole reason kinds exist. A baseline is a committed, tracked file. */
  it('carries no field value into the signature at all', () => {
    const signature = sign({ fields: [{ label: 'Group Contact Name', value: PRODUCER_NAME }] });
    assert.doesNotMatch(JSON.stringify(signature), /Featherstonehaugh/);
  });

  /**
   * The Vlocity wizard reveals branches as questions are answered, so DOM order
   * changes between readings of one screen.
   */
  it('sorts fields so DOM order cannot fake drift', () => {
    const forwards = sign({
      fields: [
        { label: 'Group Name', value: 'x' },
        { label: 'Group ZIP Code', value: '94107' },
      ],
    });
    const backwards = sign({
      fields: [
        { label: 'Group ZIP Code', value: '94107' },
        { label: 'Group Name', value: 'x' },
      ],
    });
    assert.deepEqual(forwards.fields, backwards.fields);
  });
});

describe('buildSignature - the wizard rail', () => {
  /**
   * The rail was measured reading `Untouched` on a screen the automation had
   * already reached: it lags the work by up to a minute. Comparing the status
   * would report drift on an unchanged screen.
   */
  it('strips the volatile status word but keeps the step label', () => {
    const signature = sign({
      wizardStep: ['Group Setup Completed', 'Portfolios In Progress', 'Census Untouched'],
    });
    assert.deepEqual(signature.railLabels, ['Census', 'Group Setup', 'Portfolios']);
  });

  it('makes the same rail at two moments of progress agree', () => {
    const early = sign({ wizardStep: ['Group Setup In Progress', 'Census Untouched'] });
    const later = sign({ wizardStep: ['Group Setup Completed', 'Census In Progress'] });
    assert.deepEqual(early.railLabels, later.railLabels);
  });
});

describe('buildSignature - alerts', () => {
  /**
   * Not optional. Anthem's dashboard carries "We've redesigned your
   * dashboard!" in the SAME alert region as its validation errors, so without
   * this the access probe reports drift from the day it is switched on.
   */
  it('drops informational alerts using the carrier classifier', () => {
    const signature = buildSignature(
      raw({ alerts: ["We've redesigned your dashboard!", "That SIC code isn't valid."] }),
      {
        screenId: 'ptb-dashboard',
        redactor: redactor(),
        isInformationalAlert: (text) => text.includes('redesigned'),
      },
    );

    assert.deepEqual(signature.alerts, ["That SIC code isn't valid."]);
  });

  it('redacts an alert that quotes a producer name', () => {
    const signature = sign({ alerts: [`${PRODUCER_NAME} is not licensed in CA`] });
    assert.deepEqual(signature.alerts, ['<producer.last> is not licensed in CA']);
  });

  it('sorts and dedupes, so a signature is a set not a rendering order', () => {
    const signature = sign({ alerts: ['b', 'a', 'b'] });
    assert.deepEqual(signature.alerts, ['a', 'b']);
  });
});

describe('buildSignature - counts and version', () => {
  it('reports counts so a large structural change is visible in a diff', () => {
    const signature = sign({
      alerts: ['one'],
      buttons: ['Continue', 'Back'],
      fields: [{ label: 'Group Name', value: 'x' }],
      wizardStep: ['Group Setup Completed'],
    });
    assert.deepEqual(signature.counts, { alerts: 1, fields: 1, buttons: 2, rail: 1 });
  });

  it('stamps the normalization version, so a rule change invalidates loudly', () => {
    assert.equal(sign().version, 1);
  });
});

describe('findLeak - the fail-closed check', () => {
  it('names the path of a surviving secret value', () => {
    // A signature built WITHOUT the redactor that knows this value.
    const unscrubbed = buildSignature(raw({ alerts: [`Agent ${PRODUCER_NAME}`] }), {
      screenId: 'x',
      redactor: createRedactor({ values: {} }),
    });

    assert.equal(findLeak(unscrubbed, redactor()), 'alerts[0]');
  });

  it('returns undefined for a properly scrubbed signature', () => {
    const signature = sign({
      alerts: [`Agent ${PRODUCER_NAME}`],
      fields: [{ label: 'Group Contact Name', value: PRODUCER_NAME }],
    });
    assert.equal(findLeak(signature, redactor()), undefined);
  });

  it('finds a leak nested in the modal text', () => {
    const unscrubbed = buildSignature(raw({ modal: `Signed by ${PRODUCER_NAME}` }), {
      screenId: 'x',
      redactor: createRedactor({ values: {} }),
    });
    assert.equal(findLeak(unscrubbed, redactor()), 'modal.text');
  });
});
