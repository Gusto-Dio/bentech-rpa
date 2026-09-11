import { BusinessException } from '@rpa/core';
import type { Payload } from '../payload.ts';
import { requireVocabulary } from '../vocabulary.ts';
import type { Continuation, PrimaryOption } from '../derived.ts';

/**
 * The literal option text the SAMx employer-application screens offer.
 *
 * Pure mappers and constants, exported at module level rather than living as
 * page-object methods, so every one of them can be tested without a browser.
 * The screens they belong to sit behind a production sign-in that has never
 * succeeded, so unit tests are the only coverage available.
 *
 * Anything recorded as `null` throws when resolved - see ../vocabulary.ts for
 * why a guess is worse than a stop.
 */

/**
 * How long a single field is given to appear.
 *
 * Kept comfortably under `step()`'s 60s default because step() caps EVERY gate
 * at the step's own budget: a 90s field timeout inside a step with no explicit
 * `timeoutMs` silently becomes 60s, which reads as a mystery in the log.
 */
export const FIELD_TIMEOUT_MS = 20_000;

/** How long a whole screen is given to render after a Continue. */
export const SCREEN_TIMEOUT_MS = 45_000;

/**
 * Generating a proposal PDF is server-side work, so it gets its own budget and
 * its step must pass `timeoutMs` to match, per the gate-capping rule above.
 */
export const DOCUMENT_TIMEOUT_MS = 300_000;

/**
 * The `timeoutMs` a step must declare when one of its gates waits a whole
 * screen out.
 *
 * step() caps every gate at the step's own budget, and that budget defaults to
 * 60s - so a step whose postcondition asks for SCREEN_TIMEOUT_MS (45s) plus an
 * action that itself takes time can exceed the default and be truncated. Naming
 * it here keeps the two numbers from drifting apart in opposite directions.
 */
export const SCREEN_STEP_TIMEOUT_MS = 120_000;

/**
 * `2026-09-01` -> `09/01/2026`.
 *
 * Kept as a STRING all the way through rather than handed to the portal as a
 * Date. Anthem's census port records what happens otherwise: an ISO string read
 * as UTC midnight and rendered in a US timezone shifted every date back one day,
 * which re-aged members and mis-rated the group with nothing looking like an
 * error.
 *
 * TODO(remap): US format is the overwhelming likelihood on a US carrier portal,
 * but it is still unverified. Read a pre-filled date field during the re-map.
 */
export function samxDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (match === null) {
    throw new BusinessException(
      `Date "${isoDate}" is not an ISO date, so it cannot be entered without guessing what it means.`,
      { details: { value: isoDate } },
    );
  }
  const [, year, month, day] = match;
  return `${month}/${day}/${year}`;
}

/** Stage 3.3 answers the runbook states outright, so they are constants, not payload data. */
export const PRIMARY_CONTACT_PHONE_TYPE = 'Business';
export const PRIMARY_CONTACT_ROLE = 'Benefit Administrator';
export const PRIMARY_CONTACT_PREFERENCE = 'Email';

/** Stage 3.4 and 6.5: fixed answers from the runbook. */
export const CANNABIS_INDUSTRY = 'No';
export const CURRENT_MEDICAL_COVERAGE = 'NONE';

/**
 * Stage 6.1: organisation type, from `payload.entityType`.
 *
 * Hippo's entity types are lowercase slugs (`llc`, `s_corp`); SAMx offers a
 * picklist of legal forms. The two vocabularies are not the same and the mapping
 * has to be read off the portal.
 *
 * TODO(remap): fill in from the Organization Type picklist. Add any Hippo entity
 * type the payload can carry that is missing here.
 */
export const SAMX_ORGANIZATION_TYPE: Readonly<Record<string, string | null>> = {
  llc: null,
  c_corp: null,
  s_corp: null,
  partnership: null,
  sole_proprietorship: null,
  non_profit: null,
};

export function organizationType(entityType: string): string {
  const key = entityType.trim().toLowerCase();
  if (!(key in SAMX_ORGANIZATION_TYPE)) {
    throw new BusinessException(
      `Entity type "${entityType}" is not one this automation knows how to answer the SAMx ` +
        'Organization Type question with. Which legal form it corresponds to is a human judgement call.',
      { details: { entityType, known: Object.keys(SAMX_ORGANIZATION_TYPE) } },
    );
  }
  return requireVocabulary(SAMX_ORGANIZATION_TYPE[key] ?? null, 'SAMX_ORGANIZATION_TYPE', key);
}

