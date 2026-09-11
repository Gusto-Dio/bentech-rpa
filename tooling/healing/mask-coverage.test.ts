import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contains, containsPoint, isCovered, type Box } from './mask-coverage.ts';

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });

describe('isCovered - the single-mask case', () => {
  it('accepts a control inside one mask', () => {
    assert.equal(isCovered(box(10, 10, 50, 20), [box(0, 0, 100, 100)]), true);
  });

  it('accepts a control exactly the size of its mask', () => {
    assert.equal(isCovered(box(10, 10, 50, 20), [box(10, 10, 50, 20)]), true);
  });

  it('tolerates sub-pixel layout rounding', () => {
    assert.equal(isCovered(box(10, 10, 50, 20), [box(10.3, 10.2, 49.6, 19.7)]), true);
  });

  it('refuses a control with no mask at all', () => {
    assert.equal(isCovered(box(10, 10, 50, 20), []), false);
  });
});

describe('isCovered - partial coverage is not coverage', () => {
  /**
   * A control half-covered is a control whose value may be half-readable, and a
   * partially visible FEIN is still a FEIN. This is the assertion that makes
   * the whole check worth having.
   */
  it('refuses a control that only overlaps a mask', () => {
    assert.equal(isCovered(box(50, 10, 100, 20), [box(0, 0, 100, 100)]), false);
  });

  it('refuses a control hanging off each edge in turn', () => {
    const mask = [box(20, 20, 60, 60)];
    assert.equal(isCovered(box(10, 30, 40, 20), mask), false, 'off the left');
    assert.equal(isCovered(box(50, 30, 40, 20), mask), false, 'off the right');
    assert.equal(isCovered(box(30, 10, 20, 40), mask), false, 'off the top');
    assert.equal(isCovered(box(30, 50, 20, 40), mask), false, 'off the bottom');
  });

  it('refuses a control larger than its mask in every direction', () => {
    assert.equal(isCovered(box(0, 0, 200, 200), [box(50, 50, 50, 50)]), false);
  });
});

describe('isCovered - several adjacent masks', () => {
  /**
   * Happens whenever a table cell and the element inside it both resolve, so
   * the common case rather than an exotic one.
   */
  it('accepts a control spanning two touching masks', () => {
    const masks = [box(0, 0, 50, 100), box(50, 0, 50, 100)];
    assert.equal(isCovered(box(20, 20, 60, 20), masks), true);
  });

  /**
   * THE REASON THE FALLBACK SAMPLES A GRID AND NOT THE FOUR CORNERS. Two masks
   * with a gap between them cover all four corners of a box straddling them
   * while leaving a readable strip down the middle - which is precisely the
   * shape two masks with a margin produce.
   */
  it('refuses a control straddling two masks with a gap between them', () => {
    const masks = [box(0, 0, 40, 100), box(60, 0, 40, 100)];
    assert.equal(isCovered(box(10, 20, 80, 20), masks), false);
  });

  it('accepts a control covered by three masks in a row', () => {
    const masks = [box(0, 0, 30, 50), box(30, 0, 30, 50), box(60, 0, 30, 50)];
    assert.equal(isCovered(box(5, 10, 80, 20), masks), true);
  });
});

describe('isCovered - degenerate boxes', () => {
  /**
   * A zero-size element is not on screen and therefore not in the image.
   * Vlocity pre-renders every branch, so most controls on a wizard screen are
   * hidden - counting them would fail the check on controls that were never
   * visible.
   */
  it('treats a zero-size control as covered, because it is not in the image', () => {
    assert.equal(isCovered(box(10, 10, 0, 20), []), true);
    assert.equal(isCovered(box(10, 10, 50, 0), []), true);
  });
});

describe('contains and containsPoint', () => {
  it('contains is strict about every edge', () => {
    assert.equal(contains(box(0, 0, 100, 100), box(0, 0, 100, 100)), true);
    assert.equal(contains(box(0, 0, 100, 100), box(0, 0, 101, 100)), false);
    assert.equal(contains(box(0, 0, 100, 100), box(-1, 0, 100, 100)), false);
  });

  it('containsPoint includes the boundary', () => {
    assert.equal(containsPoint(box(0, 0, 10, 10), 0, 0), true);
    assert.equal(containsPoint(box(0, 0, 10, 10), 10, 10), true);
    assert.equal(containsPoint(box(0, 0, 10, 10), 11, 5), false);
  });
});
