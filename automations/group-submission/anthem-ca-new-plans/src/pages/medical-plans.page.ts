import { BusinessException, step, textVisible, visible, type StepContext } from '@rpa/core';
import type { Page } from 'playwright';
import type { Payload } from '../payload.ts';
import {
  DOCUMENT_TIMEOUT_MS,
  FIELD_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
  button,
  dismissModal,
} from './lightning.ts';
import { readPortalValidationError } from './portal-errors.ts';

/**
 * `Select Medical Plans` - stage 5.
 *
 * Each plan renders as a card carrying name / metal level / contract code /
 * monthly premium, with its own `Select` button and a `Compare` checkbox. The
 * runbook's "Select Plan, not compare" still applies.
 *
 * ── TWO THINGS THAT DO NOT WORK ──────────────────────────────────────────────
 * The `Search by Contract Code or Product Name` box accepts text (its `value`
 * reads back) but does not filter the list - not with fill, not with real key
 * events, not with Enter. Filtering by METAL LEVEL does work.
 *
 * `Show More` expands one card's benefit detail; it does not page the list.
 * Treating it as pagination gives a loop that never advances.
 *
 * So a plan is found by reading contract codes off the cards. Those codes live
 * in shadow DOM, which is why they are absent from `document.body.innerText`
 * and why a page-text search for them finds nothing.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class MedicalPlansPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  /** Contract codes currently rendered, read out of the cards. */
  async offeredContractCodes(): Promise<string[]> {
    return this.#page.evaluate(`(() => {
      const walk = (root, out) => {
        for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }
        return out;
      };
      const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const text = (el) => (el.textContent ?? '').replace(/\\s+/g, ' ').trim();
      return [...new Set(
        walk(document, [])
          .filter((el) => shown(el) && el.children.length === 0 && /^[0-9][A-Z0-9]{3}$/.test(text(el)))
          .map(text),
      )];
    })()`) as Promise<string[]>;
  }

  /** Anthem's four metal levels, as the filter panel spells them. */
  static readonly METALS = ['Bronze', 'Silver', 'Gold', 'Platinum'] as const;

  /**
   * Which metal filter a plan needs, read from its name.
   *
   * The plan list renders only a handful of plans at a time and `Show More`
   * expands a CARD rather than paging the list, so a plan outside the default
   * view is invisible - and a naive "is this code offered?" check reports a
   * perfectly available plan as not sold. Filtering by metal is the one
   * narrowing that demonstrably works on this screen.
   */
  static metalOf(planName: string): string | undefined {
    return MedicalPlansPage.METALS.find((metal) => new RegExp(`\\b${metal}\\b`, 'i').test(planName));
  }

  /** Applies a single metal-level filter, replacing whatever was set before. */
  async #filterByMetal(metal: string): Promise<void> {
    await this.#page.locator('button').filter({ hasText: /^Filters/ }).filter({ visible: true }).first().click();
    await this.#page.waitForTimeout(1_500);

    await this.#page
      .locator('button')
      .filter({ hasText: /^Reset Filter$/ })
      .filter({ visible: true })
      .first()
      .click()
      .catch(() => undefined);

    await this.#page
      .locator('label')
      .filter({ hasText: new RegExp(`^${metal}$`) })
      .filter({ visible: true })
      .first()
      .click();

    await this.#page
      .locator('button')
      .filter({ hasText: /^Apply Filters$/ })
      .filter({ visible: true })
      .first()
      .click();
    await this.#page.waitForTimeout(2_500);
  }

  /**
   * Selects every plan the payload asks for.
   *
   * Grouped by metal level, because that is the only way to make a plan
   * visible. A code the portal does not offer AT ITS OWN METAL is a
   * BusinessException naming it: the carrier does not sell it for this group,
   * effective date and ZIP, and no retry changes that. Anthem rotates contract
   * codes by plan year, so a stale payload is the likeliest cause - which is
   * worth saying in the message rather than making someone work it out.
   */
  async selectPlans(payload: Payload): Promise<void> {
    await step(this.#steps, {
      name: 'wait for the plan list',
      /**
       * Its own budget, like the quote documents: Anthem prices every plan for
       * this census server-side before the list renders, which takes longer
       * than a screen transition. This step failed at 45s on a list that then
       * appeared moments later - and the retry rebuilt the whole quote.
       */
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () =>
        visible(this.#page.getByText('Select Medical Plans').first(), DOCUMENT_TIMEOUT_MS),
      // An informational modal about comparing plans opens on arrival.
      action: async () => {
        await dismissModal(this.#page, 'Close');
      },
      alwaysRun: true,
      postcondition: async () => visible(button(this.#page, 'Select'), DOCUMENT_TIMEOUT_MS),
    });

    const byMetal = new Map<string, string[]>();
    for (const policy of payload.policies) {
      const metal = MedicalPlansPage.metalOf(policy.planName);
      if (metal === undefined) {
        throw new BusinessException(
          `Cannot tell which metal level "${policy.planName}" (${policy.planCode}) belongs to, so the ` +
            'plan list cannot be narrowed enough to find it. Anthem plan names carry the metal level.',
          { details: { planCode: policy.planCode, planName: policy.planName } },
        );
      }
      byMetal.set(metal, [...(byMetal.get(metal) ?? []), policy.planCode]);
    }

    for (const [metal, codes] of byMetal) {
      await step(this.#steps, {
        name: `show ${metal} plans`,
        action: async () => this.#filterByMetal(metal),
        alwaysRun: true,
        postcondition: async () => visible(button(this.#page, 'Select'), SCREEN_TIMEOUT_MS),
      });

      const offered = await this.offeredContractCodes();
      const missing = codes.filter((code) => !offered.includes(code));

      if (missing.length > 0) {
        throw new BusinessException(
          `Anthem does not offer ${metal} contract code(s) ${missing.join(', ')} for this group, ZIP and ` +
            `effective date. Offered ${metal}: ${offered.join(', ') || 'none rendered'}. Anthem rotates ` +
            "contract codes by plan year, so a payload carrying a previous year's codes is the likeliest cause.",
          { details: { metal, missing, offered, requested: codes } },
        );
      }

      for (const code of codes) {
        await step(this.#steps, {
          name: `select plan ${code}`,
          precondition: async () => textVisible(this.#page, code, FIELD_TIMEOUT_MS),
          action: async () => {
            await this.#cardFor(code).locator('button').filter({ hasText: /^Select$/ }).first().click();
          },
          // Specific to THIS code, so re-running skips only what is already done.
          postcondition: async () =>
            visible(
              this.#cardFor(code).locator('button').filter({ hasText: /^Selected$/ }),
              FIELD_TIMEOUT_MS,
            ),
          businessCheck: async () => readPortalValidationError(this.#page),
        });
      }
    }
  }

  /**
   * The card carrying one contract code.
   *
   * `.last()` on "a div containing 8VAY" is NOT the card - it is the innermost
   * such element, which is the little leaf div holding the code text and
   * nothing else. Requiring the container to ALSO hold the plan's own
   * Select/Selected button is what makes `.last()` land on the card instead of
   * inside it.
   */
  #cardFor(code: string): ReturnType<Page['locator']> {
    return this.#page
      .locator('article, li, div')
      .filter({ hasText: code })
      .filter({ has: this.#page.locator('button').filter({ hasText: /^(Select|Selected)$/ }) })
      .filter({ visible: true })
      .last();
  }

  /** Continue produces the quote; the portal shows a "Preparing…" modal first. */
  async generateQuote(): Promise<void> {
    await step(this.#steps, {
      name: 'generate the quote',
      // step() caps every gate at its own timeoutMs; without this the 90s
      // URL wait below is cut to the 60s default.
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () => visible(button(this.#page, 'Continue'), FIELD_TIMEOUT_MS),
      action: async () => {
        await button(this.#page, 'Continue').last().click();
        await dismissModal(this.#page, 'OK', 60_000);
      },
      alwaysRun: true,
      /**
       * The URL, not the step rail.
       *
       * Landing on `/documentsreview?c__c=<quoteId>` is the moment the quote
       * EXISTS - the rail still reads "Quote Review & Confirmation Untouched"
       * for the best part of a minute afterwards while the documents render.
       * Waiting on the rail failed a step whose work had already succeeded, and
       * the retry then tore down a real quote and built another one.
       *
       * The long wait belongs on the review page, which waits for this group's
       * name to appear.
       */
      postcondition: async () =>
        this.#page
          .waitForURL(/\/documentsreview\?/i, { timeout: SCREEN_TIMEOUT_MS })
          .then(() => true)
          .catch(() => false),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }
}
