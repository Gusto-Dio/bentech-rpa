import { BusinessException } from '@rpa/core';
import type { HippoCensusRow, Policy } from '@auto/group-submission-shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertContinuationMatches,
  contributionPercentage,
  continuationFor,
  employerContribution,
  isFlatDollar,
  primaryOptionFor,
  totalApplying,
  yearsInBusiness,
} from './derived.ts';
import type { Payload } from './payload.ts';

/** Only the fields under test matter, so the rest of the payload is cast away. */
function payloadWith(over: Partial<Payload>): Payload {
  return {
    companyName: 'The Company LLC',
    state: 'CA',
    continuation: 'state',
    fteCount: 3,
    eligibleEEs: 3,
    ...over,
  } as unknown as Payload;
}

function policyWith(over: Partial<Policy>): Policy {
  return {
    contributionType: 'Percentage of base',
    eeContribution: '75.0',
    dependentContribution: '50.0',
    fixedCompanyContributionAmount: null,
    ...over,
  } as unknown as Policy;
}

function person(relationship: string): HippoCensusRow {
  return { 'Relationship': relationship };
}

describe('continuationFor', () => {
  /**
   * The boundary is the whole point. State continuation is UNDER 20 FTE, so 19
   * and 20 must land on different answers - and this threshold is keyed on FTE,
   * where the Medicare question below is keyed on eligible employees.
   */
  it('is state continuation below 20 FTE', () => {
    assert.equal(continuationFor(0), 'state');
    assert.equal(continuationFor(19), 'state');
  });

  it('is COBRA at 20 FTE and above', () => {
    assert.equal(continuationFor(20), 'cobra');
    assert.equal(continuationFor(500), 'cobra');
  });
});

describe('assertContinuationMatches', () => {
  it('returns the derived value when the payload agrees', () => {
    assert.equal(assertContinuationMatches(payloadWith({ fteCount: 3, continuation: 'state' })), 'state');
    assert.equal(assertContinuationMatches(payloadWith({ fteCount: 42, continuation: 'cobra' })), 'cobra');
  });

  /**
   * Picking either side of a disagreement is a compliance error, not a
   * formatting one, so the run stops and a human reconciles it.
   */
  it('refuses when the declared continuation contradicts the headcount', () => {
    assert.throws(
      () => assertContinuationMatches(payloadWith({ fteCount: 25, continuation: 'state' })),
      BusinessException,
    );
    assert.throws(
      () => assertContinuationMatches(payloadWith({ fteCount: 4, continuation: 'cobra' })),
      BusinessException,
    );
  });
});

describe('primaryOptionFor', () => {
  it('is Medicare primary below 20 eligible employees', () => {
    assert.equal(primaryOptionFor(0), 'medicare');
    assert.equal(primaryOptionFor(19), 'medicare');
  });

  it('is plan primary at 20 eligible employees and above', () => {
    assert.equal(primaryOptionFor(20), 'plan-primary');
  });
});

describe('totalApplying', () => {
  /** Dependants enrolling are not employees applying; counting them inflates the figure. */
  it('counts enrolling employees only, not their dependants', () => {
    const enrolling = [person('Employee'), person('Spouse'), person('Child'), person('Employee')];
    assert.equal(totalApplying(enrolling), 2);
  });

  it('is zero for an empty census', () => {
    assert.equal(totalApplying([]), 0);
  });

  it('does not care about casing or padding in the relationship', () => {
    assert.equal(totalApplying([person('  employee  '), person('EMPLOYEE')]), 2);
  });
});

describe('yearsInBusiness', () => {
  it('counts whole years to the anniversary', () => {
    assert.equal(yearsInBusiness('2024-01-03', new Date('2026-09-10T00:00:00Z')), 2);
  });

  /** The anniversary has not come round yet, so it is still the previous count. */
  it('does not credit a year before the anniversary', () => {
    assert.equal(yearsInBusiness('2024-11-15', new Date('2026-09-10T00:00:00Z')), 1);
    assert.equal(yearsInBusiness('2024-09-11', new Date('2026-09-10T00:00:00Z')), 1);
  });

  it('credits the year on the anniversary itself', () => {
    assert.equal(yearsInBusiness('2024-09-10', new Date('2026-09-10T00:00:00Z')), 2);
  });

  it('refuses a non-ISO date rather than guessing what it means', () => {
    assert.throws(() => yearsInBusiness('01/03/2024', new Date('2026-09-10T00:00:00Z')), BusinessException);
  });

  it('refuses a date in the future', () => {
    assert.throws(() => yearsInBusiness('2027-01-01', new Date('2026-09-10T00:00:00Z')), BusinessException);
  });
});

