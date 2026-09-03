import { BusinessException } from '@rpa/core';
import { z } from 'zod';

/**
 * The queue-item payload for every group-submission automation.
 *
 * Derived verbatim from the field list Benefits already produces for a
 * submission (the "Company Info" record). Both Anthem CA and UHC consume the
 * SAME payload - they differ only in which plan codes appear in `policies` and
 * in a couple of carrier-specific answers - which is why this lives in the
 * domain's _shared package rather than being duplicated per automation.
 *
 * PII note: this payload carries a benefits administrator's name and email and
 * the group's banking details. Those are needed - the portals ask for them - but
 * they are exactly why:
 *   - `routingNumber` / `accountNumber` are redacted in logs (see REDACT_PATHS)
 *   - the seed data in this repo is the synthetic "The Company LLC" group only
 *   - in phase 2 the queue must have Orchestrator's AES-256 Specific Data
 *     encryption enabled before real groups flow through it
 */

/** Somebody a portal will correspond with. */
export const contactSchema = z.strictObject({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().min(3),
  title: z.string().min(1),
});
export type Contact = z.infer<typeof contactSchema>;

export const ownerSchema = z.strictObject({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  /** Drives the Anthem "Eligible - Yes/No" answer on the ownership screen. */
  ownerEligible: z.boolean(),
  percentage: z.number().min(0).max(100),
});
export type Owner = z.infer<typeof ownerSchema>;

export const policySchema = z.strictObject({
  /** The plan the employer contribution percentage is calculated against. */
  basePlanCode: z.string().min(1),
  planCode: z.string().min(1),
  planName: z.string().min(1),
  benefitType: z.string().min(1),
  planType: z.string().min(1),
  contributionType: z.string().min(1),
  /** Percentages arrive as strings in the source record; kept as-is rather than silently coerced. */
  eeContribution: z.string().min(1),
  dependentContribution: z.string().min(1),
  fixedCompanyContributionAmount: z.number().nullable(),
  waitingPeriod: z.string().min(1),
  terminationPolicy: z.string().min(1),
  riders: z.array(z.string()),
});
export type Policy = z.infer<typeof policySchema>;

/** `Empty` is a real value in the source record, meaning "not specified". */
export const deductibleResetSchema = z.enum(['plan', 'calendar', 'Empty']);

export const groupSubmissionPayloadSchema = z.strictObject({
  // ── Identity ──
  companyID: z.string().min(1),
  companyName: z.string().min(1),
  /** Employer tax id, 9 digits, no dash. Never logged. */
  fein: z.string().regex(/^\d{9}$/, 'FEIN must be 9 digits with no dash'),
  applicationID: z.string().min(1),
  entityType: z.string().min(1),
  sicCode: z.string().min(1),
  dateEstablished: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  // ── Location and contact ──
  streetAddress1: z.string().min(1),
  streetAddress2: z.string(),
  city: z.string().min(1),
  county: z.string().min(1),
  state: z.string().length(2),
  zip: z.string().min(5),
  companyPhoneNumber: z.string().min(10),

  benefitsAdmin: contactSchema,
  benefitsSignatory: contactSchema,

  // ── Coverage ──
  coverageEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  policies: z.array(policySchema).min(1),
  ratingStructure: z.enum(['age_banded', 'composite']),
  medicalDeductibleReset: deductibleResetSchema,

  // ── Counts. These drive the eligibility screens on both portals. ──
  eligibleEEs: z.number().int().nonnegative(),
  /** Prior calendar year Average Total Number of Employees. */
  anteCount: z.number().int().nonnegative(),
  fteCount: z.number().int().nonnegative(),
  partTimeEECount: z.number().int().nonnegative(),
  partTimeEligibleEECount: z.number().int().nonnegative(),
  partTimeCovered: z.boolean(),
  nonCoveredEEs: z.array(z.string()),

  // ── Answers the portals ask for ──
  owners: z.array(ownerSchema).min(1),
  continuation: z.enum(['state', 'cobra']),
  waivedWP: z.boolean(),
  workersComp: z.boolean(),
  workersCompCarrier: z.string(),
  workersCompPolicyNumber: z.string(),

  // ── Banking, for the EFT / direct-debit screens. Redacted in logs. ──
  bankName: z.string().min(1),
  routingNumber: z.string().regex(/^\d{9}$/, 'routing number must be 9 digits'),
  accountNumber: z.string().min(4),

  // ── Where the supporting documents live ──
  s3Link: z.string().min(1),
  /** Hippo OE census, relative to the automation folder. Input to the census transform. */
  censusFile: z.string().min(1),

  // ── Correlation, for the Orchestrator phase ──
  carrierOrderID: z.string().min(1),
  carrierOrderSubmissionRequestUUID: z.string().min(1),
  stateCarrierID: z.number().int(),

  /** Seed files annotate themselves; ignored at runtime. */
  $comment: z.string().optional(),
});

export type GroupSubmissionPayload = z.infer<typeof groupSubmissionPayloadSchema>;

/**
 * A malformed payload is a BusinessException: bad data fails identically on
 * every retry, so there is nothing to gain from relaunching a browser for it.
 */
export function parseGroupSubmissionPayload(raw: unknown): GroupSubmissionPayload {
  const result = groupSubmissionPayloadSchema.safeParse(raw);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');

  throw new BusinessException(`Group submission payload is not valid: ${detail}`);
}

/** Ownership must total 100% on both portals. Checked early, before a browser is launched. */
export function assertOwnershipTotals100(owners: readonly Owner[]): void {
  const total = owners.reduce((sum, owner) => sum + owner.percentage, 0);
  // Percentages come from a JSON record and can carry float noise.
  if (Math.abs(total - 100) > 0.01) {
    throw new BusinessException(
      `Ownership totals ${total}%, but both carriers require exactly 100%`,
      { details: { total, ownerCount: owners.length } },
    );
  }
}

/** The plan whose contribution percentage the employer contribution is based on. */
export function findBasePolicy(policies: readonly Policy[]): Policy {
  const base = policies.find((policy) => policy.planCode === policy.basePlanCode);
  if (base === undefined) {
    throw new BusinessException(
      'No policy in the payload is its own base plan, so there is no contribution base to enter',
      { details: { planCodes: policies.map((p) => p.planCode) } },
    );
  }
  return base;
}
