import type { Page } from 'playwright';

/**
 * Reads what a portal screen is actually showing, through shadow roots.
 *
 * A screenshot shows you a page; this tells you what the page is complaining
 * about, in text you can grep at 03:00 without opening an image viewer. On this
 * platform that matters more than usual: the messages are the only reliable
 * account of WHY a Continue refused, and they sit in shadow roots that
 * `document.body.innerText` does not reach.
 *
 * It lives in `src/pages/` because it is a list of CSS selectors, and rule 5
 * says selectors live only here.
 *
 * ── WHY IT IS SHARED ────────────────────────────────────────────────────────
 * This was private to `gate-evidence.ts`, where it captures evidence at the
 * moment a gate fails. The sentinel needs the SAME reading to detect that a
 * screen has drifted. Two copies would be worse than useless: a drift baseline
 * would describe a slightly different screen than the one the automation sees
 * when it breaks, so a baseline could match while the automation failed, or
 * drift could fire on a difference the automation never looks at. One reader,
 * two consumers - the same reasoning that produced `createAnthemSession`.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Browser-side source, kept as a STRING on purpose.
 *
 * This repo's tsconfig has no `dom` lib, deliberately - it is a Node project,
 * and letting `document` resolve everywhere would invite an automation to reach
 * for it. A `page.evaluate()` callback runs in the browser, not here, so a
 * string is the honest encoding of "different runtime, not type-checked by us"
 * rather than widening the whole repo's lib to make one module compile.
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
    const root = el.getRootNode();
    const l = el.id && root.querySelector ? root.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    return sq(l?.textContent);
  };
  return {
    url: location.href,
    alerts: [...new Set(all
      .filter((el) => shown(el) && el.matches('.slds-form-element__help,[role=alert],[class*=errorMessage]'))
      .map((el) => sq(el.textContent)).filter(Boolean))].slice(0, 15),
    wizardStep: [...new Set(all
      .filter((el) => shown(el) && el.matches('button'))
      .map((el) => sq(el.textContent))
      .filter((t) => /Untouched|In Progress|Completed/.test(t)))],
    fields: all
      .filter((el) => el.matches('input,textarea') && shown(el) && !['radio','checkbox','file'].includes(el.type))
      .map((el) => ({ label: labelOf(el).slice(0, 60), value: el.getAttribute('data-value') ?? el.value })),
    buttons: [...new Set(all
      .filter((el) => shown(el) && el.matches('button,a[role=button]'))
      .map((el) => sq(el.textContent)).filter(Boolean))].slice(0, 40),
    answered: all
      .filter((el) => el.matches('input[type=radio],input[type=checkbox]') && shown(el) && el.checked)
      .map((el) => labelOf(el).slice(0, 60)),
    modal: (() => {
      const m = all.find((el) => shown(el) && el.matches('section.slds-modal.slds-fade-in-open'));
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
  /** The portal's own validation messages. The highest-value field here. */
  alerts: string[];
  /** Salesforce wizard-rail entries, still carrying their volatile status word. */
  wizardStep: string[];
  fields: { label: string; value: string | null }[];
  buttons: string[];
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
 * `.alerts` off it. That presented as "no diagnostics" rather than as a bug, so
 * the parentheses are load-bearing and belong here rather than at each call
 * site.
 */
export async function readScreen(page: Page): Promise<ScreenReading | undefined> {
  const reading: unknown = await page.evaluate(`(${READ_DIAGNOSTICS})()`).catch(() => undefined);
  return isScreenReading(reading) ? reading : undefined;
}

/**
 * Narrows what came back out of the browser.
 *
 * `page.evaluate` is typed as returning whatever you claim, so a cast here
 * would assert rather than check - and the one field every consumer reads
 * immediately is `alerts`. Checking it is what turns "no diagnostics" from a
 * silent `undefined.alerts` crash into a reported absence.
 */
function isScreenReading(value: unknown): value is ScreenReading {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ScreenReading>;
  return Array.isArray(candidate.alerts) && Array.isArray(candidate.buttons);
}
