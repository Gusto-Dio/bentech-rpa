import { BusinessException } from '@rpa/core';
import { HippoCensusReader, type HippoCensusRow } from '@auto/group-submission-shared';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import {
  ANTHEM_CENSUS_HEADERS,
  CENSUS_SHEET,
  anthemDate,
  anthemGender,
  anthemRelationship,
  buildAnthemCensusRows,
  coverageTier,
  toCellMatrix,
} from './quoting-tab.ts';
import { writeAnthemCensus } from './write-template.ts';

const DATA = path.join(import.meta.dirname, '..', '..', 'data', 'input');
const FIXTURE = path.join(DATA, 'census-sample.csv');
/** Anthem's real template, downloaded from the portal 2026-09-03. */
const TEMPLATE = path.join(DATA, 'anthem-census-template.xlsx');

function person(over: Partial<Record<string, string>>): HippoCensusRow {
  return {
    'First Name': 'Jane',
    'Last Name': 'Doe',
    Gender: 'Female',
    Relationship: 'Employee',
    DOB: '1990-11-15',
    Zip: '94107',
    'EE SSN': '000-12-3456',
    ...over,
  } as HippoCensusRow;
}

describe('anthemRelationship', () => {
  it('passes through the three values the Key sheet allows', () => {
    assert.equal(anthemRelationship('Employee'), 'Employee');
    assert.equal(anthemRelationship('Spouse'), 'Spouse');
    assert.equal(anthemRelationship('Child'), 'Child');
  });

  /**
   * The macro's substring replacement produced "Domestic Spouse", which is NOT
   * in the template's Key sheet. Mapping to plain `Spouse` is the correction the
   * real template forced.
   */
  it('maps Domestic Partner to Spouse, not "Domestic Spouse"', () => {
    assert.equal(anthemRelationship('Domestic Partner'), 'Spouse');
  });

  it('refuses a relationship the template cannot express', () => {
    assert.throws(() => anthemRelationship('Grandparent'), BusinessException);
  });
});

describe('anthemDate', () => {
  /**
   * The live upload showed Jane Doe as `Nov 14, 1990` when the census says
   * `1990-11-15`: the ISO string was read as a date at UTC midnight and rendered
   * in a US timezone. An off-by-one DOB re-ages the member and the carrier rates
   * the group wrongly, invisibly.
   */
  it('emits the format the census screen declares', () => {
    assert.equal(anthemDate('1990-11-15'), 'Nov 15, 1990');
    assert.equal(anthemDate('1988-09-13'), 'Sep 13, 1988');
  });

  it('does not shift the day, whatever the local timezone', () => {
    assert.equal(anthemDate('2015-01-01'), 'Jan 1, 2015');
    assert.equal(anthemDate('2015-12-31'), 'Dec 31, 2015');
  });

  it('refuses anything that is not an ISO date rather than guessing', () => {
    assert.throws(() => anthemDate('15/11/1990'), BusinessException);
  });
});

describe('anthemGender', () => {
  it('normalises what Hippo emits', () => {
    assert.equal(anthemGender('Female'), 'Female');
    assert.equal(anthemGender('male'), 'Male');
  });

  /** Guessing a gender onto a carrier submission is not the automation's call. */
  it('refuses a value the template has no option for', () => {
    assert.throws(() => anthemGender('Non-Binary'), BusinessException);
  });
});

describe('coverageTier', () => {
  it('is Employee with no dependants', () => {
    assert.equal(coverageTier([]), 'Employee');
  });
  it('is Employee + Spouse for a spouse alone', () => {
    assert.equal(coverageTier([person({ Relationship: 'Spouse' })]), 'Employee + Spouse');
  });
  it('is Employee + Child(ren) for children alone', () => {
    assert.equal(coverageTier([person({ Relationship: 'Child' })]), 'Employee + Child(ren)');
  });
  it('is Family for both', () => {
    assert.equal(
      coverageTier([person({ Relationship: 'Spouse' }), person({ Relationship: 'Child' })]),
      'Family',
    );
  });
});