/**
 * Stage 6.1: the medical benefit plan option, from `payload.medicalDeductibleReset`.
 *
 * `Empty` is a real value in the source record meaning "not specified". The
 * runbook says a 1/1 group defaults to the plan year, which is a rule that only
 * makes sense once the portal's own options are known.
 *
 * TODO(remap): fill in, and record whether `Empty` needs the 1/1 default applied
 * or whether the portal pre-selects it.
 */
export const SAMX_DEDUCTIBLE_RESET: Readonly<Record<Payload['medicalDeductibleReset'], string | null>> = {
  plan: null,
  calendar: null,
  Empty: null,
};

export function deductibleResetOption(reset: Payload['medicalDeductibleReset']): string {
  return requireVocabulary(SAMX_DEDUCTIBLE_RESET[reset], 'SAMX_DEDUCTIBLE_RESET', reset);
}

/**
 * Stage 6.2: which continuation regime applies.
 *
 * The DECISION is computed and tested in derived.ts; this is only what SAMx
 * calls each answer. Keeping the two apart is what let the threshold be tested
 * before the portal was ever reachable.
 *
 * TODO(remap): fill in from the continuation question's options.
 */
export const SAMX_CONTINUATION: Readonly<Record<Continuation, string | null>> = {
  state: null,
  cobra: null,
};

export function continuationOption(continuation: Continuation): string {
  return requireVocabulary(SAMX_CONTINUATION[continuation], 'SAMX_CONTINUATION', continuation);
}

/** Stage 6.2: which plan is primary against Medicare. TODO(remap): fill in. */
export const SAMX_PRIMARY_OPTION: Readonly<Record<PrimaryOption, string | null>> = {
  medicare: null,
  'plan-primary': null,
};

export function primaryOption(primary: PrimaryOption): string {
  return requireVocabulary(SAMX_PRIMARY_OPTION[primary], 'SAMX_PRIMARY_OPTION', primary);
}

/**
 * Stage 6.3: the waiting period.
 *
 * ── THE ONE MAPPING THE RUNBOOK ADMITS IT DOES NOT HAVE ─────────────────────
 * Hippo's vocabulary and UHC's do not correspond one-to-one. Hippo says things
 * like "1st of month after 30 days"; SAMx offers Date of Event, First of the
 * Following Month, First of the Following Month after Specified Duration, Date
 * of Hire and Specified Duration - which means one Hippo value can require TWO
 * SAMx answers (an option plus a duration), and all five Hippo rows are still
 * "(to be discovered)".
 *
 * So this is not a table with missing entries; it is a mapping whose SHAPE is
 * unknown. It is modelled as option-plus-duration because that is the only shape
 * that can express the portal's list, and every entry is unrecorded.
 *
 * TODO(remap): read the dropdown, work out which Hippo values need a duration,
 * and record the result in docs/poc/uhc-np-new-plans/drift-log.md as well as here.
 * ────────────────────────────────────────────────────────────────────────────
 */
export interface WaitingPeriodAnswer {
  readonly option: string;
  /** Days, when the chosen option asks for a duration as well. */
  readonly durationDays: number | undefined;
}

export const SAMX_WAITING_PERIOD: Readonly<Record<string, WaitingPeriodAnswer | null>> = {
  'no waiting period': null,
  '1st of month after hire': null,
  '1st of month after 30 days': null,
  '1st of month after 60 days': null,
  '1st of month after 90 days': null,
};

export function waitingPeriodAnswer(hippoWaitingPeriod: string): WaitingPeriodAnswer {
  const key = hippoWaitingPeriod.trim().toLowerCase();

  if (!(key in SAMX_WAITING_PERIOD)) {
    throw new BusinessException(
      `Waiting period "${hippoWaitingPeriod}" is not one of the values Hippo is known to produce, ` +
        'so which SAMx option it corresponds to is a human judgement call.',
      { details: { waitingPeriod: hippoWaitingPeriod, known: Object.keys(SAMX_WAITING_PERIOD) } },
    );
  }

  const answer = SAMX_WAITING_PERIOD[key] ?? null;
  if (answer === null) {
    // Deliberately routed through requireVocabulary so the message, the
    // classification and the "fill this in" instruction are identical to every
    // other unrecorded option.
    requireVocabulary(null, 'SAMX_WAITING_PERIOD', key);
  }
  return answer as WaitingPeriodAnswer;
}
