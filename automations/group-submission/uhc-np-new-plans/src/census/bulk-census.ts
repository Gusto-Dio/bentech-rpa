import { BusinessException } from '@rpa/core';
import type { HippoCensusRow, SplitCensus } from '@auto/group-submission-shared';
import type { CoverageType } from './samx-vocabulary.ts';

/**
 * The SAMx_PortalBulkCensus port: Hippo OE census -> the SAMx bulk template.
 *
 * See docs/poc/excel-macros.md. This is the TypeScript replacement for the
 * `SAMx_PortalBulkCensus` VBA macro, and like Anthem's port it is written
 * against the runbook's column list rather than the macro's source, because the
 * runbook is what was verified against the portal.
 *
 * ── WHAT IS KNOWN, AND WHAT IS NOT ───────────────────────────────────────────
 * The runbook names six columns and what belongs in them:
 *
 *   R    Medical Coverage Type      (derived from relationship + enrollment)
 *   S    Medical Waiver Reason
 *   Y    Waive All Products         (derived - a waiver reason is populated)
 *   Z    Medical Plan Code
 *   AA   Medical Waiver Reason      (again - the template repeats it)
 *   AQ   SSN                        (employees AND dependants)
 *
 * It does NOT name the columns carrying names, dates of birth, gender or
 * address, and it does not name the values column R and Y accept. So this module
 * computes every value the runbook specifies, in a form that is fully testable
 * without the portal, and `write-template.ts` refuses to write until the
 * template's real header row has been recorded. Dental and vision columns are
 * deliberately left blank: this covers medical and employee/dependant info only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The columns this port writes, by their runbook letters. */
export const SAMX_COLUMNS = {
  medicalCoverageType: 'R',
  medicalWaiverReason: 'S',
  waiveAllProducts: 'Y',
  medicalPlanCode: 'Z',
  medicalWaiverReasonRepeat: 'AA',
  ssn: 'AQ',
} as const;

export type SamxColumn = (typeof SAMX_COLUMNS)[keyof typeof SAMX_COLUMNS];

/**
 * One person's row, as decisions rather than portal strings.
 *
 * Keeping the semantic form separate from the template's vocabulary is what
 * makes the grouping and waiver logic testable today, while the accepted values
 * are still unknown - see samx-vocabulary.ts.
 */
export interface SamxCensusRow {
  readonly firstName: string;
  readonly lastName: string;
  readonly relationship: string;
  readonly ssn: string;
  /** Only the employee row carries a coverage type; dependants leave it blank. */
  readonly coverage: CoverageType | undefined;
  readonly waivesAllProducts: boolean;
  /** Hippo's raw reason. Translated at write time so the mapping has one home. */
  readonly waiverReason: string | undefined;
  readonly medicalPlanCode: string;
}

function text(row: HippoCensusRow, column: keyof HippoCensusRow): string {
  return (row[column] ?? '').trim();
}

function isEmployee(row: HippoCensusRow): boolean {
  return text(row, 'Relationship').toLowerCase() === 'employee';
}

/**
 * The coverage tier, from who else on the census shares the employee's identity.
 *
 * `dependants` must be the ENROLLING dependants only. A waiving dependant does
 * not raise the tier - and waiving dependants must be removed before the
 * transform runs, precisely so this cannot happen.
 *
 * TODO(remap): a domestic partner is folded into the spouse tier here, which is
 * what Anthem's template required. UHC sells a domestic-partner RIDER, so it may
 * carry a distinct tier instead. Confirm against column R's accepted values.
 */
export function coverageTypeFor(dependants: readonly HippoCensusRow[]): CoverageType {
  let spouse = false;
  let child = false;

  for (const dependant of dependants) {
    const relationship = text(dependant, 'Relationship').toLowerCase();
    if (relationship === 'spouse' || relationship === 'domestic partner') spouse = true;
    else if (relationship === 'child') child = true;
    else {
      throw new BusinessException(
        `Census relationship "${text(dependant, 'Relationship')}" is not one this census can place. ` +
          'Deciding which coverage tier it belongs to is a human judgement call.',
        { details: { relationship: text(dependant, 'Relationship') } },
      );
    }
  }

  if (spouse && child) return 'family';
  if (spouse) return 'employee-spouse';
  if (child) return 'employee-children';
  return 'employee-only';
}

/**
 * Groups a flat census into employees and their dependants.
 *
 * `EE SSN` is the family key: the Hippo export has one row per person with no
 * explicit family column, and every member of a family carries the employee's
 * SSN. Falling back to the surname would merge two unrelated Smiths, so the
 * fallback is surname AND forename - which cannot merge families, only split one
 * whose SSN is missing.
 */
