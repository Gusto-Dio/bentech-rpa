import { BusinessException } from '@rpa/core';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { HIPPO_CENSUS_COLUMNS } from './hippo-census.ts';
import { HippoCensusReader, excelSerialToIsoDate, splitCsvLine } from './hippo-census-reader.ts';

const HEADER = HIPPO_CENSUS_COLUMNS.join(',');

/** Column order matches HIPPO_CENSUS_COLUMNS; only the interesting cells differ. */
function personCsv(overrides: Partial<Record<string, string>>): string {
  const base: Record<string, string> = {
    'First Name': 'Jane',
    'Last Name': 'Doe',
    Relationship: 'Employee',
    DOB: '1990-11-15',
    Gender: 'Female',
    'Current Medical Cost - Premium': '695.35',
  };
  const merged = { ...base, ...overrides };
  return HIPPO_CENSUS_COLUMNS.map((c) => merged[c] ?? '').join(',');
}

async function writeTemp(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'census-'));
  const file = path.join(dir, name);
  await writeFile(file, contents, 'utf8');
  return file;
}

describe('splitCsvLine', () => {
  it('keeps commas that live inside quotes', () => {
    assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  });

  it('unescapes a doubled quote', () => {
    assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
  });

  it('preserves empty trailing fields, because column position is the contract', () => {
    assert.deepEqual(splitCsvLine('a,,'), ['a', '', '']);
  });
});

describe('excelSerialToIsoDate', () => {
  /**
   * 33192 and 32399 are the literal DOB cells in the real Hippo .xlsx export,
   * and 1990-11-15 / 1988-09-13 are the same two people's DOBs in the .csv
   * fixture. That the two formats agree is the actual proof the conversion is
   * right - if it drifts by a day the census carries wrong dates of birth and
   * the carrier rates the group on the wrong ages.
   */
  it('converts the serials from the real Hippo export', () => {
    assert.equal(excelSerialToIsoDate(33192), '1990-11-15');
    assert.equal(excelSerialToIsoDate(32399), '1988-09-13');
  });

  it('is exact from serial 61 on, where Excel and reality agree', () => {
    assert.equal(excelSerialToIsoDate(61), '1900-03-01');
  });
});

describe('HippoCensusReader - csv', () => {
  it('reads people keyed by the literal Hippo header text', async () => {
    const file = await writeTemp('census.csv', `${HEADER}\n${personCsv({})}\n`);
    const rows = await new HippoCensusReader().read(file);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['First Name'], 'Jane');
    assert.equal(rows[0]?.['Gender'], 'Female');
    assert.equal(rows[0]?.['DOB'], '1990-11-15');
  });

  /**
   * A changed header means every downstream column mapping is built on a guess.
   * Business, not system: re-running produces the same file.
   */
  it('refuses a header that is not the Hippo contract', async () => {
    const file = await writeTemp('census.csv', 'Forename,Surname\nJane,Doe\n');
    await assert.rejects(() => new HippoCensusReader().read(file), BusinessException);
  });

  it('refuses a census with a header and nobody on it', async () => {
    const file = await writeTemp('census.csv', `${HEADER}\n`);
    await assert.rejects(() => new HippoCensusReader().read(file), BusinessException);
  });
});

describe('HippoCensusReader - xlsx', () => {
  async function writeWorkbook(sheetName: string, rows: string[][]): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'census-'));
    const file = path.join(dir, 'census.xlsx');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow([...HIPPO_CENSUS_COLUMNS]);
    for (const row of rows) sheet.addRow(row);
    await workbook.xlsx.writeFile(file);
    return file;
  }

  function xlsxPerson(overrides: Record<string, string>): string[] {
    const base: Record<string, string> = { 'First Name': 'Jane', 'Last Name': 'Doe', Relationship: 'Employee' };
    const merged = { ...base, ...overrides };
    return HIPPO_CENSUS_COLUMNS.map((c) => merged[c] ?? '');
  }

  it('reads the sheet the macro selects by name', async () => {
    const file = await writeWorkbook('Enrollment Census', [xlsxPerson({ Gender: 'Female' })]);
    const rows = await new HippoCensusReader().read(file);
    assert.equal(rows[0]?.['Gender'], 'Female');
  });

  /** The real export has DOB as a bare serial, not a formatted date. */
  it('turns a bare date serial into an ISO date', async () => {
    const file = await writeWorkbook('Enrollment Census', [xlsxPerson({ DOB: '33192' })]);
    const rows = await new HippoCensusReader().read(file);
    assert.equal(rows[0]?.['DOB'], '1990-11-15');
  });

  it('leaves a non-date numeric column alone', async () => {
    const file = await writeWorkbook('Enrollment Census', [xlsxPerson({ 'Employee Salary': '120000' })]);
    const rows = await new HippoCensusReader().read(file);
    assert.equal(rows[0]?.['Employee Salary'], '120000');
  });

  /** The macro appends a "Total Premium" footer two rows below the data. */
  it('ignores a trailing footer row that names nobody', async () => {
    const file = await writeWorkbook('Enrollment Census', [
      xlsxPerson({}),
      HIPPO_CENSUS_COLUMNS.map((c) => (c === 'Current Medical Cost - Premium' ? '1180.19' : '')),
    ]);
    const rows = await new HippoCensusReader().read(file);
    assert.equal(rows.length, 1);
  });

  it('accepts a single differently-named sheet, since that is unambiguous', async () => {
    const file = await writeWorkbook('Sheet1', [xlsxPerson({})]);
    assert.equal((await new HippoCensusReader().read(file)).length, 1);
  });
});

describe('splitByEnrollment', () => {
  /**
   * THE split. The carrier template takes enrolling people only, and a waiving
   * employee on a quote is the failure the runbook shouts about.
   */
  it('splits on Waiver Reason - Medical being populated', async () => {
    const file = await writeTemp(
      'census.csv',
      [
        HEADER,
        personCsv({ 'First Name': 'Jane' }),
        personCsv({ 'First Name': 'Alec', 'Waiver Reason - Medical': 'covered_by_other_employer' }),
        personCsv({ 'First Name': 'Bob' }),
      ].join('\n'),
    );

    const reader = new HippoCensusReader();
    const { enrolling, waiving } = reader.splitByEnrollment(await reader.read(file));

    assert.deepEqual(
      enrolling.map((r) => r['First Name']),
      ['Jane', 'Bob'],
    );
    assert.deepEqual(
      waiving.map((r) => r['First Name']),
      ['Alec'],
    );
  });

  it('treats a whitespace-only waiver reason as enrolling', () => {
    const { enrolling, waiving } = new HippoCensusReader().splitByEnrollment([
      { 'First Name': 'Jane', 'Waiver Reason - Medical': '   ' },
    ]);
    assert.equal(enrolling.length, 1);
    assert.equal(waiving.length, 0);
  });
});
