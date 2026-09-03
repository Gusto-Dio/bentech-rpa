import { BusinessException } from '@rpa/core';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  HIPPO_CENSUS_COLUMNS,
  type CensusReader,
  type HippoCensusColumn,
  type HippoCensusRow,
  type SplitCensus,
} from './hippo-census.ts';

/**
 * Reads the Hippo OE census.
 *
 * Two formats, and both are real. Production hands us the `.xlsx` Hippo
 * exports - one sheet, named "Enrollment Census", which is the name the
 * Anthem_NewPlans macro selects by. The repo's committed fixtures are `.csv`,
 * because a binary blob is a poor thing to diff and worse to review for stray
 * PII. Rather than pick one and convert at the edges, this reads both: the
 * header row is the contract either way.
 */

/** What the macro selects. A Hippo export has exactly this one sheet. */
const ENROLLMENT_SHEET = 'Enrollment Census';

/**
 * Excel's epoch, as a day number.
 *
 * A date cell can arrive from exceljs as a JS Date (when the cell is formatted
 * as a date) or as a bare serial number (when it is not) - the real Hippo export
 * has DOB as 33192. Both have to become the same string, because the carrier
 * template is text and a stray "33192" in a date of birth is the kind of thing
 * that gets a census silently rejected. 1899-12-30, not 12-31, absorbs Excel's
 * deliberate 1900 leap-year bug.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/**
 * Serials outside this band are far more likely to be a quantity than a date.
 *
 * The floor is 61, not 1, and that is not arbitrary: Excel believes 1900 was a
 * leap year, so serials 1-60 (1900-01-01 to the imaginary 1900-02-29) do not map
 * cleanly and this conversion is a day out across that range. Every serial from
 * 61 on is exact. Nobody in a group census was born in January 1900, so the
 * honest move is to decline to interpret those rather than quietly shift them.
 */
const MIN_PLAUSIBLE_SERIAL = 61;
const MAX_PLAUSIBLE_SERIAL = 80_000; // ~year 2119

export function excelSerialToIsoDate(serial: number): string {
  const iso = new Date(EXCEL_EPOCH_MS + Math.round(serial) * MS_PER_DAY).toISOString();
  return iso.slice(0, 10);
}

/**
 * Normalises whatever a cell yields into the string the template wants.
 *
 * Everything downstream is text, so this is the one place that decides how a
 * date, a number and an empty cell each look.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim();

  // exceljs models rich text, formulas and hyperlinks as objects.
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['text'] === 'string') return record['text'].trim();
    if ('result' in record) return cellToString(record['result']);
    if (Array.isArray(record['richText'])) {
      return record['richText'].map((part) => cellToString((part as { text?: unknown }).text)).join('').trim();
    }
  }
  return String(value).trim();
}

/** Date columns get the serial treatment; everything else is left alone. */
const DATE_COLUMNS: ReadonlySet<string> = new Set<HippoCensusColumn>([
  'DOB',
  'Date Of Hire',
  'Benefits Status Start Date',
  'Medical Selection Effective Date',
  'Date Signed',
]);

function normaliseCell(header: string, value: unknown): string {
  const text = cellToString(value);
  if (!DATE_COLUMNS.has(header)) return text;
  const serial = Number(text);
  if (
    text !== '' &&
    Number.isFinite(serial) &&
    serial >= MIN_PLAUSIBLE_SERIAL &&
    serial <= MAX_PLAUSIBLE_SERIAL &&
    /^\d+(\.\d+)?$/.test(text)
  ) {
    return excelSerialToIsoDate(serial);
  }
  return text;
}

/**
 * A minimal RFC-4180 splitter.
 *
 * Hand-rolled rather than pulled in as a dependency: the automation import
 * boundary allows a short list of packages and a CSV parser is not on it, and
 * the header row here legitimately contains commas inside quotes
 * ("Carrier Name (Waiver Reason - Medical)" does not, but
 * "HSA Election - EE Total Election (Deduction + Contribution) - Benefit Period"
 * shows how baroque these names get). Quoted fields and doubled quotes are all
 * this format uses.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * A header Hippo does not recognise means the export contract changed, and every
 * downstream column mapping is then built on a guess. Business, not system: no
 * retry produces a different file.
 */
