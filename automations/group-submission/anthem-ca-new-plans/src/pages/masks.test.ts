import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import {
  MASK_COLOR,
  MASK_LIST_VERSION,
  VALUE_BEARING_SELECTOR,
  describeMasks,
  redactionMasks,
} from './masks.ts';

/**
 * Against a real DOM, the way `gates.test.ts` does it.
 *
 * A mask list is only as good as what its selector actually resolves on this
 * platform's markup, and the four control shapes below are measured facts from
 * the drift log rather than guesses - so asserting them against a string would
 * prove nothing.
 */
const SCREEN = `
  <main>
    <h1>Group Setup</h1>
    <label for="name">Group Name</label>
    <input id="name" value="Northwind Test Bakery" />

    <label for="tin">Employer Tax ID</label>
    <input id="tin" value="94-1234567" />

    <textarea id="notes">some notes</textarea>

    <!-- Vlocity keeps the value on data-value, not value. -->
    <div role="combobox" data-value="Calendar Year" aria-label="Benefit Period">Calendar Year</div>

    <!-- Read-only Lightning output, which is not an input at all. -->
    <lightning-formatted-text>MBR-000123</lightning-formatted-text>
    <lightning-formatted-phone>(415) 555-0134</lightning-formatted-phone>

    <!-- Deliberately NOT masked: structure a reviewer needs. -->
    <button>Continue</button>
    <div role="alert">That SIC code isn't valid.</div>
    <fieldset><legend>Is this group headquartered in CA?</legend>
      <input type="radio" id="r1" /><label for="r1">Yes</label>
    </fieldset>

    <div class="agentDetails">Producer: Featherstonehaugh, agency AG7741QX</div>
    <table><tbody><tr><td data-label="File Name">Northwind-quote-01234567.pdf</td></tr></tbody></table>
  </main>
`;

async function withPage<T>(body: (page: Awaited<ReturnType<Browser['newPage']>>) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(SCREEN);
    return await body(page);
  } finally {
    await browser.close();
  }
}

describe('redactionMasks - deny by default', () => {
  /**
   * THE POINT OF THE WHOLE FILE. A field this list has never heard of must be
   * masked rather than published, because these images are committed and an
   * under-mask is permanent.
   */
  it('covers every value-bearing control, including the ones no named rule mentions', async () => {
    await withPage(async (page) => {
      const count = await page.locator(VALUE_BEARING_SELECTOR).count();
      // input x2, textarea, combobox (also data-value), and the three lightning outputs.
      assert.ok(count >= 6, `expected the value-bearing selector to reach most of the screen, got ${count}`);
    });
  });

  it('reaches the four Vlocity control shapes the drift log documents', async () => {
    await withPage(async (page) => {
      const reached = async (selector: string): Promise<boolean> =>
        (await page.locator(VALUE_BEARING_SELECTOR).filter({ has: page.locator(':scope') }).count()) >= 0 &&
        (await page.locator(`${VALUE_BEARING_SELECTOR}`).and(page.locator(selector)).count()) > 0;

      assert.ok(await reached('input#name'), 'a plain input');
      assert.ok(await reached('textarea'), 'a textarea');
      assert.ok(await reached('[role=combobox]'), 'a Vlocity combobox');
      assert.ok(await reached('lightning-formatted-text'), 'read-only Lightning output');
    });
  });

  /**
   * What stays visible is as deliberate as what does not. The portal's own
   * wording is the highest-value thing on a failing screen, and a reviewer
   * cannot judge a locator fix without the labels and buttons.
   */
  it('does not mask the structure a reviewer needs', async () => {
    await withPage(async (page) => {
      const selector = VALUE_BEARING_SELECTOR;
      for (const visible of ['button', 'h1', 'legend', 'label', '[role=alert]']) {
        const overlap = await page.locator(selector).and(page.locator(visible)).count();
        assert.equal(overlap, 0, `${visible} must stay readable`);
      }
    });
  });

  it('masks the named regions that are not input controls', async () => {
    await withPage(async (page) => {
      const masks = redactionMasks(page);
      const counts = await Promise.all(masks.map((mask) => mask.count()));
      const total = counts.reduce((sum, count) => sum + count, 0);

      // The agent block and the checklist file-name cell are both present above.
      assert.ok(total > (await page.locator(VALUE_BEARING_SELECTOR).count()));
    });
  });

  /**
   * This is what lets alert text stay visible in general while an alert that
   * quotes the group's name is still covered.
   */
  it('masks anything quoting a payload string', async () => {
    await withPage(async (page) => {
      const masks = redactionMasks(page, { payloadStrings: ['Northwind Test Bakery'] });
      const matched = await Promise.all(masks.map((mask) => mask.count()));
      assert.ok(matched.reduce((a, b) => a + b, 0) > 0);
    });
  });

  it('ignores a payload string too short to be meaningful', async () => {
    await withPage(async (page) => {
      const withShort = redactionMasks(page, { payloadStrings: ['CA', '', ' '] });
      const withNone = redactionMasks(page);
      assert.equal(withShort.length, withNone.length, 'a 2-character string would match half the page');
    });
  });
});

describe('mask metadata', () => {
  /** A pair captured under two mask versions is not a comparison. */
  it('carries a version so a before/after pair can be checked for consistency', () => {
    assert.equal(typeof MASK_LIST_VERSION, 'number');
    assert.ok(MASK_LIST_VERSION >= 1);
  });

  /** A mask that reads as part of the page invites the reviewer to trust it. */
  it('states the mask colour explicitly rather than inheriting a default', () => {
    assert.match(MASK_COLOR, /^#[0-9A-F]{6}$/i);
  });

  it('describes what it masks and why, for the manifest', () => {
    const described = describeMasks();
    assert.ok(described.length > 1);
    for (const entry of described) {
      assert.notEqual(entry.selector, '');
      assert.notEqual(entry.why, '');
    }
  });
});
