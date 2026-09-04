import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { checkHeadless } from './doctor.ts';

/**
 * The first test under `packages/cli`, and it earns its place: `HEADLESS=false`
 * stopped being a developer-only setting the moment a carrier forced it. Anthem
 * serves `Access Denied` to headless Chromium, so the automation that most needs
 * to run unattended is the one that must run headed - and whether that works is
 * decided not by the flag but by whether this machine can give Chromium a
 * display.
 *
 * Getting the classification wrong is costly in both directions: a false `pass`
 * lets a server start a run that cannot open a browser, and a false `fail`
 * blocks a laptop that was fine.
 */

const ORIGINAL_HEADLESS = process.env['HEADLESS'];
const ORIGINAL_DISPLAY = process.env['DISPLAY'];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('HEADLESS', ORIGINAL_HEADLESS);
  restore('DISPLAY', ORIGINAL_DISPLAY);
});

describe('checkHeadless', () => {
  it('passes when HEADLESS is unset, the safe server default', () => {
    delete process.env['HEADLESS'];
    const check = checkHeadless();
    assert.equal(check.level, 'pass');
    assert.match(check.detail, /default \(true\)/);
  });

  it('passes an explicit true', () => {
    process.env['HEADLESS'] = 'true';
    assert.equal(checkHeadless().level, 'pass');
  });

  /**
   * Only Linux can be displayless, so the platform branch answers first there.
   * On macOS the reason given is the platform itself, and that is right: a
   * stray DISPLAY from XQuartz says nothing about whether Chromium can open a
   * window, because it uses the native window server regardless.
   */
  it('passes HEADLESS=false when a display is available', () => {
    process.env['HEADLESS'] = 'false';
    process.env['DISPLAY'] = ':0';

    const check = checkHeadless();

    assert.equal(check.level, 'pass');
    assert.match(
      check.detail,
      process.platform === 'linux' ? /DISPLAY=:0/ : new RegExp(process.platform),
    );
  });

  /**
   * The case the rewrite exists for. On Linux with no DISPLAY and no xvfb-run,
   * Chromium cannot start at all - so this is a `fail`, not a warning, and the
   * message has to name the fix rather than the symptom.
   */
  it('is decisive about HEADLESS=false on Linux with no display', () => {
    process.env['HEADLESS'] = 'false';
    delete process.env['DISPLAY'];

    const check = checkHeadless();

    if (process.platform === 'linux') {
      // xvfb-run is installed in the container image, absent on a bare host.
      assert.ok(['pass', 'fail'].includes(check.level));
      if (check.level === 'fail') {
        assert.match(check.detail, /xvfb/, 'the message must name the fix');
      } else {
        assert.match(check.detail, /xvfb-run is available/);
      }
      return;
    }

    /**
     * macOS and Windows always have a window server, so headed is fine there.
     * Asserting this from a Mac is the point: it is where the old version's
     * "would fail on a headless server" warning was most misleading.
     */
    assert.equal(check.level, 'pass');
    assert.match(check.detail, new RegExp(process.platform));
  });
});
