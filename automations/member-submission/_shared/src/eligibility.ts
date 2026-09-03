import { BusinessException } from '@rpa/core';

/**
 * Eligibility rules shared by every member-submission automation.
 *
 * Pure functions, no browser, no I/O - so they are the same rule everywhere and
 * can be reasoned about (and eventually unit-tested) in isolation.
 */

/** Effective dates must be YYYY-MM-DD. Anything else is ambiguous across locales. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Carriers accept coverage changes only from the first of a month.
 *
 * Parsed as UTC deliberately. `new Date('2026-10-01')` is already UTC midnight,
 * but `getDate()` would render it in the machine's local zone - so a run on a
 * server west of UTC would see 30 September and reject a perfectly valid date.
 * That class of bug is invisible on a developer laptop in the same timezone as
 * the server, and appears the day the workload moves.
 */
export function assertFirstOfMonth(effectiveDate: string, memberRef: string): void {
  if (!ISO_DATE.test(effectiveDate)) {
    throw new BusinessException(
      `Effective date "${effectiveDate}" is not in YYYY-MM-DD form`,
      { details: { memberRef } },
    );
  }

  const parsed = new Date(`${effectiveDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BusinessException(`Effective date "${effectiveDate}" is not a real date`, {
      details: { memberRef },
    });
  }

  if (parsed.getUTCDate() !== 1) {
    throw new BusinessException(
      `Effective date ${effectiveDate} is not the first of a month`,
      { details: { memberRef, effectiveDate } },
    );
  }
}

export function assertWithinEnrollmentWindow(
  effectiveDate: string,
  maxMonthsAhead: number,
  memberRef: string,
  now: Date = new Date(),
): void {
  const parsed = new Date(`${effectiveDate}T00:00:00Z`);
  const limit = new Date(now);
  limit.setUTCMonth(limit.getUTCMonth() + maxMonthsAhead);

  if (parsed.getTime() > limit.getTime()) {
    throw new BusinessException(
      `Effective date ${effectiveDate} is more than ${maxMonthsAhead} months ahead`,
      { details: { memberRef, effectiveDate, maxMonthsAhead } },
    );
  }
}

export function assertKnownPlanCode(
  planCode: string,
  knownPlanCodes: ReadonlySet<string>,
  memberRef: string,
): void {
  if (!knownPlanCodes.has(planCode)) {
    throw new BusinessException(`Plan code "${planCode}" is not in the carrier catalog`, {
      details: { memberRef, planCode, catalogSize: knownPlanCodes.size },
    });
  }
}