export function groupByEmployee(
  rows: readonly HippoCensusRow[],
): Array<{ employee: HippoCensusRow; dependants: HippoCensusRow[] }> {
  const families = new Map<string, { employee?: HippoCensusRow; dependants: HippoCensusRow[] }>();

  for (const row of rows) {
    const key = text(row, 'EE SSN') || `${text(row, 'Last Name')}|${text(row, 'First Name')}`;
    const family = families.get(key) ?? { dependants: [] };
    if (isEmployee(row)) family.employee = row;
    else family.dependants.push(row);
    families.set(key, family);
  }

  const out: Array<{ employee: HippoCensusRow; dependants: HippoCensusRow[] }> = [];
  for (const [key, family] of families) {
    if (family.employee === undefined) {
      throw new BusinessException(
        'The census has dependants with no matching employee row, so their coverage cannot be placed.',
        { details: { familyKey: key, dependantCount: family.dependants.length } },
      );
    }
    out.push({ employee: family.employee, dependants: family.dependants });
  }
  return out;
}

/**
 * Builds every row the SAMx bulk template needs, in upload order.
 *
 * Takes the SPLIT census rather than a flat list, because who is enrolling and
 * who is waiving decides the shape of the output and that split must be made in
 * exactly one place - `HippoCensusReader.splitByEnrollment`.
 *
 * The output carries three kinds of row:
 *  - an enrolling employee, with a coverage tier, followed by their dependants
 *  - a waiving employee, marked waived with the reason in columns S and AA
 *  - nothing at all for a waiving DEPENDANT: the runbook removes them before
 *    transforming, and a waiving dependant on an enrolling employee's family is
 *    simply absent from that employee's tier
 */
export function buildBulkCensusRows(split: SplitCensus): SamxCensusRow[] {
  const waivingEmployees = split.waiving.filter(isEmployee);
  const waivingEmployeeKeys = new Set(
    waivingEmployees.map((row) => text(row, 'EE SSN') || `${text(row, 'Last Name')}|${text(row, 'First Name')}`),
  );

  const out: SamxCensusRow[] = [];

  for (const { employee, dependants } of groupByEmployee(split.enrolling)) {
    /**
     * An enrolling dependant under an employee who is waiving medical is a
     * contradiction in the source data, not a tier this census can express. It
     * is worth stopping on: the alternative is a census that enrolls a spouse
     * against no employee policy, which the portal has no reason to refuse.
     */
    const key = text(employee, 'EE SSN') || `${text(employee, 'Last Name')}|${text(employee, 'First Name')}`;
    if (waivingEmployeeKeys.has(key)) {
      throw new BusinessException(
        `${text(employee, 'First Name')} ${text(employee, 'Last Name')} appears as both enrolling and ` +
          'waiving on the census. Which one is correct is a data question for the OA.',
        { details: { familyKey: key } },
      );
    }

    out.push({
      firstName: text(employee, 'First Name'),
      lastName: text(employee, 'Last Name'),
      relationship: text(employee, 'Relationship'),
      ssn: text(employee, 'EE SSN'),
      coverage: coverageTypeFor(dependants),
      waivesAllProducts: false,
      waiverReason: undefined,
      medicalPlanCode: text(employee, 'Current Medical Policy'),
    });

    for (const dependant of dependants) {
      out.push({
        firstName: text(dependant, 'First Name'),
        lastName: text(dependant, 'Last Name'),
        relationship: text(dependant, 'Relationship'),
        // Column AQ carries the SSN for dependants too, and it is the employee's.
        ssn: text(dependant, 'EE SSN'),
        coverage: undefined,
        waivesAllProducts: false,
        waiverReason: undefined,
        // The plan code lives on the employee's row; a dependant inherits it.
        medicalPlanCode: '',
      });
    }
  }

  for (const employee of waivingEmployees) {
    const reason = text(employee, 'Waiver Reason - Medical');
    if (reason === '') {
      throw new BusinessException(
        `${text(employee, 'First Name')} ${text(employee, 'Last Name')} is on the waiving side of the ` +
          'census with no waiver reason, which is the field that put them there.',
        { details: { lastName: text(employee, 'Last Name') } },
      );
    }

    out.push({
      firstName: text(employee, 'First Name'),
      lastName: text(employee, 'Last Name'),
      relationship: text(employee, 'Relationship'),
      ssn: text(employee, 'EE SSN'),
      coverage: 'waived',
      waivesAllProducts: true,
      waiverReason: reason,
      // A waiving employee has no plan; the runbook leaves column Z blank.
      medicalPlanCode: '',
    });
  }

  return out;
}
