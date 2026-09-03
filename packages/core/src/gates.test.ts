import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hidden, valueIs, visible } from './gates.ts';
import type { Locator } from 'playwright';

/**
 * A locator that resolves or rejects on a schedule, so the waiting behaviour can
 * be asserted without a browser. Playwright's Locator surface is enormous and
 * these helpers touch four members of it, so the stub is cast rather than
 * implemented.
 */
function fakeLocator(options: {
  appearsAfterMs?: number;
  never?: boolean;
  value?: string;
}): { locator: Locator; waitCalls: number } {
  const state = { waitCalls: 0 };
  const self = {
    first: () => self,
    waitFor: async ({ timeout }: { state?: string; timeout: number }) => {
      state.waitCalls += 1;
      if (options.never === true) {
        await new Promise((resolve) => setTimeout(resolve, timeout));
        throw new Error('Timeout exceeded');
      }
      const delay = options.appearsAfterMs ?? 0;
      if (delay > timeout) {
        await new Promise((resolve) => setTimeout(resolve, timeout));
        throw new Error('Timeout exceeded');
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
    inputValue: async () => options.value ?? '',
  };
  return { locator: self as unknown as Locator, waitCalls: state.waitCalls };
}

describe('visible', () => {
  /**
   * The whole reason this module exists. isVisible() answers "is it there right
   * now", which against an SPA mid-render is reliably "no" - that is what failed
   * the Anthem stage-2 precondition on a page that was merely still loading.
   */
  it('waits for an element that has not rendered yet', async () => {
    const { locator } = fakeLocator({ appearsAfterMs: 40 });
    assert.equal(await visible(locator, 500), true);
  });

  it('returns false rather than throwing when the element never appears', async () => {
    const { locator } = fakeLocator({ never: true });
    assert.equal(await visible(locator, 20), false);
  });

  it('gives up at the budget instead of waiting indefinitely', async () => {
    const { locator } = fakeLocator({ appearsAfterMs: 10_000 });
    const startedAt = Date.now();
    assert.equal(await visible(locator, 30), false);
    assert.ok(Date.now() - startedAt < 1_000, 'must not wait past its own timeout');
  });
});

describe('hidden', () => {
  it('is satisfied when the element goes away', async () => {
    const { locator } = fakeLocator({ appearsAfterMs: 5 });
    assert.equal(await hidden(locator, 200), true);
  });

  it('is false when the element stays put', async () => {
    const { locator } = fakeLocator({ never: true });
    assert.equal(await hidden(locator, 20), false);
  });
});

describe('valueIs', () => {
  it('reads the value back rather than trusting the fill', async () => {
    const { locator } = fakeLocator({ value: '94107' });
    assert.equal(await valueIs(locator, '94107', 200), true);
  });

  it('tolerates surrounding whitespace on both sides', async () => {
    const { locator } = fakeLocator({ value: '  94107 ' });
    assert.equal(await valueIs(locator, '94107', 200), true);
  });

  it('is false when the portal reformatted or dropped the input', async () => {
    const { locator } = fakeLocator({ value: '94107-1234' });
    assert.equal(await valueIs(locator, '94107', 200), false);
  });

  /** A field that never renders cannot hold the value, and must not throw. */
  it('is false when the field is absent', async () => {
    const { locator } = fakeLocator({ never: true });
    assert.equal(await valueIs(locator, '94107', 20), false);
  });
});