describe('buildAnthemCensusRows', () => {
  it('produces the template\'s ten columns for a lone employee', () => {
    const [row] = toCellMatrix(buildAnthemCensusRows([person({})]));
    assert.deepEqual(row, [
      'Jane', 'Doe', 'Female', 'Employee', 'Nov 15, 1990', '94107', 'No', 'Employee', '', '',
    ]);
  });

  /**
   * Families are linked by `EE SSN`, not surname - two unrelated Smiths must not
   * merge into one family and inflate the tier.
   */
  it('keeps the tier on the employee and leaves dependants blank', () => {
    const rows = toCellMatrix(
      buildAnthemCensusRows([
        person({}),
        person({ 'First Name': 'Sam', Relationship: 'Spouse', Gender: 'Male' }),
        person({ 'First Name': 'Kit', Relationship: 'Child', Gender: 'Female', DOB: '2015-04-02' }),
      ]),
    );

    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.[3], 'Employee');
    assert.equal(rows[0]?.[7], 'Family', 'the employee carries the tier');
    assert.equal(rows[1]?.[7], '', 'a dependant carries no tier');
    assert.equal(rows[2]?.[5], '94107', 'dependants inherit the employee ZIP');
  });

  it('does not merge two unrelated employees who share a surname', () => {
    const rows = buildAnthemCensusRows([
      person({ 'EE SSN': '000-11-1111' }),
      person({ 'First Name': 'Alec', 'EE SSN': '000-22-2222', Gender: 'Male' }),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.medical), ['Employee', 'Employee']);
  });

  it('refuses a dependant with no employee to attach to', () => {
    assert.throws(
      () => buildAnthemCensusRows([person({ Relationship: 'Child' })]),
      BusinessException,
    );
  });
});

describe('writeAnthemCensus, against the real downloaded template', () => {
  /**
   * The acceptance case: three synthetic people, one waiving, so two reach
   * Anthem. Asserting the produced CELLS in the real workbook - a waiving
   * employee on a census is a silently wrong submission, and a malformed file
   * uploads "successfully" and renders an empty grid.
   */
  it('writes the enrolling people into Employer Census', async () => {
    const reader = new HippoCensusReader();
    const { enrolling, waiving } = reader.splitByEnrollment(await reader.read(FIXTURE));
    assert.equal(waiving.length, 1, 'Robin waives');

    const out = path.join(await mkdtemp(path.join(tmpdir(), 'anthem-')), 'census.xlsx');
    await writeAnthemCensus(TEMPLATE, out, buildAnthemCensusRows(enrolling));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sheet = wb.getWorksheet(CENSUS_SHEET);
    assert.ok(sheet, 'the Employer Census sheet survives the write');

    const header = (sheet.getRow(1).values as unknown[]).slice(1, 11).map((v) => String(v ?? ''));
    assert.deepEqual(header, [...ANTHEM_CENSUS_HEADERS]);

    const read = (r: number): string[] =>
      (sheet.getRow(r).values as unknown[]).slice(1, 11).map((v) => String(v ?? ''));

    assert.deepEqual(read(2), ['Jane', 'Doe', 'Female', 'Employee', 'Nov 15, 1990', '94102', 'No', 'Employee']);
    assert.deepEqual(read(3), ['Alec', 'Smith', 'Male', 'Employee', 'Sep 13, 1988', '94133', 'No', 'Employee']);
    assert.equal(sheet.getCell('A4').value, null, 'the waiving employee is not written');
  });

  it('refuses to write when the template header has changed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'anthem-'));
    const tampered = path.join(dir, 'tampered.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(TEMPLATE);
    wb.getWorksheet(CENSUS_SHEET)!.getCell('C1').value = 'Sex';
    await wb.xlsx.writeFile(tampered);

    await assert.rejects(
      () => writeAnthemCensus(tampered, path.join(dir, 'out.xlsx'), buildAnthemCensusRows([person({})])),
      BusinessException,
    );
  });
});
