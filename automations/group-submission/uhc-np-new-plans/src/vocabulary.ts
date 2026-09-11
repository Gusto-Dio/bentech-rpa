import { SystemException } from '@rpa/core';

/**
 * Resolving a portal literal that has never been read off the portal.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
 * Large parts of SAMx's vocabulary are unknown: the census template's accepted
 * values, the waiting-period dropdown, the organisation-type list. The runbook
 * records what to PUT in each field, in Hippo's words, and not what UHC calls
 * it. Nobody has signed in to check - see docs/poc/uhc-np-new-plans/drift-log.md.
 *
 * The tempting move is a plausible-looking guess, and it is the worst available
 * option. The reason was first written down for the waiver-reason table, and it
 * generalises to all of them:
 *
 *   "a wrong waiver reason is a silently incorrect submission, not a visible
 *    error"
 *
 * A guessed dropdown value either fails loudly (fine, but no better than this)
 * or matches a real option that means something else - and then the portal
 * accepts a submission that is quietly wrong. So every unknown literal is
 * recorded as `null` and resolving one throws.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A never-recorded value is a SystemException, not a Business one. The
 * distinction matters for how the run reports itself: no group's data would
 * change the outcome, so it is not a rejection of this group, and reporting it
 * as a business failure would file the group as "carrier said no" when nothing
 * was ever submitted. `SecretResolver.require` classifies a missing env var the
 * same way, for the same reason.
 */
export function requireVocabulary(value: string | null, constant: string, key: string): string {
  if (value === null) {
    throw new SystemException(
      `${constant}.${key} has not been recorded yet, so this screen cannot be filled in. ` +
        'Read the option off the real portal during the re-map and fill it in - guessing one ' +
        'produces a submission that is accepted and quietly wrong.',
      { details: { constant, key } },
    );
  }
  return value;
}

/** Which keys of a vocabulary table are still unrecorded. Used by the readiness report. */
export function unrecordedKeys(table: Readonly<Record<string, string | null>>): string[] {
  return Object.entries(table)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
}
