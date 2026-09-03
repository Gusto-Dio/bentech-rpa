import { SystemException } from '@rpa/core';

/**
 * Minimal RFC-4180-shaped delimited parser.
 *
 * Written out rather than split(',') on purpose: carrier and vendor files
 * routinely contain quoted fields with embedded commas, and a naive split
 * silently shifts every column after the first quoted value. A silent
 * off-by-one-column in a benefits roster is far worse than a crash.
 *
 * Handles: quoted fields, escaped quotes (""), CRLF, trailing newline.
 * Does not handle: multi-character delimiters, or a header row that repeats a
 * column name. An automation that needs more than this should reach for a real
 * CSV library rather than extending this.
 */
export interface DelimitedOptions {
  delimiter?: string;
}

export function parseDelimited(
  text: string,
  options: DelimitedOptions = {},
): Array<Record<string, string>> {
  const delimiter = options.delimiter ?? ',';
  const rows = parseRows(text, delimiter);

  const header = rows.shift();
  if (header === undefined || header.length === 0) {
    throw new SystemException('Delimited file is empty: no header row');
  }

  return rows
    .filter((row) => row.some((cell) => cell.trim().length > 0))
    .map((row) => {
      const record: Record<string, string> = {};
      header.forEach((column, index) => {
        record[column.trim()] = (row[index] ?? '').trim();
      });
      return record;
    });
}

function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
