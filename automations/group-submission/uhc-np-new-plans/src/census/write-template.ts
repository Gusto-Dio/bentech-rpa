import { BusinessException, SystemException } from '@rpa/core';
import ExcelJS from 'exceljs';
import { SAMX_COLUMNS, type SamxCensusRow } from './bulk-census.ts';
import { samxCoverageType, samxWaiverReason, samxYesNo } from './samx-vocabulary.ts';

/**
 * Writes the census into SAMx's OWN downloaded bulk template.
 *
 * It fills the workbook the portal just handed us rather than building a
 * lookalike, for the reason Anthem's port documents: the template carries data
 * validations and key sheets that the upload validates against, and a hand-built
 * workbook with the right headers is the classic way to produce a file that
 * uploads "successfully" and renders an empty grid.
 *
 * That matters more here than on Anthem, because SAMx's upload is
 * ALL-OR-NOTHING: any error and no employee data loads at all, and the portal
 * shows a popup listing every problem at once.
 */

/** The sheet to fill. TODO(remap): read the real sheet name off the template. */
export const SAMX_CENSUS_SHEET: string | null = null;

/**
 * The header text expected at each column this port writes.
 *
 * ── WHY THESE ARE null, AND WHY THAT BLOCKS WRITING ──────────────────────────
 * The runbook gives the column LETTERS but not their header text, and the real
 * SAMx_PortalBulkCensus template is downloaded from a portal nobody has signed
 * in to yet. Anthem's equivalent guard compares against headers read off the
 * real file; there is nothing to compare against here.
 *
 * Writing anyway is the failure this guard exists to prevent. Column R is one
 * cell away from column S; putting a coverage type where a waiver reason belongs
 * produces a file that uploads cleanly and enrolls the wrong coverage, and
 * nothing reports a problem. So the writer refuses until these are recorded.
 *
 * TODO(remap): download the template, record the header at each letter here and
 * the sheet name above, then fill in samx-vocabulary.ts from the key sheet.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const SAMX_CENSUS_HEADERS: Readonly<Record<string, string | null>> = {
  [SAMX_COLUMNS.medicalCoverageType]: null,
  [SAMX_COLUMNS.medicalWaiverReason]: null,
  [SAMX_COLUMNS.waiveAllProducts]: null,
  [SAMX_COLUMNS.medicalPlanCode]: null,
  [SAMX_COLUMNS.medicalWaiverReasonRepeat]: null,
  [SAMX_COLUMNS.ssn]: null,
};

/** The row the template's headers live on. TODO(remap): confirm against the real file. */
export const SAMX_HEADER_ROW = 1;

/**
 * The cell values for one person, keyed by column letter.
 *
 * Separated from the workbook so it can be asserted directly in tests - "a
 * known input produces a known output", which docs/poc/excel-macros.md names as
 * the test this port needs. Asserting that writing did not throw proves nothing
 * about which column each value landed in.
 */
export function toCells(row: SamxCensusRow): Record<string, string> {
  const cells: Record<string, string> = {
    [SAMX_COLUMNS.ssn]: row.ssn,
    [SAMX_COLUMNS.medicalPlanCode]: row.medicalPlanCode,
  };

  // Only the employee row carries a tier; a dependant's column R stays blank.
  if (row.coverage !== undefined) {
    cells[SAMX_COLUMNS.medicalCoverageType] = samxCoverageType(row.coverage);
  }

  if (row.waiverReason !== undefined) {
    const reason = samxWaiverReason(row.waiverReason);
    // The template asks for the same reason twice, in S and again in AA.
    cells[SAMX_COLUMNS.medicalWaiverReason] = reason;
    cells[SAMX_COLUMNS.medicalWaiverReasonRepeat] = reason;
    cells[SAMX_COLUMNS.waiveAllProducts] = samxYesNo(row.waivesAllProducts);
  }

  return cells;
}

/**
 * Fails closed when the template's shape has never been recorded.
 *
 * A never-recorded header is a SystemException: this automation is not
 * finished, and no group's data would change that. Reporting it as a business
 * failure would file the group as a carrier rejection when nothing was ever
 * submitted. Actual DRIFT - a header we recorded that no longer matches - is a
 * BusinessException, matching Anthem's guard, because the template is data that
 * arrived from the portal and a human has to look at it.
 */
export function assertTemplateShapeKnown(): void {
  const unrecorded = Object.entries(SAMX_CENSUS_HEADERS)
    .filter(([, header]) => header === null)
    .map(([column]) => column);

  if (SAMX_CENSUS_SHEET === null || unrecorded.length > 0) {
    throw new SystemException(
      'The SAMx bulk census template has never been read, so its shape is unknown and this ' +
        'automation cannot safely write to it. Download SAMx_PortalBulkCensus from the quoting ' +
        'stage, record the sheet name and the header at each column in write-template.ts, and ' +
        'fill in samx-vocabulary.ts from the template key sheet.',
      { details: { sheet: SAMX_CENSUS_SHEET, unrecordedColumns: unrecorded } },
    );
  }
}

export async function writeBulkCensus(
  templatePath: string,
  outputPath: string,
  rows: readonly SamxCensusRow[],
): Promise<void> {
  assertTemplateShapeKnown();

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  const sheet = workbook.getWorksheet(SAMX_CENSUS_SHEET as unknown as string);
  if (sheet === undefined) {
    throw new BusinessException(
      `The SAMx census template has no "${SAMX_CENSUS_SHEET}" sheet. The template has changed shape.`,
      { details: { sheets: workbook.worksheets.map((w) => w.name) } },
    );
  }

  const header = sheet.getRow(SAMX_HEADER_ROW);
  const mismatched = Object.entries(SAMX_CENSUS_HEADERS)
    .map(([column, expected]) => {
      const found = String(header.getCell(column).value ?? '').trim();
      return found === expected ? undefined : `column ${column}: expected "${expected}", found "${found}"`;
    })
    .filter((m): m is string => m !== undefined);

  if (mismatched.length > 0) {
    throw new BusinessException(
      "The SAMx census template header no longer matches what this automation writes. " +
        'Re-read the template and update SAMX_CENSUS_HEADERS before uploading anything - the ' +
        'upload is all-or-nothing and a shifted column enrolls the wrong coverage silently.',
      { details: { mismatched } },
    );
  }

  rows.forEach((row, index) => {
    const target = sheet.getRow(SAMX_HEADER_ROW + 1 + index);
    for (const [column, value] of Object.entries(toCells(row))) {
      // Blank stays blank: writing '' into a validated cell can trip the
      // template's own validation, where an untouched cell does not.
      if (value !== '') target.getCell(column).value = value;
    }
    target.commit();
  });

  await workbook.xlsx.writeFile(outputPath);
}