describe('contributionPercentage', () => {
  it('parses the string percentages the source record carries', () => {
    assert.equal(contributionPercentage('75.0', 'eeContribution'), 75);
    assert.equal(contributionPercentage(' 100 ', 'eeContribution'), 100);
    assert.equal(contributionPercentage('0', 'eeContribution'), 0);
  });

  it('refuses anything that is not a percentage', () => {
    assert.throws(() => contributionPercentage('', 'eeContribution'), BusinessException);
    assert.throws(() => contributionPercentage('   ', 'eeContribution'), BusinessException);
    assert.throws(() => contributionPercentage('half', 'eeContribution'), BusinessException);
    assert.throws(() => contributionPercentage('101', 'eeContribution'), BusinessException);
    assert.throws(() => contributionPercentage('-1', 'eeContribution'), BusinessException);
  });
});

describe('isFlatDollar', () => {
  it('is false for the percentage-of-base groups the seed carries', () => {
    assert.equal(isFlatDollar(policyWith({})), false);
  });

  /**
   * Both signals are checked because they can disagree - the amount is the
   * stronger one, and a flat-dollar group typed into a percentage field enters a
   * dollar figure as a percentage.
   */
  it('is true when an amount is present even if the type does not say so', () => {
    assert.equal(isFlatDollar(policyWith({ fixedCompanyContributionAmount: 250 })), true);
  });

  it('is true when the contribution type names a fixed amount', () => {
    assert.equal(isFlatDollar(policyWith({ contributionType: 'Fixed dollar amount' })), true);
    assert.equal(isFlatDollar(policyWith({ contributionType: 'flat' })), true);
  });
});

describe('employerContribution', () => {
  it('enters the quoted percentage when no override applies', () => {
    const result = employerContribution(payloadWith({}), policyWith({ eeContribution: '75.0' }), 3);
    assert.equal(result.percentage, 75);
    assert.equal(result.rule, 'as-quoted');
    assert.equal(result.note, undefined);
  });

  /**
   * Flat-dollar is checked FIRST: it carries no percentage, so the 100%
   * comparison the California rule depends on is not meaningful for it.
   */
  it('enters 50% for a flat-dollar contribution, ahead of any other rule', () => {
    const result = employerContribution(
      payloadWith({ state: 'CA', eligibleEEs: 10 }),
      policyWith({ eeContribution: '100', fixedCompanyContributionAmount: 400 }),
      2,
    );
    assert.equal(result.percentage, 50);
    assert.equal(result.rule, 'flat-dollar-as-50');
    assert.ok(result.note?.includes('flat dollar'));
  });

  it('enters 99% for a California group at 100% where not everyone is enrolling', () => {
    const result = employerContribution(
      payloadWith({ state: 'CA', eligibleEEs: 10 }),
      policyWith({ eeContribution: '100' }),
      7,
    );
    assert.equal(result.percentage, 99);
    assert.equal(result.rule, 'ca-full-contribution-as-99');
    assert.ok(result.note?.includes('7 of 10'));
  });

  /** Everyone enrolling means participation is not at risk, so 100% stands. */
  it('leaves 100% alone in California when everyone is enrolling', () => {
    const result = employerContribution(
      payloadWith({ state: 'CA', eligibleEEs: 10 }),
      policyWith({ eeContribution: '100' }),
      10,
    );
    assert.equal(result.percentage, 100);
    assert.equal(result.rule, 'as-quoted');
  });

  /** The 99% rule is explicitly a California rule; it must not leak to other states. */
  it('leaves 100% alone outside California', () => {
    const result = employerContribution(
      payloadWith({ state: 'CO', eligibleEEs: 10 }),
      policyWith({ eeContribution: '100' }),
      2,
    );
    assert.equal(result.percentage, 100);
    assert.equal(result.rule, 'as-quoted');
  });

  it('leaves a sub-100% California contribution alone', () => {
    const result = employerContribution(
      payloadWith({ state: 'CA', eligibleEEs: 10 }),
      policyWith({ eeContribution: '75.0' }),
      2,
    );
    assert.equal(result.percentage, 75);
    assert.equal(result.rule, 'as-quoted');
  });
});
