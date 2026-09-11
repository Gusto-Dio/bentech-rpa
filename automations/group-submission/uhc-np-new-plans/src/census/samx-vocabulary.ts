import { BusinessException } from '@rpa/core';
import { WAIVER_REASON_TO_UHC } from '@auto/group-submission-shared';
import { requireVocabulary } from '../vocabulary.ts';

/**
 * The literal strings the SAMx bulk census template accepts.
 *
 * ── WHY THESE ARE null ───────────────────────────────────────────────────────
 * The SAMx_PortalBulkCensus template is downloaded from the quoting stage of the
 * portal, and nobody has been signed in to that portal yet - see
 * docs/poc/uhc-np-new-plans/drift-log.md. The runbook names the COLUMNS (R, S,
 * Y, Z, AA, AQ) but not the values those columns accept, and Anthem's equivalent
 * list came from a `Key` sheet inside the real template.
 *
 * So the derivation logic below is complete and tested, and the vocabulary it
 * translates into is recorded as `null` until somebody reads it off the real
 * template. Resolving a `null` throws rather than substituting a plausible
 * guess. A guessed literal is worse than a loud failure, for one reason:
 *
 *   "a wrong waiver reason is a silently incorrect submission, not a visible
 *    error"
 *
 * The same is true of a coverage type. The portal accepts the upload and enrolls
 * the wrong tier, and nothing anywhere reports a problem.
 *
 * TODO(remap): fill these in from the template's own key/dropdown, then record
 * what was found in docs/poc/uhc-np-new-plans/drift-log.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Medical Coverage Type (column R), as a decision rather than a portal string. */
export type CoverageType =
  | 'employee-only'
  | 'employee-spouse'
  | 'employee-children'
  | 'family'
  | 'waived';

/**
 * Column R's accepted values.
 *
 * TODO(remap): whether UHC carries a distinct domestic-partner tier is an open
 * question. `coverageTypeFor` currently folds a domestic partner into the spouse
 * tier, which is what Anthem's template required; UHC sells a domestic-partner
 * RIDER, which suggests it may not. Confirm before filling `employee-spouse` in.
 */
export const SAMX_COVERAGE_TYPE: Readonly<Record<CoverageType, string | null>> = {
  'employee-only': null,
  'employee-spouse': null,
  'employee-children': null,
  family: null,
  waived: null,
};

/** Waive All Products (column Y). */
export const SAMX_YES_NO: Readonly<Record<'yes' | 'no', string | null>> = {
  yes: null,
  no: null,
};

/** Column R, translated for the template. */
export function samxCoverageType(coverage: CoverageType): string {
  return requireVocabulary(SAMX_COVERAGE_TYPE[coverage], 'SAMX_COVERAGE_TYPE', coverage);
}

/** Column Y, translated for the template. */
export function samxYesNo(value: boolean): string {
  const key = value ? 'yes' : 'no';
  return requireVocabulary(SAMX_YES_NO[key], 'SAMX_YES_NO', key);
}

/**
 * Columns S and AA: Hippo's waiver reason in UHC's vocabulary.
 *
 * Only `individual_policy` is documented. An unmapped reason is a
 * BusinessException rather than a System one because it IS about this group's
 * data - a person on this census waived for a reason the mapping does not cover,
 * and a human has to decide what UHC calls it. Unlike the vocabulary above, the
 * automation is not incomplete; the input is unfamiliar.
 */
export function samxWaiverReason(hippoReason: string): string {
  const reason = hippoReason.trim();
  const mapped = WAIVER_REASON_TO_UHC[reason];

  if (mapped === undefined) {
    throw new BusinessException(
      `Hippo waiver reason "${reason}" has no UHC equivalent recorded, so it cannot be written ` +
        'onto the census. The mapping table only covers the reasons read off the portal dropdown ' +
        'so far; a guessed reason is a silently incorrect submission.',
      { details: { reason, known: Object.keys(WAIVER_REASON_TO_UHC) } },
    );
  }

  return mapped;
}
