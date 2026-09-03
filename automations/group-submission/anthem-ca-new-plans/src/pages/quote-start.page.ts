import { SystemException, step, visible, type StepContext } from '@rpa/core';
import type { Locator, Page } from 'playwright';
import { readPortalValidationError } from './portal-errors.ts';

/**
 * Anthem CA - starting a quote and creating the group account. Stages 2.1-2.3.
 *
 * ── THIS FILE IS THE EXEMPLAR ────────────────────────────────────────────────
 * Every method shows the pattern the rest of the automation follows: a step()
 * with a precondition, an action, and a postcondition that references a payload
 * value.
 *
 * Note what the gates use. `visible()` and `valueIs()` from @rpa/core WAIT;
 * Playwright's `isVisible()` does not. This file used to use `isVisible()`, and
 * it cost a live run: the automation signed in, reached the Producer Toolbox,
 * and failed the very first precondition below because the dashboard was still
 * painting "Loading, please wait ..." at the instant the gate asked. The locator
 * was right. The question was asked wrong. Do not reintroduce `isVisible()` in a
 * gate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The dashboard is heavy - news carousel, commissions chart, quick links - and
 * routinely takes longer than a default gate budget to paint. Same reasoning and
 * same number as LANDMARK_TIMEOUT_MS in login.page.ts.
 */
const DASHBOARD_TIMEOUT_MS = 45_000;

/** A screen transition on this portal is a client-side render, not a page load. */
const SCREEN_TIMEOUT_MS = 20_000;

export class QuoteStartPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  /**
   * The "Create a New Quote" card.
   *
   * Scoping is not optional here. VERIFIED 2026-09-02: the quotes screen renders
   * "Select a Market" TWICE - once in this card and once under "Previous
   * Quotes" - and driving the wrong one filters a history list rather than
   * starting anything. The card heading is an h1 (not the h2/h3 the rest of the
   * page uses), so the card is found by walking up from it.
   */
  #quoteCard(): Locator {
    return this.#page
      .locator('div')
      .filter({ has: this.#page.getByRole('heading', { name: /create a new quote/i }) })
      .last();
  }

  /** The market/state pickers are buttons opening `label[role="option"]` lists. */
  async #pickFromCard(buttonName: RegExp, optionName: string): Promise<void> {
    await this.#quoteCard().getByRole('button', { name: buttonName }).first().click();
    await this.#page.getByRole('option', { name: optionName, exact: true }).first().click();
  }

  /**
   * Stages 2.1.1 - 2.1.3: reach Quotes, then create a small-group California quote.
   *
   * ── RE-MAPPED AGAINST THE LIVE PORTAL 2026-09-02 ─────────────────────────
   *  - The runbook's "Book of Business -> Quotes" path does not work. "Book of
   *    Business" is a `span[role="button"]` MENU TOGGLE that does not navigate,
   *    and the text appears five times on the dashboard.
   *  - The dashboard's own "Start Quote" tile goes straight to
   *    /apps/ptb/quotes/<agency code>, which is the screen the runbook means.
   *    VERIFIED: the tile is a `div[role=button]` named exactly "Start Quote".
   *  - "Select a Market" / "Select a State" are BUTTONS opening a list of
   *    `label[role="option"]`, not `<select>` elements, so selectOption() could
   *    never have worked. VERIFIED: the market list is Individual / Medicare /
   *    Small Group.
   *  - The state picker only renders once a market is chosen.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async startNewSmallGroupQuote(): Promise<Page> {
    await step(this.#steps, {
      name: 'open the quotes area',
      precondition: async () =>
        visible(this.#page.getByRole('button', { name: 'Start Quote', exact: true }), DASHBOARD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByRole('button', { name: 'Start Quote', exact: true }).first().click();
      },
      /**
       * "Quotes" exactly. The same screen renders "Create a New Quote" and
       * "Previous Quotes", which a loose match would pick up.
       *
       * alwaysRun, because this postcondition cannot be made specific to the
       * transaction - the quotes screen looks identical for every group, so the
       * skip-ahead would be satisfied by merely having been here before.
       * Re-opening the quotes area is idempotent, so running it twice is free;
       * wrongly skipping it would leave every later precondition on the wrong
       * screen.
       */
      alwaysRun: true,
      postcondition: async () =>
        visible(this.#page.getByRole('heading', { name: 'Quotes', exact: true }), SCREEN_TIMEOUT_MS),
    });

    await step(this.#steps, {
      name: 'choose small group and California',
      precondition: async () => visible(this.#quoteCard(), SCREEN_TIMEOUT_MS),
      action: async () => {
        await this.#pickFromCard(/select a market/i, 'Small Group');
        await this.#pickFromCard(/select a state/i, 'California');
      },
      /**
       * Each picker RENAMES ITSELF to the selection once made, which is a far
       * better postcondition than the option list: it survives the list closing
       * and it distinguishes "chosen" from "chooseable".
       */
      postcondition: async () =>
        (await visible(this.#quoteCard().getByRole('button', { name: 'Small Group', exact: true }))) &&
        (await visible(this.#quoteCard().getByRole('button', { name: 'California', exact: true }))),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    /**
     * VERIFIED 2026-09-03: the control is `Create Quote`, it renders only once
     * BOTH pickers are set, and it opens a NEW TAB on Anthem's Salesforce
     * platform (`elevancehealthfulcrum.my.site.com`). Everything after this
     * point happens on the returned page, not on `this.#page`.
     */
    const result = await step<Page>(this.#steps, {
      name: 'create the quote',
      precondition: async () =>
        visible(this.#quoteCard().getByRole('button', { name: 'Create Quote', exact: true }), SCREEN_TIMEOUT_MS),
      action: async () => {
        const pending = this.#page.context().waitForEvent('page', { timeout: SCREEN_TIMEOUT_MS });
        await this.#quoteCard().getByRole('button', { name: 'Create Quote', exact: true }).first().click();
        const platform = await pending;
        await platform.waitForLoadState('domcontentloaded');
        return platform;
      },
      /**
       * alwaysRun, and it has to be: this creates a real quote and there is
       * nothing on the Producer Toolbox screen that says whether THIS group
       * already has one. Skipping it would leave the run with no platform tab
       * at all.
       */
      alwaysRun: true,
      postcondition: async () => true,
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    if (result.value === undefined) {
      throw new SystemException('Create Quote did not open the Anthem quoting platform tab.');
    }
    return result.value;
  }
}
