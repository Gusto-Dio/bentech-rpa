import { SystemException } from '@rpa/core';
import type { Locator, Page } from 'playwright';

/**
 * The carrier's plan catalog.
 *
 * Locator policy for this repo, most resilient first: getByRole, then
 * getByLabel / getByPlaceholder, then getByTestId, and CSS only as a last
 * resort inside a page object. No XPath anywhere.
 *
 * The comma selectors below are deliberate: this portal is mid-migration from
 * class names to data-test attributes, and matching either means a partial
 * rollout on the carrier's side does not take the automation down.
 */
export class PlanCatalogPage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  /**
   * Navigates straight to the catalog.
   *
   * Every transaction calls this. A queue-driven automation must never inherit
   * whatever page the previous transaction left behind - that coupling is one of
   * the most common ways an automation works perfectly for item 1 and then
   * fails for item 2.
   */
  async open(portalUrl: string): Promise<void> {
    const catalogUrl = new URL('inventory.html', portalUrl).href;
    await this.#page.goto(catalogUrl, { waitUntil: 'domcontentloaded' });
  }

  /**
   * The portal keeps a draft submission in browser storage, so it survives
   * between transactions in the same session. Resetting through the portal's
   * own menu is the only reliable way to start each group from a clean slate -
   * clearing cookies would sign us out instead.
   */
  async resetDraftSubmission(): Promise<void> {
    await this.#page.getByRole('button', { name: 'Open Menu' }).click();
    await this.#page.locator('[data-test="reset-sidebar-link"]').click();
    await this.#page.getByRole('button', { name: 'Close Menu' }).click();
    await this.#page.reload({ waitUntil: 'domcontentloaded' });
  }

  async listAvailablePlans(): Promise<string[]> {
    const names = await this.#planNames().allTextContents();
    return names.map((name) => name.trim()).filter((name) => name.length > 0);
  }

  async addPlan(planName: string): Promise<void> {
    const card = this.#planCard(planName);
    const addButton = card.getByRole('button', { name: 'Add to cart' });

    try {
      await addButton.click();
    } catch (cause) {
      // The plan was in the catalog listing a moment ago, so failing to add it
      // is the portal misbehaving, not a business rule.
      throw new SystemException(`Could not add plan "${planName}" to the submission`, { cause });
    }
  }

  /** Line count on the draft submission badge. Absent badge means zero lines. */
  async draftLineCount(): Promise<number> {
    const badge = this.#page.locator('[data-test="shopping-cart-badge"], .shopping_cart_badge');
    if (!(await badge.isVisible().catch(() => false))) return 0;
    return Number((await badge.textContent())?.trim() ?? '0');
  }

  async openDraftSubmission(): Promise<void> {
    await this.#page.locator('[data-test="shopping-cart-link"], .shopping_cart_link').click();
  }

  #planCard(planName: string): Locator {
    return this.#page
      .locator('[data-test="inventory-item"], .inventory_item')
      .filter({ hasText: planName });
  }

  #planNames(): Locator {
    return this.#page.locator('[data-test="inventory-item-name"], .inventory_item_name');
  }
}
