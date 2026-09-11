import type { Locator, Page } from 'playwright';

/**
 * What gets painted over before a screenshot leaves this host.
 *
 * Lives in `src/pages/` because a mask list is a selector list, and rule 5 says
 * selectors live only here.
 *
 * ── DENY BY DEFAULT, AND WHY ────────────────────────────────────────────────
 * The obvious design is "mask the fields we know are sensitive". This does the
 * opposite: **publish structure, never values.** Every value-bearing control on
 * the screen is masked unconditionally, whether or not this list has heard of
 * it, and the named regions below are additions rather than the whole policy.
 *
 * The asymmetry is the argument. An over-mask costs a reviewer one question. An
 * under-mask puts a real producer's name, a group's FEIN or an agency code into
 * git history permanently, and these images are committed so a reviewer can see
 * the before/after pair in the pull request. This is the same "err broad" trade
 * the repo already made for `PROBLEM_WORDING` after Anthem's real SIC rejection
 * never matched the original narrow list.
 *
 * ── WHAT STAYS VISIBLE, DELIBERATELY ────────────────────────────────────────
 * Labels, legends, headings, buttons, the wizard rail, spinners, modal chrome
 * and **alert text**. Those are exactly what a locator-drift reviewer needs,
 * and the portal's own wording is the highest-value thing on a failing screen.
 * An alert that happens to quote the group's name is still covered, by the
 * content-matched masks below.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Bumped whenever the selectors below change.
 *
 * Recorded in each capture's manifest, and compared between the before and
 * after images: a pair captured under two different mask versions is not a
 * comparison, it is two different redactions.
 */
export const MASK_LIST_VERSION = 1;

/**
 * Playwright's default mask colour is pink already, but stating it means a
 * future Playwright release cannot quietly change what a reviewer is looking
 * at. An unmistakable colour matters - a mask that reads as part of the page is
 * worse than no mask, because it invites the reviewer to trust what they see.
 */
export const MASK_COLOR = '#FF00FF';

/**
 * Every control that can hold a value, whatever it happens to be called.
 *
 * The four shapes here are measured, not guessed - see the 2026-09-03 drift-log
 * entries. Vlocity keeps combobox values on `data-value` rather than `value`,
 * and renders read-only text through `lightning-formatted-text`, so a selector
 * covering only `input` would leave most of a Salesforce screen's data visible.
 */
const VALUE_BEARING = [
  'input:not([type=radio]):not([type=checkbox]):not([type=submit]):not([type=button])',
  'textarea',
  '[role=combobox]',
  '[data-value]',
  'lightning-formatted-text',
  'lightning-formatted-phone',
  'lightning-formatted-email',
  'lightning-formatted-number',
].join(', ');

/**
 * Regions that carry identifying data but are NOT input controls, so the
 * selector above does not reach them. Each one is a place a real name or code
 * was actually observed.
 */
const NAMED_PII_REGIONS: readonly (readonly [string, string])[] = [
  ['.slds-global-header__item--profile, [class*=profileTrigger], header [class*=userName]', 'the producer name in the portal header'],
  ['.forceCommunityGlobalNavigation [class*=user]', 'the community navigation user menu'],
  ['[data-label="File Name"], td[data-label*="File"]', 'checklist file names embed the group name'],
  ['[class*=censusTable] tbody, [class*=employeeGrid] tbody', 'the census grid is entirely member data'],
  ['[class*=agentDetails], [class*=writingAgent]', 'the agent block carries a licence and an encrypted TIN'],
];

export interface MaskOptions {
  /**
   * Identifying strings from THIS transaction.
   *
   * Any element whose text contains one is masked, which is what lets alert
   * text stay visible in general while an alert quoting the group's name or
   * FEIN is still covered.
   */
  readonly payloadStrings?: readonly string[];
}

/**
 * The locators to hand to `page.screenshot({ mask })`.
 *
 * Note that Playwright masks the BOUNDING BOX of each resolved element, so a
 * locator resolving to nothing simply contributes nothing - which is why an
 * optimistic list of selectors for regions that may not be on this screen is
 * safe rather than an error.
 */
export function redactionMasks(page: Page, options: MaskOptions = {}): Locator[] {
  const masks: Locator[] = [page.locator(VALUE_BEARING)];

  for (const [selector] of NAMED_PII_REGIONS) masks.push(page.locator(selector));

  for (const value of options.payloadStrings ?? []) {
    if (value.trim().length < 3) continue;
    /**
     * `getByText` matches the innermost element containing the string, which is
     * what we want: masking an ancestor would black out half the screen and
     * make the pair useless for review.
     */
    masks.push(page.getByText(value, { exact: false }));
  }

  return masks;
}

/**
 * The same value-bearing selector, exposed for the coverage check.
 *
 * `check-masked-evidence.ts` collects a bounding box for every element this
 * resolves and asserts each one is inside the union of the mask boxes. Sharing
 * the selector is the whole point: a coverage check written against its own
 * idea of "value-bearing" would pass while missing exactly the controls the
 * mask list does not know about.
 */
export const VALUE_BEARING_SELECTOR = VALUE_BEARING;

/** For the manifest, so a reviewer can see what was masked and why. */
export function describeMasks(): readonly { selector: string; why: string }[] {
  return [
    { selector: VALUE_BEARING, why: 'every value-bearing control, masked unconditionally' },
    ...NAMED_PII_REGIONS.map(([selector, why]) => ({ selector, why })),
  ];
}
