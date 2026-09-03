import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BusinessException } from '../errors.ts';
import { JSON_FIELDS_KEY, fromSpecificContent, toSpecificContent } from './specificContent.ts';

/**
 * The real payload from
 * automations/group-submission/carrier-portal-submission-demo/data/seed/queue.json.
 * It has both a nested object and an array, which is exactly what Orchestrator's
 * SpecificContent cannot hold natively - so it is the payload worth testing.
 */
const DEMO_PAYLOAD = {
  groupId: 'GRP-8842',
  groupName: 'Northwind Test Bakery',
  contact: { firstName: 'Ada', lastName: 'Sample', postalCode: '80202' },
  requestedPlans: ['Sauce Labs Backpack', 'Sauce Labs Bike Light'],
};

describe('toSpecificContent', () => {
  it('passes primitives through untouched, so Studio can read them directly', () => {
    const content = toSpecificContent({ groupId: 'GRP-1', count: 3, active: true, note: null });
    assert.deepEqual(content, { groupId: 'GRP-1', count: 3, active: true, note: null });
    assert.ok(!(JSON_FIELDS_KEY in content), 'no marker when nothing needed encoding');
  });

  it('JSON-encodes nested objects and arrays and records which keys it touched', () => {
    const content = toSpecificContent(DEMO_PAYLOAD);

    assert.equal(content['groupId'], 'GRP-8842');
    assert.equal(typeof content['contact'], 'string');
    assert.equal(typeof content['requestedPlans'], 'string');
    assert.deepEqual(JSON.parse(String(content[JSON_FIELDS_KEY])).sort(), [
      'contact',
      'requestedPlans',
    ]);
  });

  it('produces only primitive values, which is what Orchestrator wants', () => {
    for (const value of Object.values(toSpecificContent(DEMO_PAYLOAD))) {
      assert.ok(
        value === null || ['string', 'number', 'boolean'].includes(typeof value),
        `${String(value)} is not a primitive`,
      );
    }
  });

  it('converts Date to an ISO string rather than encoding it as an object', () => {
    const content = toSpecificContent({ effectiveDate: new Date('2027-01-01T00:00:00Z') });
    assert.equal(content['effectiveDate'], '2027-01-01T00:00:00.000Z');
    assert.ok(!(JSON_FIELDS_KEY in content));
  });

  it('drops undefined values instead of sending nulls Orchestrator did not ask for', () => {
    const content = toSpecificContent({ present: 'yes', absent: undefined });
    assert.deepEqual(Object.keys(content), ['present']);
  });

  it('rejects a non-object payload as a business failure', () => {
    assert.throws(() => toSpecificContent(['not', 'an', 'object']), BusinessException);
    assert.throws(() => toSpecificContent('a string'), BusinessException);
  });

  it('rejects a payload that would collide with the marker key', () => {
    assert.throws(() => toSpecificContent({ [JSON_FIELDS_KEY]: 'x' }), BusinessException);
  });

  it('rejects NaN and Infinity, which JSON cannot represent', () => {
    assert.throws(() => toSpecificContent({ amount: Number.NaN }), BusinessException);
    assert.throws(() => toSpecificContent({ amount: Number.POSITIVE_INFINITY }), BusinessException);
  });
});

describe('round trip', () => {
  it('restores the demo payload exactly', () => {
    assert.deepEqual(fromSpecificContent(toSpecificContent(DEMO_PAYLOAD)), DEMO_PAYLOAD);
  });

  it('survives deep nesting and mixed arrays', () => {
    const payload = {
      id: 'X',
      nested: { a: { b: { c: [1, 'two', true, null, { d: 4 }] } } },
      empty: {},
      emptyList: [],
    };
    assert.deepEqual(fromSpecificContent(toSpecificContent(payload)), payload);
  });

  it('never leaks the marker key back into the payload', () => {
    const restored = fromSpecificContent(toSpecificContent(DEMO_PAYLOAD)) as Record<string, unknown>;
    assert.ok(!(JSON_FIELDS_KEY in restored));
  });

  it('treats missing SpecificContent as an empty payload', () => {
    assert.deepEqual(fromSpecificContent(undefined), {});
    assert.deepEqual(fromSpecificContent(null), {});
  });
});

describe('fromSpecificContent - tolerating hand-edited items', () => {
  it('accepts the older comma-separated marker form', () => {
    const restored = fromSpecificContent({
      contact: '{"firstName":"Ada"}',
      [JSON_FIELDS_KEY]: 'contact',
    }) as Record<string, unknown>;
    assert.deepEqual(restored['contact'], { firstName: 'Ada' });
  });

  it('passes a value through when the marker claims encoding but the JSON is broken', () => {
    // Someone edited the item in the Orchestrator UI. Losing the whole run over
    // it would be worse than handing the raw string to the automation.
    const restored = fromSpecificContent({
      contact: 'not json at all',
      [JSON_FIELDS_KEY]: '["contact"]',
    }) as Record<string, unknown>;
    assert.equal(restored['contact'], 'not json at all');
  });

  it('passes a non-string value through when the marker disagrees with it', () => {
    const restored = fromSpecificContent({
      count: 5,
      [JSON_FIELDS_KEY]: '["count"]',
    }) as Record<string, unknown>;
    assert.equal(restored['count'], 5);
  });
});
