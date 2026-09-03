import { BusinessException } from '@rpa/core';
import type { HippoCensusRow } from '@auto/group-submission-shared';

/**
 * Fills Anthem's census template from the Hippo OE census.
 *
 * ── WHERE THE LAYOUT CAME FROM ───────────────────────────────────────────────
 * The real template, downloaded from the `Employee Census` wizard step on
 * 2026-09-03 and kept at `data/input/anthem-census-template.xlsx`. It has three
 * sheets - `Employer Census` (the one to fill), `Example Census`, and `Key`,
 * which enumerates the accepted values. The template is the AUTHORITY.
 *
 * This deliberately supersedes the `Anthem_NewPlans` macro. Recovering that
 * macro's source was useful - it explains the INTENT of each column - but its
 * output is a five-column "Quoting" tab and the template asks for ten. Two of
 * the macro's behaviours are outright wrong against this template:
 *
 *   - its `"Partner"` -> `"Spouse"` substring replacement turns Hippo's
 *     "Domestic Partner" into "Domestic Spouse", which is NOT one of the three
 *     values the Key sheet allows. The correct target is plain `Spouse`.
 *   - it emits nothing for ZIP Code, Cobra or the coverage-tier columns.
 *
 * See docs/poc/anthem-ca-new-plans/field-map.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Sheet to fill. `Example Census` and `Key` are reference, and are left alone. */
export const CENSUS_SHEET = 'Employer Census';

/** Header row of `Employer Census`, verbatim and in order. */
export const ANTHEM_CENSUS_HEADERS = [
  'First Name',
  'Last Name',
  'Gender',
  'Relationship',
  'Date of Birth',
  'ZIP Code',
  'Cobra',
  'Medical',
  'Dental',
  'Vision',
] as const;

/** From the template's `Key` sheet. These are the only values it accepts. */
export const ACCEPTED_RELATIONSHIPS = ['Employee', 'Spouse', 'Child'] as const;
export const ACCEPTED_GENDERS = ['Male', 'Female'] as const;
export const ACCEPTED_TIERS = [
  'Employee',
  'Employee + Spouse',
  'Employee + Child(ren)',
  'Family',
  'Waived',
] as const;

export type AnthemRelationship = (typeof ACCEPTED_RELATIONSHIPS)[number];
export type AnthemTier = (typeof ACCEPTED_TIERS)[number];

export interface AnthemCensusRow {
  firstName: string;
  lastName: string;
  gender: string;
  relationship: AnthemRelationship;
  dateOfBirth: string;
  zipCode: string;
  cobra: string;
  medical: string;
  /** ACA Medical Only: the runbook leaves specialty columns blank. */
  dental: string;
  vision: string;
}

/**
 * `1990-11-15` -> `Nov 15, 1990`, the format the template itself declares.
 *
 * This is not cosmetic. Writing the ISO string straight into the workbook let
 * Excel and the portal read it as a DATE at UTC midnight and then render it in a
 * US timezone, which shifted every date of birth back one day - the live upload
 * showed Jane Doe as `Nov 14, 1990`. An off-by-one DOB re-ages the member and
 * the carrier rates the group wrongly, and nothing about it looks like an error.
 *
 * Emitting the portal's own display format as a plain string - the census screen
 * states it verbatim as "Format: Dec 31, 2024" - keeps it a string all the way
 * through and removes the timezone from the problem entirely.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function anthemDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (match === null) {
    throw new BusinessException(
      `Census date "${isoDate}" is not an ISO date, so it cannot be written in Anthem's ` +
        '"Dec 31, 2024" format without guessing what it means.',
      { details: { value: isoDate } },
    );
  }
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/**
 * Hippo relationship -> the template's three values.
 *
 * `Domestic Partner` maps to `Spouse` because that is the only value the Key
 * sheet offers for a partner. This is the point the macro got wrong, and it is
 * the kind of error that produces a silently incorrect submission rather than a
 * visible one - the portal accepts the file and enrolls the wrong tier.
 */
export function anthemRelationship(relationship: string): AnthemRelationship {
  const value = relationship.trim().toLowerCase();
  if (value === 'employee') return 'Employee';
  if (value === 'spouse' || value === 'domestic partner') return 'Spouse';
  if (value === 'child') return 'Child';

  throw new BusinessException(
    `Census relationship "${relationship}" is not one of Anthem's accepted values ` +
      `(${ACCEPTED_RELATIONSHIPS.join(', ')}). Deciding what it should be is a human judgement call.`,
    { details: { relationship, accepted: [...ACCEPTED_RELATIONSHIPS] } },
  );
}

/**
 * The template's Key sheet offers Male and Female only.
 *
 * Anything else is a Business failure rather than something to coerce: guessing
 * a gender onto a carrier submission is not a call an automation should make,
 * and no retry changes the census.
 */
