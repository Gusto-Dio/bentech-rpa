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
const PROBLEM_WORDING =
  /\b(required|invalid|must|cannot|can't|unable|not\s+(?:a|an|valid|found|eligible)|missing|error|exceeds|too\s+(?:long|short|many)|please\s+(?:enter|select|correct|provide))\b/i;

export async function readPortalValidationError(page: Page): Promise<string | undefined> {
  const candidates = page.locator(
    ['[role="alert"]', '.error-message', '.slds-form-element__help', '[class*="error"][class*="message"]'].join(','),
  );

  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 10); i += 1) {
    const candidate = candidates.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    const text = (await candidate.textContent().catch(() => undefined))?.replace(/\s+/g, ' ').trim();
    if (text === undefined || text.length === 0) continue;
    if (!PROBLEM_WORDING.test(text)) continue;

    return text;
  }
  return undefined;
}
