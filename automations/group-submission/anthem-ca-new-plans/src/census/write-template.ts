import { BusinessException } from '@rpa/core';
import ExcelJS from 'exceljs';
import {
  ANTHEM_CENSUS_HEADERS,
  CENSUS_SHEET,
  toCellMatrix,
  type AnthemCensusRow,
} from './quoting-tab.ts';

/**
 * Writes the enrolling people into Anthem's OWN downloaded template.
 *
 * It fills the workbook the portal just handed us rather than building a
 * lookalike from scratch, because the template carries data validations, named
 * ranges and a `Key` sheet that the upload validates against. A hand-built
 * workbook with the right headers is the classic way to get a file that uploads
 * "successfully" and renders an empty grid.
 *
 * The header row is verified before anything is written: if Anthem reorders or
 * renames a column, that is a data-shape change we must notice loudly, not
 * silently write `Gender` into the `Relationship` column.
 */
export async function writeAnthemCensus(
  templatePath: string,
  outputPath: string,
  rows: readonly AnthemCensusRow[],
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  const sheet = workbook.getWorksheet(CENSUS_SHEET);
  if (sheet === undefined) {
    throw new BusinessException(
      `Anthem's census template has no "${CENSUS_SHEET}" sheet. The template has changed shape.`,
      { details: { sheets: workbook.worksheets.map((w) => w.name) } },
    );
  }

  const actual = (sheet.getRow(1).values as unknown[])
    .slice(1, ANTHEM_CENSUS_HEADERS.length + 1)
    .map((v) => String(v ?? '').trim());

  const mismatched = ANTHEM_CENSUS_HEADERS.map((expected, i) =>
    actual[i] === expected ? undefined : `column ${i + 1}: expected "${expected}", found "${actual[i] ?? ''}"`,
  ).filter((m): m is string => m !== undefined);

  if (mismatched.length > 0) {
    throw new BusinessException(
      "Anthem's census template header no longer matches what this automation writes. " +
        'Re-read the template and update ANTHEM_CENSUS_HEADERS before submitting anything.',
      { details: { mismatched, found: actual } },
    );
  }

  const matrix = toCellMatrix(rows);
  matrix.forEach((values, index) => {
    const row = sheet.getRow(index + 2);
    values.forEach((value, column) => {
      // Blank stays blank: writing '' into a validated cell can trip the
      // template's own validation, where an untouched cell does not.
      if (value !== '') row.getCell(column + 1).value = value;
    });
    row.commit();
  });

  await workbook.xlsx.writeFile(outputPath);
}
