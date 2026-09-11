import { visible } from '@rpa/core';
import type { Locator, Page } from 'playwright';

/**
 * Interacting with a Salesforce Lightning / Vlocity OmniScript portal.
 *
 * Everything in this file exists because a plain Playwright locator does the
 * wrong thing on this platform. Each helper encodes one behaviour that was
 * discovered the expensive way against the live Anthem portal on 2026-09-03 -
 * all of them are written up in docs/poc/anthem-ca-new-plans/drift-log.md.
 *
 * ── WHY IT MOVED HERE (2026-09-11) ──────────────────────────────────────────
 * It used to live in `anthem-ca-new-plans/src/pages/`, with a note saying it
 * would stay there "until a second one needs it". A second one now does: the
 * dev-portal automation drives a local replica of the same platform, and rule 4
 * forbids one automation importing another - so the alternative was a copy, and
 * a copy would let the two drift apart on exactly the behaviours this file
 * exists to pin down.
 *
 * It is also the fidelity contract for that replica. These helpers, unmodified,
 * must drive the dummy portal; a helper that needs adapting to work locally
 * means the replica is wrong, not the helper.
 */

/** Vlocity screens repaint on every answer; a gate has to outlast that. */
export const FIELD_TIMEOUT_MS = 20_000;
/**
 * A screen transition on this portal is a client-side render, not a page load.
 *
 * Kept UNDER step()'s 60s default on purpose. `step()` caps every gate at its
 * own `timeoutMs`, so a gate budget larger than that is silently truncated -
 * a 90s wait here was really a 60s wait, and it cut the quote-documents page
 * off mid-render. Anything genuinely slower than this must say so on the step
 * itself, with `timeoutMs: DOCUMENT_TIMEOUT_MS`.
 */
export const SCREEN_TIMEOUT_MS = 45_000;

/**
 * How long the quote-documents page may take to appear.
 *
 * Its own budget, and a big one, because this is not a render - the server is
 * building the member-rated PDF and Excel for every selected plan. Measured
 * around 45s on a quiet portal and comfortably past 90s under load.
 *
 * Getting this wrong is expensive in a way a normal timeout is not: the quote
 * ALREADY EXISTS by this point, so failing here makes the runner retry the
 * whole transaction and create a second real quote for the same group,
 * abandoning the first. Better to wait several minutes than to orphan one.
 */
export const DOCUMENT_TIMEOUT_MS = 300_000;

/**
 * Clicks a button by its visible text.
 *
 * `getByRole('button', { name })` is NOT reliable here: a button rendered
 * inside a `LIGHTNING-BUTTON` shadow root matches zero role queries while the
 * plain CSS locator finds it. The wizard's own Continue is one of those, so a
 * role-only locator silently finds nothing and the step times out looking
 * healthy. Role is still tried first, because when it works it is the more
 * precise match.
 */
export function button(page: Page, text: string | RegExp): Locator {
  const name = typeof text === 'string' ? new RegExp(`^${escapeRegExp(text)}$`) : text;
  return page
    .locator('button')
    .filter({ hasText: name })
    .filter({ visible: true });
}

/**
 * A form field, by its label, restricted to the one on screen.
 *
 * `page.getByLabel(x)` alone is not safe here. The Vlocity wizard PRE-RENDERS
 * hidden branches, so a label can resolve to several inputs of which the first
 * in DOM order is invisible - and `.first().waitFor({ state: 'visible' })` then
 * waits out its whole budget on an element that will never show, while the real
 * field sits on screen. That is exactly how "enter the main phone number"
 * failed its precondition on a page where the field was plainly rendered.
 *
 * `filter({ visible: true })` is re-evaluated on every poll, so this still
 * waits correctly for a field that has not appeared yet.
 */
export function field(page: Page, label: string | RegExp): Locator {
  return page.getByLabel(label).filter({ visible: true });
}

/**
 * A picker that is NOT a labelled input.
 *
 * Some Vlocity selects render as a BUTTON showing the current value, inside an
 * `.slds-form-element` next to their label - `Group County` is one, which is
 * why `getByLabel('*Group County')` finds nothing at all and the step fails its
 * precondition on a control sitting in plain view.
 *
 * So this walks from the label to the form element that contains it and returns
 * whatever control is inside, button or input.
 */
export function picker(page: Page, label: string | RegExp): Locator {
  return page
    .locator('.slds-form-element')
    .filter({ has: page.locator('label', { hasText: label }) })
    .filter({ visible: true })
    .last()
    .locator('button, input[role=combobox]')
    .filter({ visible: true })
    .first();
}

/**
 * Opens a `picker()` and chooses an option.
 *
 * Separate from `select()` because there is no input to clear and no
 * `data-value` to read back - the button's own text becomes the selection.
 */
export async function choose(page: Page, label: string | RegExp, option: string | RegExp): Promise<void> {
  await picker(page, label).click({ force: true });
  const wanted = typeof option === 'string' ? new RegExp(`^${escapeRegExp(option)}$`, 'i') : option;
  await page
    .locator('[role=option], li, label[role=option]')
    .filter({ hasText: wanted })
    .filter({ visible: true })
    .first()
    .click({ force: true });
}

