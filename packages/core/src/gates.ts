import type { Locator, Page } from 'playwright';

/**
 * Waiting answers for step() gates.
 *
 * A gate is a question - see steps.ts - and the obvious way to ask "is this on
 * screen?" is `locator.isVisible()`. That is a trap. `isVisible()` is
 * Playwright's ONE non-waiting assertion: it snapshots the DOM right now and
 * returns false if the element has not rendered yet. Against a single-page
 * portal that is a race the gate loses almost every time.
 *
 * It has already cost a real run. The Anthem automation signed in successfully,
 * reached the Producer Toolbox, and then failed the very first precondition of
 * stage 2 - because the dashboard was still painting "Loading, please wait ..."
 * when the gate asked. The locator was correct; the question was asked wrong.
 * The login page object, which uses waitFor(), never had the problem.
 *
 * So these helpers exist to make the waiting form the easy one to reach for.
 * They swallow their own timeouts and return false, which is exactly the
 * contract evaluateGate() already applies - the difference is that they wait
 * first.
 */

/**
 * The default is deliberately short.
 *
 * A gate that waits a long time for an answer of "no" makes a failing step slow
 * and a skip-ahead check pathological: step() asks the postcondition BEFORE the
 * action, so on the normal path this timeout is paid in full, per step, waiting
 * for something that is legitimately absent. Screens that genuinely render
 * slowly should pass an explicit override rather than raise this.
 */
const DEFAULT_GATE_TIMEOUT_MS = 5_000;

/** Is this element on screen within the budget? */
export async function visible(locator: Locator, timeoutMs = DEFAULT_GATE_TIMEOUT_MS): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/** Has this element gone away within the budget? Useful after a Next click. */
export async function hidden(locator: Locator, timeoutMs = DEFAULT_GATE_TIMEOUT_MS): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: 'hidden', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/**
 * Does this field actually hold `expected`?
 *
 * Reads the value back rather than trusting fill(). Portals reformat as you
 * type - a phone number gains parentheses, a date is re-punctuated - so the
 * comparison is on trimmed text and the caller normalises anything looser.
 */
export async function valueIs(
  locator: Locator,
  expected: string,
  timeoutMs = DEFAULT_GATE_TIMEOUT_MS,
): Promise<boolean> {
  const field = locator.first();
  if (!(await visible(field, timeoutMs))) return false;
  const actual = await field.inputValue().catch(() => undefined);
  return actual?.trim() === expected.trim();
}

/**
 * Is this text anywhere on the page within the budget?
 *
 * The blunt instrument, for postconditions that can only be expressed as "the
 * payload's FEIN appears somewhere on the confirmation". Prefer a role-scoped
 * locator with visible() when the screen gives you one.
 */
export async function textVisible(
  page: Page,
  text: string | RegExp,
  timeoutMs = DEFAULT_GATE_TIMEOUT_MS,
): Promise<boolean> {
  return visible(page.getByText(text).first(), timeoutMs);
}
