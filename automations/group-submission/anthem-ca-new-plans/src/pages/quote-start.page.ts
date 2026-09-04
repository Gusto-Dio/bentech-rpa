import { BusinessException, SystemException, step, visible, type StepContext } from '@rpa/core';
import type { Locator, Page } from 'playwright';
import { OKTA_HOST, OKTA_PASSCODE_FIELD } from './login.page.ts';
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

/**
 * The host of a URL, or '' when it cannot be parsed.
 *
 * Parsed rather than pattern-matched, for the reason rule 9's gotcha records:
 * the OAuth flow has Okta and the portal quoting each other in query strings, so
 * a substring test matches the wrong page in both directions.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export class QuoteStartPage {
  readonly #page: Page;
  readonly #steps: StepContext;
  readonly #resolveSaml: ((page: Page) => Promise<boolean>) | undefined;

  /**
   * `resolveSaml` re-authenticates the platform hand-off when it asks for the
   * password again. Injected rather than built here so this page object needs
   * neither the config nor the secret resolver - the caller owns both.
   */
  constructor(page: Page, steps: StepContext, resolveSaml?: (page: Page) => Promise<boolean>) {
    this.#page = page;
    this.#steps = steps;
    this.#resolveSaml = resolveSaml;
  }

  /**
   * Which of the two real outcomes the hand-off reached.
   *
   * Both branches reject on timeout and map to the same value, so whichever
   * settles FIRST decides - that is the point. The happy path resolves as soon
   * as the browser leaves Okta, without waiting out the challenge budget.
   */
  async #awaitHandOff(platform: Page): Promise<'platform' | 'challenged' | 'stuck'> {
    if (!hostOf(platform.url()).endsWith(OKTA_HOST)) return 'platform';

    return Promise.race([
      platform
        .waitForURL((url) => !url.host.endsWith(OKTA_HOST), { timeout: SCREEN_TIMEOUT_MS })
        .then(() => 'platform' as const)
        .catch(() => 'stuck' as const),
      platform
        .locator(OKTA_PASSCODE_FIELD)
        .first()
        .waitFor({ state: 'visible', timeout: SCREEN_TIMEOUT_MS })
        .then(() => 'challenged' as const)
        .catch(() => 'stuck' as const),
    ]);
  }

  /**
   * ── BUSINESS, NOT SYSTEM, AND DELIBERATELY ──────────────────────────────────
   * By the time this is thrown, `Create Quote` has already succeeded: a REAL
   * quote exists on Anthem production. A SystemException is retryable, and the
   * runner's recovery re-runs the whole transaction from the start - which
   * re-clicks `Create Quote` and creates a SECOND real quote for the same
   * group, then hits Anthem's "Application Matching Error" and fails anyway.
   *
   * That is precisely the pathology that made this PoC's production cleanup
   * list as long as it is. Retrying here cannot help and provably makes things
   * worse, so the item fails terminally and a human picks it up - which is what
   * rule 1's test actually asks: would running this again plausibly give a
   * different answer? No.
   * ───────────────────────────────────────────────────────────────────────────
   */
  #handOffFailed(because: string): BusinessException {
    return new BusinessException(
      `Create Quote opened the platform tab but the hand-off did not complete: ${because}. ` +
        'The portal session is valid; the Salesforce community session had lapsed. A quote has ' +
        'ALREADY been created for this group, so this is not retried - a retry would create a ' +
        'second one. Re-run once the session is re-established, and clear the orphan quote.',
      { details: { reason: because } },
    );
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

    /**
     * ── THE SAML HOP: PLATFORM, OR A PASSWORD PROMPT? ──────────────────────
     * `Create Quote` hands off to the Salesforce platform through Okta, and the
     * happy path GOES THROUGH Okta: an auto-posting intermediate document
     * bounces the browser on to the platform. So "the URL is on Okta right now"
     * proves nothing - checking it immediately after `domcontentloaded` would
     * fire on a perfectly good hand-off, and the recovery below would then
     * throw on a run that was fine.
     *
     * What distinguishes the two is a VISIBLE PASSWORD FIELD. So this races the
     * two real outcomes and lets whichever happens first decide: leaving Okta
     * means the hand-off completed, a passcode field appearing means the
     * community session had lapsed and we are being challenged.
     * ───────────────────────────────────────────────────────────────────────
     */
    const platform = result.value;
    const hop = await this.#awaitHandOff(platform);

    if (hop === 'challenged') {
      /**
       * Recover rather than fail: the password is all Okta wants for this hop -
       * the device is already trusted, so no MFA code is spent.
       */
      const recovered = (await this.#resolveSaml?.(platform).catch(() => false)) ?? false;
      this.#steps.logger.warn(
        { recovered },
        recovered
          ? 'The platform hand-off asked for the password again; re-authenticated'
          : 'The platform hand-off asked for the password again and could not be recovered',
      );

      if (!recovered) throw this.#handOffFailed('the password prompt could not be answered');
    } else if (hop === 'stuck') {
      throw this.#handOffFailed('it stayed on Okta without ever showing a password prompt');
    }

    return result.value;
  }
}
