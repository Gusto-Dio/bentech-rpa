import { BusinessException } from '@rpa/core';
import type { HippoCensusRow } from '@auto/group-submission-shared';
import type { Payload } from './payload.ts';

/**
 * The numbers the employer application asks for that are NOT simply copied from
 * the payload.
 *
 * They live here, as pure functions, because the eligibility screen (stage 7.4)
 * is where a quiet arithmetic mistake does the most damage: the counts go onto a
 * signed application, nothing on the portal cross-checks them, and the error
 * surfaces weeks later as a carrier pending item. Pure functions mean they can
 * be tested without a browser, which is the only way to be confident in them.
 */

/**
 * Part-time = total employees minus eligible full-time.
 *
 * The runbook states the subtraction explicitly ("Subtract number of FT
 * employees from total number of employees"), AND the payload carries a
 * `partTimeEECount`. Two sources for one number is a trap, so this computes it
 * and treats disagreement as a data problem rather than silently preferring one.
 */
export function partTimeCount(payload: Payload): number {
  const derived = payload.anteCount - payload.fteCount;

  if (derived < 0) {
    throw new BusinessException(
      `Eligible full-time employees (${payload.fteCount}) exceeds total employees ` +
        `(${payload.anteCount}). One of the two counts is wrong upstream.`,
      { details: { anteCount: payload.anteCount, fteCount: payload.fteCount } },
    );
  }

  if (derived !== payload.partTimeEECount) {
    throw new BusinessException(
      `Part-time count does not add up: total ${payload.anteCount} minus full-time ` +
        `${payload.fteCount} is ${derived}, but the payload says ${payload.partTimeEECount}. ` +
        'Reconciling these is a data question for the OA, not something to guess at on a signed application.',
      {
        details: {
          anteCount: payload.anteCount,
          fteCount: payload.fteCount,
          derived,
          payloadPartTimeEECount: payload.partTimeEECount,
        },
      },
    );
  }

  return derived;
}

/**
 * "Number of Eligible Declining Employees" - waiving EMPLOYEES, not waiving
 * people.
 *
 * Counted from the census rather than the payload, because the payload has no
 * field for it and because the census is where the waiver reasons actually live.
 * Dependents are excluded: a waiving spouse is not a declining employee, and
 * counting them inflates the figure on the application.
 */
export function eligibleDecliningCount(waiving: readonly HippoCensusRow[]): number {
  return waiving.filter((row) => (row['Relationship'] ?? '').trim().toLowerCase() === 'employee').length;
}

/**
 * Cal-COBRA for 2-19 eligible employees, COBRA for 20 or more.
 *
 * `payload.continuation` says which the group elected; this derives which one
 * the group actually qualifies for. They should agree, and when they do not it
 * is worth stopping: picking the wrong continuation on a group application is a
 * compliance error, not a formatting one.
 */
export type Continuation = 'cal-cobra' | 'cobra';

export function continuationFor(eligibleEmployees: number): Continuation {
  return eligibleEmployees >= 20 ? 'cobra' : 'cal-cobra';
}

export function assertContinuationMatches(payload: Payload): Continuation {
  const derived = continuationFor(payload.fteCount);
  const declared: Continuation = payload.continuation === 'cobra' ? 'cobra' : 'cal-cobra';

  if (derived !== declared) {
    throw new BusinessException(
      `The group declared ${declared} but ${payload.fteCount} eligible employees qualifies for ${derived}. ` +
        '(Cal-COBRA is 2-19 eligible employees, COBRA is 20 or more.)',
      { details: { declared, derived, fteCount: payload.fteCount } },
    );
  }
  return derived;
}
