import { BusinessException } from '@rpa/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertContinuationMatches,
  continuationFor,
  eligibleDecliningCount,
  partTimeCount,
} from './derived.ts';
import type { Payload } from './payload.ts';

/** Only the counts matter here, so the rest of the payload is cast away. */
function counts(over: { anteCount: number; fteCount: number; partTimeEECount: number; continuation?: string }): Payload {
  return {
    anteCount: over.anteCount,
    fteCount: over.fteCount,
    partTimeEECount: over.partTimeEECount,
    continuation: over.continuation ?? 'state',
  } as unknown as Payload;
}

describe('partTimeCount', () => {
  /** The seed group: 5 total, 3 full-time, 2 part-time. */
  it('is total minus full-time when the payload agrees', () => {
    assert.equal(partTimeCount(counts({ anteCount: 5, fteCount: 3, partTimeEECount: 2 })), 2);
  });

  /**
   * Two sources for one number. Rather than silently preferring one, stop -
   * these figures go onto a signed application that nothing cross-checks.
   */
  it('refuses when the payload disagrees with the arithmetic', () => {
    assert.throws(
      () => partTimeCount(counts({ anteCount: 5, fteCount: 3, partTimeEECount: 4 })),
      BusinessException,
    );
  });

  it('refuses more full-time employees than employees', () => {
    assert.throws(
      () => partTimeCount(counts({ anteCount: 3, fteCount: 5, partTimeEECount: 0 })),
      BusinessException,
    );
  });

  it('allows a group where everyone is full-time', () => {
    assert.equal(partTimeCount(counts({ anteCount: 3, fteCount: 3, partTimeEECount: 0 })), 0);
  });
});

describe('eligibleDecliningCount', () => {
  /** Waiving EMPLOYEES. A waiving spouse is not a declining employee. */
  it('counts waiving employees and ignores waiving dependents', () => {
    assert.equal(
      eligibleDecliningCount([
        { Relationship: 'Employee' },
        { Relationship: 'Spouse' },
        { Relationship: 'Child' },
        { Relationship: 'Employee' },
      ]),
      2,
    );
  });

  it('is tolerant of casing and stray whitespace from the export', () => {
    assert.equal(eligibleDecliningCount([{ Relationship: ' employee ' }]), 1);
  });

  it('is zero when nobody waived', () => {
    assert.equal(eligibleDecliningCount([]), 0);
  });
});

describe('continuation', () => {
  it('is Cal-COBRA for 2-19 eligible employees', () => {
    assert.equal(continuationFor(2), 'cal-cobra');
    assert.equal(continuationFor(19), 'cal-cobra');
  });

  it('is COBRA at 20 or more', () => {
    assert.equal(continuationFor(20), 'cobra');
  });

  it('accepts a group whose election matches its size', () => {
    assert.equal(assertContinuationMatches(counts({ anteCount: 5, fteCount: 3, partTimeEECount: 2 })), 'cal-cobra');
  });

  /** Wrong continuation on a group application is a compliance error. */
  it('refuses a 3-employee group that declared federal COBRA', () => {
    assert.throws(
      () => assertContinuationMatches(counts({ anteCount: 5, fteCount: 3, partTimeEECount: 2, continuation: 'cobra' })),
      BusinessException,
    );
  });
});