export function anthemGender(gender: string): string {
  const value = gender.trim().toLowerCase();
  if (value === 'male' || value === 'm') return 'Male';
  if (value === 'female' || value === 'f') return 'Female';

  throw new BusinessException(
    `Census gender "${gender}" is not one of Anthem's accepted values (${ACCEPTED_GENDERS.join(', ')}). ` +
      'The template offers no other option, so this needs a human decision.',
    { details: { gender, accepted: [...ACCEPTED_GENDERS] } },
  );
}

/**
 * The coverage tier, from who else on the census shares the employee's identity.
 *
 * Only the EMPLOYEE row carries a tier; dependants leave it blank, which is what
 * the template's own Example Census shows.
 */
export function coverageTier(dependants: readonly HippoCensusRow[]): AnthemTier {
  const kinds = new Set(dependants.map((d) => anthemRelationship(d['Relationship'] ?? '')));
  const spouse = kinds.has('Spouse');
  const child = kinds.has('Child');

  if (spouse && child) return 'Family';
  if (spouse) return 'Employee + Spouse';
  if (child) return 'Employee + Child(ren)';
  return 'Employee';
}

/**
 * Groups a flat census into employees and their dependants.
 *
 * The Hippo export has one row per person with no explicit family key, so
 * `EE SSN` is the link - every member of a family carries the employee's SSN.
 * Falling back to the last name would merge two unrelated Smiths.
 */
export function groupByEmployee(
  rows: readonly HippoCensusRow[],
): Array<{ employee: HippoCensusRow; dependants: HippoCensusRow[] }> {
  const families = new Map<string, { employee?: HippoCensusRow; dependants: HippoCensusRow[] }>();

  for (const row of rows) {
    const key = (row['EE SSN'] ?? '').trim() || `${row['Last Name'] ?? ''}|${row['First Name'] ?? ''}`;
    const family = families.get(key) ?? { dependants: [] };
    if (anthemRelationship(row['Relationship'] ?? '') === 'Employee') family.employee = row;
    else family.dependants.push(row);
    families.set(key, family);
  }

  const out: Array<{ employee: HippoCensusRow; dependants: HippoCensusRow[] }> = [];
  for (const [key, family] of families) {
    if (family.employee === undefined) {
      throw new BusinessException(
        'The census has dependants with no matching employee row, so their coverage tier cannot be determined.',
        { details: { familyKey: key, dependantCount: family.dependants.length } },
      );
    }
    out.push({ employee: family.employee, dependants: family.dependants });
  }
  return out;
}

/**
 * Builds the rows to write into `Employer Census`.
 *
 * `rows` must ALREADY be the enrolling subset - waiving people never go on this
 * template. The split is the caller's, via
 * `HippoCensusReader.splitByEnrollment`, so that exactly one place decides who
 * is enrolling.
 *
 * Employee first, then that employee's dependants, matching the template's
 * Example Census.
 */
export function buildAnthemCensusRows(rows: readonly HippoCensusRow[]): AnthemCensusRow[] {
  const out: AnthemCensusRow[] = [];

  for (const { employee, dependants } of groupByEmployee(rows)) {
    const zip = (employee['Zip'] ?? '').trim();

    out.push({
      firstName: (employee['First Name'] ?? '').trim(),
      lastName: (employee['Last Name'] ?? '').trim(),
      gender: anthemGender(employee['Gender'] ?? ''),
      relationship: 'Employee',
      dateOfBirth: anthemDate(employee['DOB'] ?? ''),
      zipCode: zip,
      // New-plan groups are not COBRA continuants; the runbook never sets it.
      cobra: 'No',
      medical: coverageTier(dependants),
      dental: '',
      vision: '',
    });

    for (const dependant of dependants) {
      out.push({
        firstName: (dependant['First Name'] ?? '').trim(),
        lastName: (dependant['Last Name'] ?? '').trim(),
        gender: anthemGender(dependant['Gender'] ?? ''),
        relationship: anthemRelationship(dependant['Relationship'] ?? ''),
        dateOfBirth: anthemDate(dependant['DOB'] ?? ''),
        // Dependants share the employee's ZIP, and carry no tier of their own.
        zipCode: zip,
        cobra: '',
        medical: '',
        dental: '',
        vision: '',
      });
    }
  }

  return out;
}

/** The same rows as a positional matrix, in `ANTHEM_CENSUS_HEADERS` order. */
export function toCellMatrix(rows: readonly AnthemCensusRow[]): string[][] {
  return rows.map((row) => [
    row.firstName,
    row.lastName,
    row.gender,
    row.relationship,
    row.dateOfBirth,
    row.zipCode,
    row.cobra,
    row.medical,
    row.dental,
    row.vision,
  ]);
}