function assertKnownHeaders(headers: readonly string[], file: string): void {
  const known = new Set<string>(HIPPO_CENSUS_COLUMNS);
  const unknown = headers.filter((h) => h !== '' && !known.has(h));
  const missing = HIPPO_CENSUS_COLUMNS.filter((c) => !headers.includes(c));

  if (unknown.length === 0 && missing.length === 0) return;

  throw new BusinessException(
    `The census header does not match the Hippo export contract. ` +
      `${missing.length} expected column(s) missing, ${unknown.length} unexpected. ` +
      'The 35 column names are the contract with Hippo - see _shared/src/census/hippo-census.ts.',
    { details: { file: path.basename(file), missing, unknown } },
  );
}

function toRow(headers: readonly string[], values: readonly unknown[]): HippoCensusRow {
  const row: Record<string, string> = {};
  headers.forEach((header, index) => {
    if (header === '') return;
    const text = normaliseCell(header, values[index]);
    if (text !== '') row[header] = text;
  });
  return row as HippoCensusRow;
}

export class HippoCensusReader implements CensusReader {
  async read(file: string): Promise<HippoCensusRow[]> {
    const rows = file.toLowerCase().endsWith('.csv') ? await this.#readCsv(file) : await this.#readXlsx(file);

    if (rows.length === 0) {
      throw new BusinessException(
        'The census has a header but no people in it. A submission with nobody on it cannot be quoted.',
        { details: { file: path.basename(file) } },
      );
    }
    return rows;
  }

  /**
   * Enrolling vs waiving. THE split every later step depends on: the carrier
   * census template takes enrolling people only, and the EFT premium total sums
   * over enrolling members.
   *
   * A person is waiving when "Waiver Reason - Medical" is populated - that is
   * the rule stated in hippo-census.ts, and it is a stronger signal than
   * "Current Medical Enrollment Status" because the reason is what the carrier
   * ultimately needs and is therefore the field Hippo validates.
   */
  splitByEnrollment(rows: readonly HippoCensusRow[]): SplitCensus {
    const enrolling: HippoCensusRow[] = [];
    const waiving: HippoCensusRow[] = [];
    for (const row of rows) {
      const reason = row['Waiver Reason - Medical']?.trim() ?? '';
      if (reason === '') enrolling.push(row);
      else waiving.push(row);
    }
    return { enrolling, waiving };
  }

  async #readCsv(file: string): Promise<HippoCensusRow[]> {
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    const [headerLine, ...dataLines] = lines;
    if (headerLine === undefined) {
      throw new BusinessException('The census file is empty.', { details: { file: path.basename(file) } });
    }

    const headers = splitCsvLine(headerLine);
    assertKnownHeaders(headers, file);
    return dataLines.map((line) => toRow(headers, splitCsvLine(line)));
  }

  async #readXlsx(file: string): Promise<HippoCensusRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);

    /**
     * By name first, matching the macro. Falling back to the only sheet is
     * deliberate: a re-saved export sometimes loses the name, and refusing a
     * single-sheet workbook over its title would be pedantry. More than one
     * unnamed sheet IS ambiguous, and that refuses.
     */
    const sheet =
      workbook.getWorksheet(ENROLLMENT_SHEET) ??
      (workbook.worksheets.length === 1 ? workbook.worksheets[0] : undefined);

    if (sheet === undefined) {
      throw new BusinessException(
        `The census workbook has no "${ENROLLMENT_SHEET}" sheet and more than one sheet to guess from.`,
        {
          details: {
            file: path.basename(file),
            sheets: workbook.worksheets.map((w) => w.name),
          },
        },
      );
    }

    const headers = (sheet.getRow(1).values as unknown[]).slice(1).map((v) => cellToString(v));
    assertKnownHeaders(headers, file);

    const rows: HippoCensusRow[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = (row.values as unknown[]).slice(1);
      const built = toRow(headers, values);
      // The macro appends a "Total Premium" summary two rows below the data, so
      // a trailing row with no name is a footer, not a person.
      if ((built['First Name'] ?? '') === '' && (built['Last Name'] ?? '') === '') return;
      rows.push(built);
    });
    return rows;
  }
}