/** What a `picker()` currently displays. */
export async function chosen(page: Page, label: string | RegExp): Promise<string> {
  const control = picker(page, label);
  const dataValue = await control.getAttribute('data-value').catch(() => null);
  if (dataValue !== null && dataValue !== '') return dataValue;
  return (await control.textContent().catch(() => ''))?.trim() ?? '';
}

/**
 * The fieldset for one Yes/No question, identified by its legend.
 *
 * Two traps, both load-bearing:
 *
 *  - The wizard PRE-RENDERS every branch, so ~11 fieldsets and 22 radios sit in
 *    the DOM while one is on screen. Filtering to the visible one is mandatory.
 *  - `filter({ hasText })` matches any ANCESTOR fieldset too, and the first
 *    match is then an outer wrapper containing several questions. Clicking
 *    "No" inside it hits the PREVIOUS question's answer, which is already set,
 *    so nothing appears to happen. `:scope > legend` pins it to the fieldset
 *    that actually owns the legend.
 */
export function question(page: Page, legend: string | RegExp): Locator {
  return page
    .locator('fieldset')
    .filter({ has: page.locator(':scope > legend', { hasText: legend }) })
    .filter({ visible: true })
    .last();
}

/**
 * Answers a Yes/No question.
 *
 * Clicks the LABEL. The `input[type=radio]` is 1x1 px behind
 * `label.slds-radio__label`, so `elementFromPoint` returns the custom element
 * and Playwright's actionability check never passes - the click times out after
 * 30s on a control a human can see and press.
 */
export async function answer(page: Page, legend: string | RegExp, value: 'Yes' | 'No'): Promise<void> {
  await question(page, legend)
    .locator('label.slds-radio__label')
    .filter({ hasText: new RegExp(`^${value}$`) })
    .first()
    .click();
}

/**
 * True when that question currently holds that answer.
 *
 * Resolves the radio through its LABEL, scoped to the question's own fieldset.
 * Two earlier attempts got this wrong: `input[value="No"]:checked` fails
 * because the value attribute is not dependable across this wizard, and a
 * string-based `evaluate` was worse - it silently returned the wrong thing and
 * reported an answered question as unanswered, failing steps whose clicks had
 * worked.
 */
export async function isAnswered(page: Page, legend: string | RegExp, value: 'Yes' | 'No'): Promise<boolean> {
  const fieldset = question(page, legend).first();
  if ((await fieldset.count()) === 0) return false;

  const byLabel = fieldset.getByLabel(value, { exact: true }).first();
  if ((await byLabel.count()) > 0) {
    return byLabel.isChecked().catch(() => false);
  }

  // Fallback for a radio with no usable label association.
  return fieldset
    .locator(`input[type=radio][value="${value}"]`)
    .first()
    .isChecked()
    .catch(() => false);
}

/**
 * Answers a question only if it is on screen.
 *
 * The continuation pair is mutually exclusive in practice: answering
 * "subject to Cal-COBRA" reveals an enrollee count and can leave the federal
 * COBRA question absent or already settled. Insisting on both fails a screen
 * that is correctly filled.
 */
export async function answerIfPresent(
  page: Page,
  legend: string | RegExp,
  value: 'Yes' | 'No',
  timeoutMs = 5_000,
): Promise<boolean> {
  if (!(await visible(question(page, legend), timeoutMs))) return false;
  await answer(page, legend, value);
  return true;
}

/** Checkboxes hide behind their labels for the same reason radios do. */
export async function check(page: Page, label: string | RegExp): Promise<void> {
  const name = typeof label === 'string' ? new RegExp(`^${escapeRegExp(label)}$`) : label;
  await page.locator('label').filter({ hasText: name }).filter({ visible: true }).first().click();
}

/**
 * Types into a text field.
 *
 * `fill()` is not enough on some Vlocity inputs: it sets the value without the
 * key events the component listens for, so the field looks correct and the
 * form still reports it as required. `pressSequentially` plus a Tab to commit
 * is what actually registers.
 */
export async function type(page: Page, label: string | RegExp, value: string): Promise<void> {
  const field = page.getByLabel(label).filter({ visible: true }).first();
  await field.click();
  await field.fill('');
  await field.pressSequentially(value, { delay: 40 });
  await page.keyboard.press('Tab');
}

/**
 * Selects from a Vlocity combobox.
 *
 * These render as `input[role=combobox]` and keep the committed selection in
 * **`data-value`**, not `value`. Typing text into one leaves `value` looking
 * right while `data-value` stays empty and the form still says the field is
 * required - which is exactly how the leave-of-absence step failed twice.
 *
 * The stale text is cleared first because the list filters on it.
 */
export async function select(page: Page, label: string | RegExp, option: string): Promise<void> {
  const field = page.getByLabel(label).filter({ visible: true }).first();
  await field.click({ force: true });
  await field.press('Control+a').catch(() => undefined);
  await field.press('Backspace').catch(() => undefined);

  const item = page
    .locator('[role=option], li')
    .filter({ hasText: new RegExp(`^${escapeRegExp(option)}$`) })
    .filter({ visible: true });
  await item.first().click({ force: true });
}

