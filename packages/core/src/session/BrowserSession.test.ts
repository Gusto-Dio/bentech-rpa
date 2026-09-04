import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowserConfig } from '../config/schema.ts';
import { chromiumLaunchOptions } from './BrowserSession.ts';

/**
 * The `noSandbox` branch is the one place in this translation where getting it
 * wrong is a security decision rather than a bug: disabling Chromium's sandbox
 * hands a compromised page the container's privileges. It is also the branch
 * that had already drifted - two diagnostic scripts each carried their own copy
 * of this mapping and added `--no-sandbox` WITHOUT `--disable-setuid-sandbox`,
 * so a check meant to launch "the browser a run launches" did not.
 *
 * One definition now, and these pin its contract.
 */

function config(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
  return {
    headless: true,
    slowMoMs: 0,
    noSandbox: false,
    args: [],
    recordVideo: false,
    viewport: { width: 1440, height: 900 },
    ...overrides,
  } as BrowserConfig;
}

describe('chromiumLaunchOptions', () => {
  it('carries headless and slowMo through unchanged', () => {
    const options = chromiumLaunchOptions(config({ headless: false, slowMoMs: 250 }));
    assert.equal(options.headless, false);
    assert.equal(options.slowMo, 250);
  });

  it('adds no sandbox flags by default, which is what keeps the sandbox on', () => {
    assert.deepEqual(chromiumLaunchOptions(config()).args, []);
  });

  /**
   * BOTH flags. `--no-sandbox` alone leaves the setuid sandbox helper in play,
   * which is the drift that made the scripts differ from a real run.
   */
  it('adds both sandbox flags when noSandbox is set', () => {
    const args = chromiumLaunchOptions(config({ noSandbox: true })).args;
    assert.deepEqual(args, ['--no-sandbox', '--disable-setuid-sandbox']);
  });

  it('appends the sandbox flags after configured args rather than replacing them', () => {
    const args = chromiumLaunchOptions(config({ noSandbox: true, args: ['--lang=en-GB'] })).args;
    assert.deepEqual(args, ['--lang=en-GB', '--no-sandbox', '--disable-setuid-sandbox']);
  });

  /**
   * The returned array must not alias the config's, or one launch mutating its
   * args would change the configuration every later launch reads.
   */
  it('does not mutate the configured args', () => {
    const base = config({ noSandbox: true, args: ['--lang=en-GB'] });
    chromiumLaunchOptions(base);
    assert.deepEqual(base.args, ['--lang=en-GB']);
  });
});
