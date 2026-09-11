import { z } from 'zod';

/**
 * The Hippo OE census: the single input every group-submission automation reads
 * before it touches a portal.
 *
 * 35 columns, one row per enrolling or waiving person (employee or dependent).
 * The header names below are exactly as they appear in the export - they are the
 * contract with Hippo, so they are not renamed to look tidier.
 *
 * ── NOT IMPLEMENTED YET ──────────────────────────────────────────────────────
 * Reading and transforming this is the census port described in
 * docs/poc/excel-macros.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const HIPPO_CENSUS_COLUMNS = [
  'First Name',
  'Last Name',
  'Relationship',
  'Title',
  'Email',
  'Phone Number',
  'Enrollment Type',
  'DOB',
  'Address',
  'City',
  'State',
  'Zip',
  'Gender',
  'EE SSN',
  'Identifier',
  'Identifier Type',
  'Date Of Hire',
  'Benefits Status',
  'Benefits Status Start Date',
  'Employee Salary',
  'Hours Worked',
  'Current Medical Policy',
  'Current Medical Carrier',
  'Current Medical Enrollment Status',
  'Waiver Reason - Medical',
  'Carrier Name (Waiver Reason - Medical)',
  'ID Number (Waiver Reason - Medical)',
  'Medical Selection Effective Date',
  'Current Medical Cost - Premium',
  'Current Medical Cost - ER Contribution',
  'Current Medical Cost - EE Deduction',
  'Date Signed',
  'Disability Status',
  'Tobacco Status',
  'HSA Election - EE Total Election (Deduction + Contribution) - Benefit Period',
] as const;

export type HippoCensusColumn = (typeof HIPPO_CENSUS_COLUMNS)[number];

/** One row, keyed by the literal header text. */
export type HippoCensusRow = Partial<Record<HippoCensusColumn, string>>;

export const relationshipSchema = z.enum(['Employee', 'Spouse', 'Domestic Partner', 'Child']);

/**
 * Enrolling vs waiving is THE split every downstream step depends on: the
 * carrier census templates take enrolling people only, waivers go on a separate
 * tab, and the EFT premium total is the sum over enrolling members.
 *
 * A person is waiving when "Waiver Reason - Medical" is populated.
 */
export interface SplitCensus {
  enrolling: HippoCensusRow[];
  waiving: HippoCensusRow[];
}

export interface CensusReader {
  /** Reads the OE census from an .xlsx path. */
  read(file: string): Promise<HippoCensusRow[]>;
  splitByEnrollment(rows: readonly HippoCensusRow[]): SplitCensus;
}

/**
 * Waiver reasons need translating to each carrier's vocabulary. The one
 * mapping the source docs state explicitly:
 *
 *   Hippo `individual_policy`  ->  UHC portal `Individual Exchange`
 *
 * TODO(prompt): the rest of this table has to be built by reading the portal's
 * own dropdown during the re-mapping pass. Do not guess it.
 */
export const WAIVER_REASON_TO_UHC: Readonly<Record<string, string>> = {
  individual_policy: 'Individual Exchange',
};
