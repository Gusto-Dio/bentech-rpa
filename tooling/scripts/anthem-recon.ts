import type { Page } from 'playwright';

/**
 * The shared half of the Anthem reconnaissance harness.
 *
 * Two entrypoints use it: `anthem-serve.ts`, which holds one signed-in browser
 * open for a whole mapping session, and `anthem-do.ts`, which attaches to that
 * browser over CDP and runs a command against the SAME page. Keeping the dump
 * and the command vocabulary in one place is what stops them drifting apart.
 *
 * Why the split matters: mapping used to relaunch Chromium per command - about a
 * minute each, and every click discarded the state the previous one reached. You
 * cannot map a twenty-screen process by re-deriving a five-click path every time
 * you want to look at the sixth screen.
 */

export interface Described {
  role: string;
  name: string;
  tag: string;
  type: string;
  label: string;
  placeholder: string;
  text: string;
}

/**
 * Browser-side source, kept as a STRING on purpose.
 *
 * This repo's tsconfig has no `dom` lib, deliberately - it is a Node project,
 * and letting `document` resolve everywhere would invite an automation to reach
 * for it. A page.evaluate() callback runs in the browser, not here, so a string
 * is the honest encoding of "different runtime, not type-checked by us" rather
 * than widening the whole repo's lib to make one dev script compile.
 */
const DESCRIBE_CONTROLS = `() => {
  const SELECTOR = [
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[role="option"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="link"]', '[role="combobox"]',
  ].join(',');

  const squash = (value) => (value ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120);

  // Resolve labels within the element's OWN root, not the document. Inside a
  // shadow root, document.querySelector('label[for=...]') finds nothing, which
  // is why every radio on the Lightning wizard dumped with an empty name.
  const labelFor = (el) => {
    const root = el.getRootNode();
    const id = el.getAttribute('id');
    if (id) {
      const explicit = root.querySelector
        ? root.querySelector('label[for="' + CSS.escape(id) + '"]')
        : null;
      if (explicit) return squash(explicit.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) return squash(wrapping.textContent);
    // A Lightning radio is often a bare input followed by its own label.
    const sibling = el.nextElementSibling;
    if (sibling && sibling.tagName === 'LABEL') return squash(sibling.textContent);
    return '';
  };

  // The question a radio belongs to lives on the enclosing fieldset's legend,
  // and without it "Yes" is ambiguous on a screen with six yes/no questions.
  const groupQuestion = (el) => {
    const fieldset = el.closest('fieldset');
    return fieldset ? squash(fieldset.querySelector('legend')?.textContent) : '';
  };

  // Resolves in the order the spec does. aria-label FIRST is the point: that is
  // where this portal hides names that disagree with the visible text.
  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return squash(aria);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const named = labelledBy.split(/\\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (named.trim()) return squash(named);
    }

    // input[type=submit|button] takes its name from value=, not its text.
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) {
      return squash(el.value);
    }

    const explicit = labelFor(el);
    if (explicit) return explicit;

    return squash(el.textContent) || squash(el.getAttribute('placeholder')) || squash(el.getAttribute('title')) ||
      squash(el.getAttribute('value')) || squash(el.getAttribute('name'));
  };

  const implicitRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    // An anchor with NO href has no link role at all - a real trap here, where
    // "Resend Code" is exactly that.
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '(anchor, no href, NO ROLE)';
    if (tag === 'input') {
      const map = { submit: 'button', button: 'button', reset: 'button',
                    checkbox: 'checkbox', radio: 'radio', search: 'searchbox' };
      return map[el.type] ?? 'textbox';
    }
    return tag;
  };

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  // Salesforce Lightning builds this portal out of web components, so most of
  // the real controls live inside shadow roots that querySelectorAll cannot
  // see - a screen with a dozen fields dumped as FIVE until this walked them.
  // Playwright's own locators pierce shadow DOM, so only this dump needed it.
  const collect = (root, out) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(SELECTOR)) out.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
    return out;
  };

  return collect(document, []).filter(isVisible).map((el) => ({
    role: implicitRole(el),
    name: accessibleName(el),
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') ?? '',
    label: labelFor(el),
    placeholder: squash(el.getAttribute('placeholder')),
    text: squash(el.textContent) || groupQuestion(el),
  }));
}`;

/** Headings tell you which screen you are on, which is what a precondition asks. */
const DESCRIBE_HEADINGS = `() => {
  const collect = (root, out) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches('h1,h2,h3,legend,[role="heading"]')) out.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
    return out;
  };
  return collect(document, [])
    .map((el) => el.tagName.toLowerCase() + ': ' + (el.textContent ?? '').replace(/\\s+/g, ' ').trim())
    .filter((line) => line.length > 4)
    .slice(0, 40);
}`;

/**
 * Note the invoking parentheses. A string handed to evaluate() is an
 * EXPRESSION, so passing a bare arrow function returns the function rather than
 * calling it - which surfaces as an unhelpful "is not iterable" downstream.
 */

/**
 * Note the invoking parentheses. A string handed to evaluate() is an
 * EXPRESSION, so passing a bare arrow function returns the function rather than
 * calling it - which surfaces downstream as an unhelpful "is not iterable".
 */
async function describeControls(page: Page): Promise<Described[]> {
  return page.evaluate(`(${DESCRIBE_CONTROLS})()`) as Promise<Described[]>;
}

async function describeHeadings(page: Page): Promise<string[]> {
  return page.evaluate(`(${DESCRIBE_HEADINGS})()`) as Promise<string[]>;
}

