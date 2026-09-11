import { BusinessException } from '@rpa/core';
import type { HippoCensusRow, Policy } from '@auto/group-submission-shared';
import type { Payload } from './payload.ts';

/**
 * The answers the UHC employer application asks for that are COMPUTED, not
 * copied from the payload.
 *
 * They live here as pure functions for the same reason Anthem's derived.ts does:
 * the eligibility and contribution screens are where a quiet arithmetic mistake
 * does the most damage. The numbers go onto an application that is attested to,
 * nothing on the portal cross-checks them, and the error surfaces weeks later as
 * a carrier pending item. Pure functions can be tested without a browser, which
 * is the only practical way to be confident in them - the screens themselves are
 * expensive to reach and sit on a production portal.
 *
 * ⚠ UHC's thresholds are NOT Anthem's. Anthem keys Cal-COBRA on 2-19 ELIGIBLE
 * employees; UHC keys state continuation on FTE count, and the Medicare question
 * on eligible employees. The two automations must not share these functions.
 */

/** Which continuation regime the group falls under. `payload.continuation` names the same fact. */
export type Continuation = 'state' | 'cobra';

/**
 * State continuation below 20 FTE, federal COBRA at 20 or more.
 *
 * Keyed on FTE deliberately: runbook stage 6.2 asks "which continuation
 * applies" against the full-time equivalent count, not the eligible-employee
 * count that drives the Medicare question two rows below it. Inverting these two
 * is the single easiest mistake to make on that screen, which is why they are
 * separate named functions rather than one helper with a flag.
 */
export function continuationFor(fteCount: number): Continuation {
  return fteCount >= 20 ? 'cobra' : 'state';
}

/**
 * Reconciles the derived continuation against the one the payload declares.
 *
 * Two sources for one fact is a trap. `payload.continuation` records what the
 * group elected upstream; `continuationFor` derives what its headcount actually
 * qualifies for. When they disagree, one of them is wrong and picking either is
 * a compliance error rather than a formatting one - so this stops instead.
 */
export function assertContinuationMatches(payload: Payload): Continuation {
  const derived = continuationFor(payload.fteCount);

  if (derived !== payload.continuation) {
    throw new BusinessException(
      `The group declared ${payload.continuation} continuation but ${payload.fteCount} FTE ` +
        `qualifies for ${derived}. (State continuation is under 20 FTE, COBRA is 20 or more.) ` +
        'Reconciling this is a data question for the OA, not something to guess at on an application.',
      { details: { declared: payload.continuation, derived, fteCount: payload.fteCount } },
    );
  }

  return derived;
}

/** Which plan is primary against Medicare, on stage 6.2. */
export type PrimaryOption = 'medicare' | 'plan-primary';

/**
 * Medicare primary below 20 eligible employees, the plan primary at 20 or more.
 *
 * Keyed on ELIGIBLE employees, not FTE - see the warning on continuationFor.
 */
export function primaryOptionFor(eligibleEEs: number): PrimaryOption {
  return eligibleEEs >= 20 ? 'plan-primary' : 'medicare';
}

/**
 * "Total employees applying" - active plus COBRA, counted from the census.
 *
 * Employees only. A spouse enrolling is not an employee applying, and counting
 * dependants here inflates the figure the portal rates against. `rows` must
 * already be the ENROLLING subset, via `HippoCensusReader.splitByEnrollment`, so
 * that exactly one place decides who is enrolling.
 */
export function totalApplying(rows: readonly HippoCensusRow[]): number {
  return rows.filter((row) => (row['Relationship'] ?? '').trim().toLowerCase() === 'employee').length;
}

/**
 * Whole years between the date the company was established and `asOf`.
 *
 * Stage 6.1 asks for "years in business" as an integer. Computed rather than
 * carried in the payload because the answer changes with the calendar, so a
 * stored value would go stale between the quote and the application.
 */
