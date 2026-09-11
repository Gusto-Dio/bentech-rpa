import { BusinessException, SystemException } from '@rpa/core';
import { HippoCensusReader, type HippoCensusRow } from '@auto/group-submission-shared';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildBulkCensusRows, coverageTypeFor, groupByEmployee, SAMX_COLUMNS } from './bulk-census.ts';
import { samxWaiverReason } from './samx-vocabulary.ts';
import { assertTemplateShapeKnown, toCells } from './write-template.ts';

/** The synthetic census that ships with the automation: 3 employees, 1 waiving. */
const SAMPLE_CENSUS = path.join(import.meta.dirname, '..', '..', 'data', 'input', 'census-sample.csv');

function person(over: HippoCensusRow): HippoCensusRow {
  return { 'First Name': 'Test', 'Last Name': 'Person', 'Relationship': 'Employee', ...over };
}

describe('coverageTypeFor', () => {
  it('is employee-only with no dependants', () => {
    assert.equal(coverageTypeFor([]), 'employee-only');
  });

  it('is employee-spouse for a spouse alone', () => {
    assert.equal(coverageTypeFor([person({ 'Relationship': 'Spouse' })]), 'employee-spouse');
  });

  /** TODO(remap) in the source: UHC may carry a distinct domestic-partner tier. */
  it('folds a domestic partner into the spouse tier', () => {
    assert.equal(coverageTypeFor([person({ 'Relationship': 'Domestic Partner' })]), 'employee-spouse');
  });

  it('is employee-children for children alone', () => {
    assert.equal(
      coverageTypeFor([person({ 'Relationship': 'Child' }), person({ 'Relationship': 'Child' })]),
      'employee-children',
    );
  });

  it('is family for a spouse and a child', () => {
    assert.equal(
      coverageTypeFor([person({ 'Relationship': 'Spouse' }), person({ 'Relationship': 'Child' })]),
      'family',
    );
  });

  it('refuses a relationship it cannot place rather than guessing a tier', () => {
    assert.throws(() => coverageTypeFor([person({ 'Relationship': 'Nephew' })]), BusinessException);
  });
});

describe('groupByEmployee', () => {
  /**
   * The family key is `EE SSN`, not the surname: two unrelated Smiths must not
   * merge into one family and inherit each other's tier.
   */
  it('groups a family by the employee SSN, not the surname', () => {
    const families = groupByEmployee([
      person({ 'First Name': 'Ada', 'Last Name': 'Smith', 'EE SSN': '000-12-3456' }),
      person({ 'First Name': 'Bo', 'Last Name': 'Smith', 'Relationship': 'Spouse', 'EE SSN': '000-12-3456' }),
      person({ 'First Name': 'Cy', 'Last Name': 'Smith', 'EE SSN': '000-12-9999' }),
    ]);

    assert.equal(families.length, 2);
    const ada = families.find((f) => f.employee['First Name'] === 'Ada');
    assert.equal(ada?.dependants.length, 1);
    assert.equal(families.find((f) => f.employee['First Name'] === 'Cy')?.dependants.length, 0);
  });

  it('refuses dependants with no employee row', () => {
    assert.throws(
      () => groupByEmployee([person({ 'Relationship': 'Child', 'EE SSN': '000-12-3456' })]),
      BusinessException,
    );
  });
});

