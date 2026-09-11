import type { Page } from 'playwright';

/**
 * Reads what a SAMx screen is actually showing.
 *
 * A screenshot shows you a page; this tells you what the page is complaining
 * about, in text that can be grepped without opening an image viewer. That is
 * the whole value of it while the portal is unmapped: the first real runs will
 * fail on locators, and the useful question is always "what was on screen
 * instead?".
 *
 * It lives in `src/pages/` because it is a list of CSS selectors, and rule 5
 * says selectors live only here.
 *
 * ── DELIBERATELY NOT ANTHEM'S ───────────────────────────────────────────────
 * Anthem's equivalent walks shadow roots and reads a Salesforce wizard rail,
 * because Anthem's portal is Lightning plus Vlocity. Nothing is known about
 * SAMx's markup yet, so this reads only what is true of any HTML document -
 * landmarks, labelled inputs, buttons and ARIA alerts - and the shadow-root walk
 * is kept because it costs nothing and a component framework is likely.
 * Importing Anthem's would be a cross-automation import the boundary checker
 * refuses anyway.
 *
 * TODO(remap): once SAMx's error container is known, add its selector to
 * `alerts` - `readPortalValidationError` in case-start.page.ts is the same
 * question and the two must not disagree.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Browser-side source, kept as a STRING on purpose.
 *
 * This repo's tsconfig has no `dom` lib, deliberately - it is a Node project,
 * and letting `document` resolve everywhere would invite an automation to reach
 * for it. A `page.evaluate()` callback runs in the browser, not here, so a
 * string is the honest encoding of "different runtime, not type-checked by us".
 */
export const READ_DIAGNOSTICS = `() => {
  const walk = (root, out) => {
    for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }
    return out;
  };
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sq = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const all = walk(document, []);
  const labelOf = (el) => {
    const aria = sq(el.getAttribute('aria-label'));
    if (aria) return aria;
    const root = el.getRootNode();
    const l = el.id && root.querySelector ? root.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    if (l) return sq(l.textContent);
    return sq(el.closest('label')?.textContent) || sq(el.getAttribute('placeholder')) || sq(el.name);
  };
  return {
    url: location.href,
    title: sq(document.title),
    alerts: [...new Set(all
      .filter((el) => shown(el) && el.matches('[role=alert],[aria-invalid=true],[class*=error],[class*=Error],[class*=invalid]'))
      .map((el) => sq(el.textContent)).filter(Boolean))].slice(0, 15),
    headings: [...new Set(all
      .filter((el) => shown(el) && el.matches('h1,h2,h3,[role=heading]'))
      .map((el) => sq(el.textContent)).filter(Boolean))].slice(0, 20),
    fields: all
      .filter((el) => el.matches('input,textarea,select') && shown(el) && !['radio','checkbox','file','hidden'].includes(el.type))
      .map((el) => ({ label: labelOf(el).slice(0, 60), value: el.value ?? null }))
      .slice(0, 80),
    buttons: [...new Set(all
      .filter((el) => shown(el) && el.matches('button,a[role=button],input[type=submit]'))
      .map((el) => sq(el.textContent) || sq(el.value)).filter(Boolean))].slice(0, 40),
    links: [...new Set(all
      .filter((el) => shown(el) && el.matches('a[href]') && el.getAttribute('role') !== 'button')
      .map((el) => sq(el.getAttribute('aria-label')) || sq(el.textContent)).filter(Boolean))].slice(0, 60),
    answered: all
      .filter((el) => el.matches('input[type=radio],input[type=checkbox]') && shown(el) && el.checked)
      .map((el) => labelOf(el).slice(0, 60))
      .slice(0, 60),
    modal: (() => {
      const m = all.find((el) => shown(el) && el.matches('[role=dialog],[role=alertdialog],[aria-modal=true]'));
      return m ? sq(m.textContent).slice(0, 300) : null;
    })(),
  };
}`;

/**
 * What `READ_DIAGNOSTICS` returns.
 *
 * ⚠ `fields[].value` and `modal` carry REAL PORTAL VALUES - a group name, a
 * FEIN, a contact's phone number. This shape is safe to write into gitignored
 * `artifacts/`, which is what `gate-evidence.ts` does. It is NOT safe to commit,
 * to put in a GitHub issue, or to hand to anything outside the host. Anything
 * that publishes a screen reading must reduce it to labels first.
 */
export interface ScreenReading {
  url: string;
  title: string;
  /** The portal's own validation messages. The highest-value field here. */
  alerts: string[];
  headings: string[];
  fields: { label: string; value: string | null }[];
  buttons: string[];
  /**
   * Ordinary `<a href>` links, which are NOT buttons.
   *
   * Kept separate and added after the first live dump of the portal came back
   * with an empty button list on a page full of navigation: this reader
   * originally matched Anthem's, which only looks at buttons. On UHC that hid
   * the sign-in route entirely - and worse, the signed-in landmark this
   * automation waits for is `getByRole('link')`, so the reader could not see the
   * one element every gate depends on.
   */
  links: string[];
  /** Labels of the radios and checkboxes currently checked. */
  answered: string[];
  modal: string | null;
}

/**
 * Reads the current screen, or `undefined` if the page would not answer.
 *
 * Never throws. Every caller is capturing evidence about a failure already in
 * progress, and `steps.ts` is explicit that evidence capture must not replace
 * the failure that triggered it.
 *
 * Note the invoking parentheses below. A string handed to `evaluate()` is an
 * EXPRESSION, so a bare arrow function comes back as an unserialisable function
 * - which Playwright returns as `undefined`, and the caller then throws reading
 * `.alerts` off it. That presents as "no diagnostics" rather than as a bug, so
 * the parentheses are load-bearing and belong here rather than at each call site.
 */
export async function readScreen(page: Page): Promise<ScreenReading | undefined> {
  const reading: unknown = await page.evaluate(`(${READ_DIAGNOSTICS})()`).catch(() => undefined);
  return isScreenReading(reading) ? reading : undefined;
}

/**
 * Narrows what came back out of the browser.
 *
 * `page.evaluate` is typed as returning whatever you claim, so a cast here would
 * assert rather than check - and the one field every consumer reads immediately
 * is `alerts`. Checking it is what turns "no diagnostics" from a silent
 * `undefined.alerts` crash into a reported absence.
 */
function isScreenReading(value: unknown): value is ScreenReading {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ScreenReading>;
  return Array.isArray(candidate.alerts) && Array.isArray(candidate.buttons);
}