/**
 * Waits for the screen to stop moving.
 *
 * NOT networkidle. This portal keeps analytics and polling connections open, so
 * it never reaches idle and every such wait burns its full timeout - a
 * two-command pass was exceeding the whole script's budget. A short fixed settle
 * after domcontentloaded is both faster and a truer model of a client-side
 * render, where nothing navigates at all.
 */
export const SETTLE_MS = 2_500;
export const FIRST_PAINT_MS = 8_000;

export async function settle(page: Page, ms: number = SETTLE_MS): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(ms);
}

export async function dump(page: Page): Promise<void> {
  console.log(`\n${'='.repeat(78)}\nURL: ${page.url()}\nTITLE: ${await page.title()}\n${'='.repeat(78)}`);

  console.log('\n-- HEADINGS --');
  for (const heading of await describeHeadings(page)) console.log(`   ${heading}`);

  const controls = await describeControls(page);
  console.log(`\n-- CONTROLS (${controls.length}) --`);
  for (const c of controls) {
    const extras = [
      c.type === '' ? '' : `type=${c.type}`,
      c.label === '' || c.label === c.name ? '' : `label="${c.label}"`,
      c.placeholder === '' ? '' : `placeholder="${c.placeholder}"`,
      c.text === '' || c.text === c.name ? '' : `text="${c.text}"`,
    ]
      .filter((part) => part !== '')
      .join('  ');
    console.log(`   [${c.role}] "${c.name}"  <${c.tag}> ${extras}`);
  }

  /**
   * A name that appears more than once is the commonest cause of a flaky
   * locator here - "Book of Business" appears five times on the dashboard, and
   * "Previous Quotes" repeats the market/state pickers verbatim, where driving
   * the wrong one filters a list instead of starting a quote. Calling it out
   * means the locator gets scoped the first time rather than the third.
   */
  const counts = new Map<string, number>();
  for (const c of controls) {
    if (c.name === '') continue;
    counts.set(`${c.role}|${c.name}`, (counts.get(`${c.role}|${c.name}`) ?? 0) + 1);
  }
  const ambiguous = [...counts].filter(([, n]) => n > 1);
  if (ambiguous.length > 0) {
    console.log('\n-- AMBIGUOUS (scope these, do not use .first() and hope) --');
    for (const [key, n] of ambiguous) console.log(`   x${n}  ${key.replace('|', ' ')}`);
  }
}

/**
 * `Select a Market` appears twice on the quotes screen - once in "Create a New
 * Quote" and once in "Previous Quotes". So the harness has to be able to say
 * WHICH one: `name@2` picks the second match.
 */
function bare(input: string): string {
  return input.trim().replace(/@\d+$/, '').trim();
}

function nth<T extends { nth: (i: number) => T }>(locator: T, input: string): T {
  const match = /@(\d+)$/.exec(input.trim());
  return locator.nth(match === null ? 0 : Number(match[1]) - 1);
}

export const COMMANDS = [
  '  <blank>        dump this screen again',
  '  u <url>        navigate',
  '  c <name>       click the button with that accessible name (name@2 for the 2nd)',
  '  r <role> <nm>  click by role + accessible name',
  '  t <text>       click by visible text, for role-less controls',
  '  a <legend>=<v> answer a Yes/No radio question by its legend',
  '  f <label>=<v>  fill the field with that label',
  '  b              back',
].join('\n');

/** Runs one harness command against an already-open page. */
export async function runCommand(page: Page, answer: string): Promise<void> {
  try {
    if (answer.startsWith('u ')) {
      await page.goto(answer.slice(2).trim(), { waitUntil: 'domcontentloaded' });
    } else if (answer === 'b') {
      await page.goBack({ waitUntil: 'domcontentloaded' });
    } else if (answer.startsWith('c ')) {
      await nth(page.getByRole('button', { name: bare(answer.slice(2)), exact: true }), answer).click();
    } else if (answer.startsWith('r ')) {
      const [role = 'button', ...rest] = answer.slice(2).trim().split(' ');
      const target = page.getByRole(role as Parameters<Page['getByRole']>[0], {
        name: bare(rest.join(' ')),
        exact: true,
      });
      await nth(target, answer).click();
    } else if (answer.startsWith('t ')) {
      // Click by visible text, for controls with no usable role - the
      // "Resend Code" anchor-without-href case.
      await nth(page.getByText(bare(answer.slice(2)), { exact: true }), answer).click();
    } else if (answer.startsWith('a ')) {
      /**
       * Answer a Vlocity radio question: `a <legend fragment>=<Yes|No>`.
       *
       * Three things make this necessary, all read off the live DOM:
       *  - the wizard pre-renders EVERY branch, so 11 fieldsets and 22 radios
       *    sit in the DOM while one is on screen. A page-level
       *    getByRole('radio', {name:'No'}) matches 22 elements.
       *  - the input is 1x1px behind `label.slds-radio__label`, so clicking the
       *    input times out. The label is the clickable thing.
       *  - ids and names are generated (`vlocity-radio-0`, id suffix `-110`),
       *    so neither can be a locator.
       */
      const [legend = '', value = ''] = answer.slice(2).split('=');
      const fieldset = page
        .locator('fieldset')
        .filter({ hasText: legend.trim() })
        .filter({ visible: true })
        .first();
      await fieldset.locator('label.slds-radio__label').filter({ hasText: value.trim() }).first().click();
    } else if (answer.startsWith('f ')) {
      const [label = '', ...value] = answer.slice(2).split('=');
      await page.getByLabel(label.trim()).first().fill(value.join('=').trim());
    }
  } catch (cause) {
    // A failed click is information, not a reason to lose the session and start
    // the whole reconnaissance pass again.
    console.log(`\n!! ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`);
  }
}