export function yearsInBusiness(dateEstablished: string, asOf: Date): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateEstablished.trim());
  if (match === null) {
    throw new BusinessException(
      `dateEstablished "${dateEstablished}" is not an ISO date, so years in business cannot be computed.`,
      { details: { dateEstablished } },
    );
  }

  const [, year, month, day] = match;
  const established = { year: Number(year), month: Number(month), day: Number(day) };

  let years = asOf.getUTCFullYear() - established.year;
  const monthNow = asOf.getUTCMonth() + 1;
  const dayNow = asOf.getUTCDate();

  // The anniversary has not come round yet this year.
  if (monthNow < established.month || (monthNow === established.month && dayNow < established.day)) {
    years -= 1;
  }

  if (years < 0) {
    throw new BusinessException(
      `dateEstablished "${dateEstablished}" is in the future, so years in business is negative.`,
      { details: { dateEstablished, asOf: asOf.toISOString() } },
    );
  }

  return years;
}

/**
 * Which of the runbook's contribution rules produced the percentage typed in.
 *
 * Returned alongside the number so the caller can LOG the branch. The runbook's
 * two overrides both replace a correct-looking number with a different one, and
 * a log line that records only the result makes them impossible to audit after
 * the fact.
 */
export type ContributionRule = 'flat-dollar-as-50' | 'ca-full-contribution-as-99' | 'as-quoted';

export interface EmployerContribution {
  readonly percentage: number;
  readonly rule: ContributionRule;
  /** Present when the runbook requires the deviation called out in the completion notes. */
  readonly note?: string;
}

/**
 * A flat-dollar contribution carries an amount instead of a percentage.
 *
 * Both signals are checked because they can disagree: `contributionType` is free
 * text from the source record, while `fixedCompanyContributionAmount` is the
 * amount itself. Either one being present means the group is not on a
 * percentage, and treating a flat-dollar group as a percentage group would enter
 * a dollar figure into a percentage field.
 */
export function isFlatDollar(policy: Policy): boolean {
  return (
    policy.fixedCompanyContributionAmount !== null ||
    /fixed|flat|dollar|amount/i.test(policy.contributionType)
  );
}

/**
 * `"75.0"` -> `75`. The source record carries percentages as strings.
 *
 * The emptiness check is not redundant: `Number('')` and `Number('   ')` are
 * both `0`, which is a finite number in range, so without it a blank
 * contribution would be typed onto the application as a real 0% employer
 * contribution. The payload schema's `min(1)` stops the empty string but not a
 * whitespace-only one.
 */
export function contributionPercentage(value: string, field: string): number {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new BusinessException(
      `Policy ${field} is blank, so there is no employer contribution percentage to enter.`,
      { details: { field, value } },
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new BusinessException(
      `Policy ${field} "${value}" is not a percentage between 0 and 100, so it cannot be entered.`,
      { details: { field, value } },
    );
  }
  return parsed;
}

/**
 * The employer contribution percentage to type on stage 5, and why.
 *
 * Two overrides from the runbook, both of which deliberately enter something
 * other than the quoted figure:
 *
 *  - A **flat-dollar** contribution is entered as 50%. SAMx has no flat-dollar
 *    field at this stage, and 50 is the placeholder the runbook specifies.
 *  - A **California** group contributing 100% where **not everyone is enrolling**
 *    is entered as 99%, and called out in the completion notes. At 100% the
 *    portal treats the group as mandatory-participation and rejects the waivers.
 *
 * Flat-dollar is checked first: it has no percentage at all, so the 100%
 * comparison the California rule depends on is not meaningful for it.
 */
export function employerContribution(
  payload: Payload,
  policy: Policy,
  enrollingEmployees: number,
): EmployerContribution {
  if (isFlatDollar(policy)) {
    return {
      percentage: 50,
      rule: 'flat-dollar-as-50',
      note:
        `${payload.companyName} contributes a flat dollar amount, which SAMx cannot express at ` +
        'this stage. Entered as 50% per the runbook; the real contribution is on the group record.',
    };
  }

  const quoted = contributionPercentage(policy.eeContribution, 'eeContribution');
  const everyoneEnrolling = enrollingEmployees >= payload.eligibleEEs;

  if (payload.state === 'CA' && quoted === 100 && !everyoneEnrolling) {
    return {
      percentage: 99,
      rule: 'ca-full-contribution-as-99',
      note:
        `California group at 100% employer contribution with ${enrollingEmployees} of ` +
        `${payload.eligibleEEs} eligible employees enrolling. Entered as 99% per the runbook, ` +
        'because 100% makes participation mandatory and the waivers would be rejected.',
    };
  }

  return { percentage: quoted, rule: 'as-quoted' };
}