describe('buildBulkCensusRows', () => {
  it('produces one row per person for the sample census, with the waiver last', async () => {
    const reader = new HippoCensusReader();
    const split = reader.splitByEnrollment(await reader.read(SAMPLE_CENSUS));

    assert.equal(split.enrolling.length, 2);
    assert.equal(split.waiving.length, 1);

    const rows = buildBulkCensusRows(split);
    assert.equal(rows.length, 3);

    assert.deepEqual(
      rows.map((r) => [r.lastName, r.coverage, r.medicalPlanCode, r.waivesAllProducts]),
      [
        ['Doe', 'employee-only', 'EPHE-L31S', false],
        ['Smith', 'employee-only', 'EPG7-L31S', false],
        ['Waverly', 'waived', '', true],
      ],
    );
    assert.equal(rows[2]?.waiverReason, 'individual_policy');
  });

  it('carries the plan code on the employee and leaves the dependant blank', () => {
    const rows = buildBulkCensusRows({
      enrolling: [
        person({ 'Last Name': 'Doe', 'EE SSN': '000-12-3456', 'Current Medical Policy': 'EPHE-L31S' }),
        person({ 'Last Name': 'Doe', 'Relationship': 'Spouse', 'EE SSN': '000-12-3456' }),
      ],
      waiving: [],
    });

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.medicalPlanCode, 'EPHE-L31S');
    assert.equal(rows[0]?.coverage, 'employee-spouse');
    // Column AQ carries the SSN for dependants too, and it is the employee's.
    assert.equal(rows[1]?.ssn, '000-12-3456');
    assert.equal(rows[1]?.coverage, undefined);
    assert.equal(rows[1]?.medicalPlanCode, '');
  });

  /** A waiving DEPENDANT is dropped before transforming, and does not raise the tier. */
  it('drops waiving dependants instead of counting them towards the tier', () => {
    const rows = buildBulkCensusRows({
      enrolling: [person({ 'Last Name': 'Doe', 'EE SSN': '000-12-3456' })],
      waiving: [
        person({
          'Last Name': 'Doe',
          'Relationship': 'Spouse',
          'EE SSN': '000-12-3456',
          'Waiver Reason - Medical': 'individual_policy',
        }),
      ],
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.coverage, 'employee-only');
  });

  it('refuses an employee who is both enrolling and waiving', () => {
    assert.throws(
      () =>
        buildBulkCensusRows({
          enrolling: [person({ 'Last Name': 'Doe', 'EE SSN': '000-12-3456' })],
          waiving: [
            person({ 'Last Name': 'Doe', 'EE SSN': '000-12-3456', 'Waiver Reason - Medical': 'individual_policy' }),
          ],
        }),
      BusinessException,
    );
  });

  it('refuses a waiving employee with no waiver reason', () => {
    assert.throws(
      () => buildBulkCensusRows({ enrolling: [], waiving: [person({ 'Last Name': 'Doe' })] }),
      BusinessException,
    );
  });
});

describe('samxWaiverReason', () => {
  it('maps the one reason the source docs state', () => {
    assert.equal(samxWaiverReason('individual_policy'), 'Individual Exchange');
  });

  /**
   * A guessed waiver reason is a silently incorrect submission, so an unmapped
   * one stops rather than passing through.
   */
  it('refuses a reason that has not been read off the portal dropdown', () => {
    assert.throws(() => samxWaiverReason('spouse_plan'), BusinessException);
    assert.throws(() => samxWaiverReason(''), BusinessException);
  });
});

describe('the template guard', () => {
  /**
   * These two prove the port FAILS CLOSED while the real template is unknown.
   * They are the tests that must be deleted-and-replaced during the re-map, not
   * worked around: passing them today is what stops a blind write to a
   * validated carrier template.
   */
  it('refuses to write until the template shape has been recorded', () => {
    assert.throws(() => assertTemplateShapeKnown(), SystemException);
  });

  it('refuses to place a coverage type until column R\'s vocabulary is recorded', () => {
    assert.throws(
      () =>
        toCells({
          firstName: 'Jane',
          lastName: 'Doe',
          relationship: 'Employee',
          ssn: '000-12-3456',
          coverage: 'employee-only',
          waivesAllProducts: false,
          waiverReason: undefined,
          medicalPlanCode: 'EPHE-L31S',
        }),
      SystemException,
    );
  });

  /** The columns the runbook names, so a typo in a letter is caught here. */
  it('writes the columns the runbook specifies', () => {
    assert.deepEqual(SAMX_COLUMNS, {
      medicalCoverageType: 'R',
      medicalWaiverReason: 'S',
      waiveAllProducts: 'Y',
      medicalPlanCode: 'Z',
      medicalWaiverReasonRepeat: 'AA',
      ssn: 'AQ',
    });
  });

  /** A dependant row carries no tier, so it needs no vocabulary and must not throw. */
  it('places a dependant row without needing the coverage vocabulary', () => {
    const cells = toCells({
      firstName: 'Bo',
      lastName: 'Doe',
      relationship: 'Spouse',
      ssn: '000-12-3456',
      coverage: undefined,
      waivesAllProducts: false,
      waiverReason: undefined,
      medicalPlanCode: '',
    });

    assert.equal(cells[SAMX_COLUMNS.ssn], '000-12-3456');
    assert.equal(cells[SAMX_COLUMNS.medicalCoverageType], undefined);
  });
});