/**
 * A typeahead: type a query, then commit one of the suggestions.
 *
 * Distinct from `select()`, which opens an already-populated list. Here the
 * list does not exist until something is typed, and typing alone is NOT
 * enough - Anthem's SIC field accepts the raw code happily and then refuses
 * Continue with "That SIC code isn't valid. Please double check it and try
 * again." The suggestion has to be chosen.
 */
export async function typeahead(
  page: Page,
  label: string | RegExp,
  query: string,
  option: string | RegExp,
): Promise<void> {
  const control = field(page, label).first();
  await control.click();
  await control.fill('');
  await control.pressSequentially(query, { delay: 80 });

  const wanted = typeof option === 'string' ? new RegExp(`^${escapeRegExp(option)}$`) : option;
  await page
    .locator('[role=option], li')
    .filter({ hasText: wanted })
    .filter({ visible: true })
    .first()
    .click({ force: true });
}

/**
 * Reads a combobox's committed selection.
 *
 * Both attributes, because this platform is not consistent: `Benefit Period`
 * and `Group County` commit to `data-value` and leave `value` as display text,
 * while `Coverage Effective Date` has no `data-value` at all and commits to
 * `value`. Reading only one of them makes a correctly-set field look empty and
 * fails the postcondition on a step that worked.
 */
export async function selected(page: Page, label: string | RegExp): Promise<string> {
  const control = field(page, label).first();
  const committed = await control.getAttribute('data-value').catch(() => null);
  if (committed !== null && committed !== '') return committed;
  return (await control.inputValue().catch(() => '')) ?? '';
}

/**
 * True when the combobox holds that selection.
 *
 * Compares against BOTH attributes, because this platform uses them
 * inconsistently and in three different ways:
 *
 *   `Benefit Period`   -> data-value "Calendar Year"        (the label)
 *   `Coverage Eff Date`-> no data-value, value "Sep 1 2026" (the label)
 *   `Is subject to ERISA` -> data-value "Erisa_Option_Two", value the label
 *
 * That last shape is why comparing one attribute is not enough: the field was
 * correctly set and the postcondition read an internal code, failing a step
 * that had worked.
 */
export async function isSelected(page: Page, label: string | RegExp, option: string): Promise<boolean> {
  const control = field(page, label).first();
  const wanted = option.trim().toLowerCase();

  const dataValue = (await control.getAttribute('data-value').catch(() => null))?.trim().toLowerCase();
  if (dataValue === wanted) return true;

  const value = (await control.inputValue().catch(() => ''))?.trim().toLowerCase();
  return value === wanted;
}

/**
 * Compares two phone numbers by digits alone.
 *
 * The portal reformats `3035551234` to `(303) 555-1234` on blur, so a
 * postcondition comparing the payload string verbatim fails on a field that is
 * in fact correct.
 */
export function sameDigits(a: string, b: string): boolean {
  const digits = (value: string): string => value.replace(/\D/g, '');
  return digits(a) === digits(b) && digits(a).length > 0;
}

/**
 * Waits for a wizard step to report a status in the left-hand rail.
 *
 * The rail is the only reliable signal that a Continue landed: the form itself
 * stays on screen and repaints in place, so "the fields are still here" says
 * nothing. Statuses seen: `Untouched`, `In Progress`, `Completed`.
 */
export async function stepIs(
  page: Page,
  step: string,
  status: 'In Progress' | 'Completed',
  timeoutMs = SCREEN_TIMEOUT_MS,
): Promise<boolean> {
  return visible(
    page.locator('button').filter({ hasText: new RegExp(`${escapeRegExp(step)}\\s*${status}`) }),
    timeoutMs,
  );
}

/**
 * How long to wait when POLLING the rail rather than asserting on it.
 *
 * The rail repaints within a second or two of a Continue landing, so a poll
 * that is merely "not there yet" should not burn a 45s screen budget - a loop
 * of four such polls exceeds the step's own timeout and fails a traversal that
 * was working. Assertions still use the full `SCREEN_TIMEOUT_MS`.
 */
export const RAIL_POLL_TIMEOUT_MS = 4_000;

/**
 * Dismisses an SLDS modal by clicking one of its buttons.
 *
 * A modal intercepts pointer events for the WHOLE page until answered, and the
 * resulting failure names `slds-modal__container` as the interceptor while
 * insisting the target is "visible, enabled and stable" - which reads like a
 * flaky click rather than a dialog nobody closed.
 *
 * Returns false when the modal is not showing, so callers can treat an
 * optional interstitial as optional.
 */
export async function dismissModal(page: Page, buttonText: string, timeoutMs = 5_000): Promise<boolean> {
  const modal = page.locator('section.slds-modal.slds-fade-in-open');
  if (!(await visible(modal, timeoutMs))) return false;
  await button(page, buttonText).first().click();
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
