import type { Page } from 'playwright';

/**
 * Reads Anthem's OWN validation message, if one is showing.
 *
 * The highest-value locator in the automation: it is what separates a Business
 * failure from a System one on every screen. Returning the portal's wording
 * rather than ours is deliberate - an operator triaging a failed group wants to
 * see what the carrier said, not our paraphrase of it.
 *
 * It lives in its own module rather than on a page object because every stage
 * needs it, and importing it from quote-start.page.ts would make stage 7 depend
 * on stage 2 for no reason.
 *
 * TODO(remap): the container is still inferred. The portal has not yet been made
 * to produce a validation error under observation, so this matches the three
 * shapes it plausibly uses. Narrow it the first time a real message is seen, and
 * record the wording in drift-log.md.
 */

/**
 * Not every role=alert is a problem.
 *
 * This portal renders informational banners in the same region - the dashboard
 * carries "We've redesigned your dashboard!" - and treating one as a validation
 * failure would turn a healthy screen into a BusinessException that no retry can
 * clear. So an alert only counts when it reads like a complaint.
 */
/**
 * ── THE SIC MESSAGE WAS NEVER MATCHED ────────────────────────────────────────
 * Anthem's own wording is *"That SIC code isn't valid. Please double check it
 * and try again."* The original list required a literal `not valid` and
 * `please enter|select|correct|provide`, so **none** of its alternatives fired
 * on that sentence - the one portal rejection this PoC had actually captured
 * and written into the drift log. It would have surfaced as a SystemException
 * and been retried three times against a rule that will never change its mind.
 *
 * Hence the contracted negations and the wider `please …` verbs below. Erring
 * broad is the right trade here: a missed complaint costs three browser
 * relaunches on a flow that creates real quotes, while a false positive is now
 * held back by NOT_A_COMPLAINT and by the success/info theme check.
 * ────────────────────────────────────────────────────────────────────────────
 */
const PROBLEM_WORDING =
  /\b(required|invalid|must|cannot|can't|unable|isn't|aren't|doesn't|don't|didn't|won't|not\s+(?:a|an|valid|found|eligible)|missing|error|exceeds|too\s+(?:long|short|many)|please\s+(?:enter|select|correct|provide|double\s*check|check|review|try|fix))\b/i;

/**
 * Wording that is the portal CONGRATULATING us, checked before the above.
 *
 * ── THIS COST A SIGNED APPLICATION ──────────────────────────────────────────
 * Anthem's post-signature toast reads, in one element:
 *
 *   "SuccessYou have successfully signed the document. Please select Continue
 *    to move to the next step."
 *
 * It is an SLDS **success** toast, and it carries `role="alert"` like every
 * other toast - so `PROBLEM_WORDING` matched it on `please select` and
 * `step()`'s businessCheck turned the confirmation of a successful signature
 * into a `BusinessException`. The transaction was reported as a business
 * failure on run `20260903T213924Z-ee0266` immediately AFTER it had signed and
 * filed the application, which is the worst possible place to misread a screen.
 *
 * It was a race, not a new bug: four earlier runs happened to look after the
 * toast had faded. A flake in the one function that decides Business vs System
 * for every screen in the automation.
 * ────────────────────────────────────────────────────────────────────────────
 */
const NOT_A_COMPLAINT = /^success\b|\bsuccessfully\b|\bplease select continue\b/i;

/**
 * Whether a message from the portal is a complaint about our input.
 *
 * Pure, and exported, so the wording rules can be tested against real captured
 * strings without a browser - which is the only practical way to cover this:
 * the strings arrive on screens that are expensive or irreversible to reach.
 */
export function isPortalComplaint(text: string): boolean {
  if (NOT_A_COMPLAINT.test(text)) return false;
  return PROBLEM_WORDING.test(text);
}

export async function readPortalValidationError(page: Page): Promise<string | undefined> {
  const candidates = page.locator(
    ['[role="alert"]', '.error-message', '.slds-form-element__help', '[class*="error"][class*="message"]'].join(','),
  );

  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 10); i += 1) {
    const candidate = candidates.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    /**
     * Success and info toasts are excluded structurally as well as by wording.
     * Belt and braces on purpose: the wording list cannot anticipate every
     * cheerful sentence Anthem puts in an alert region, and being wrong here
     * fails a healthy transaction.
     */
    const theme = (await candidate.getAttribute('class').catch(() => '')) ?? '';
    if (/slds-theme_(success|info)|slds-theme--(success|info)/.test(theme)) continue;

    const text = (await candidate.textContent().catch(() => undefined))?.replace(/\s+/g, ' ').trim();
    if (text === undefined || text.length === 0) continue;
    if (!isPortalComplaint(text)) continue;

    return text;
  }
  return undefined;
}

/**
 * Detects the `Application Matching Error` interstitial.
 *
 * VERIFIED 2026-09-03. Entering `/enrollgroupca-co` for an account that already
 * has an application in progress does not raise a validation message - it
 * REDIRECTS to `/broker/s/inprogressapplication`, whose whole content is:
 *
 *   "Application Matching Error - There is already an application in progress
 *    for this small group, so we can't create a new one. You can proceed with
 *    the existing application: <name>"
 *
 * and whose only control is `Exit`. There is no way forward from it.
 *
 * Why it needs its own reader: the text sits in plain `<span>`/`<p>` elements
 * with no alert role, so `readPortalValidationError` does not see it, and the
 * step waiting for the application URL then simply times out. That presents as
 * a broken locator on a portal that is in fact working correctly and telling us
 * something specific - which is the worst kind of failure to debug at 03:00.
 *
 * It is a BUSINESS failure: re-running will get the same answer until a human
 * either finishes or cancels the existing application, so a retry only wastes
 * three browser relaunches.
 */
export async function readApplicationMatchingError(page: Page): Promise<string | undefined> {
  if (!/\/inprogressapplication/i.test(page.url())) return undefined;

  const name = new URL(page.url()).searchParams.get('c__matchingAppName') ?? undefined;

  return (
    'Anthem already has an application in progress for this group, so the portal refused to ' +
    'create a new one (its own wording: "Application Matching Error"). The existing application ' +
    `must be finished or cancelled by a human before this group can be submitted again${
      name === undefined ? '' : `: ${name}`
    }.`
  );
}
