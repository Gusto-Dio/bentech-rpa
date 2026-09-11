import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isReconOrigin, PORTAL_HOST, RECON_HOSTS } from './portal-origins.ts';

describe('isReconOrigin', () => {
  it('allows the portal host', () => {
    assert.equal(isReconOrigin(`https://${PORTAL_HOST}/employer/`), true);
  });

  it('refuses a host it does not know', () => {
    assert.equal(isReconOrigin('https://example.invalid/'), false);
  });

  /**
   * The two mistakes a substring or suffix test makes. Both are real shapes: an
   * identity provider carries the portal host inside `redirect_uri`, and a
   * lookalike domain is the cheapest way to point a credentialled browser
   * somewhere else.
   */
  it('refuses a foreign host that merely mentions the portal in its query string', () => {
    assert.equal(isReconOrigin(`https://evil.example/?redirect_uri=https://${PORTAL_HOST}/apps`), false);
  });

  it('refuses a lookalike host that only ends with the portal host', () => {
    assert.equal(isReconOrigin(`https://evil-${PORTAL_HOST}.example/`), false);
    assert.equal(isReconOrigin(`https://${PORTAL_HOST}.example/`), false);
  });

  /** A credentialled browser must not be talked into reading the local disk. */
  it('refuses non-http schemes', () => {
    assert.equal(isReconOrigin(`file:///etc/passwd`), false);
    assert.equal(isReconOrigin(`javascript:alert(1)`), false);
  });

  it('refuses something that is not a url at all', () => {
    assert.equal(isReconOrigin('not a url'), false);
    assert.equal(isReconOrigin(''), false);
  });

  /**
   * A port is part of the host, so a different port is a different origin. This
   * keeps the fence honest if the portal is ever proxied locally.
   */
  it('treats a different port as a different origin', () => {
    assert.equal(isReconOrigin(`https://${PORTAL_HOST}:8443/`), false);
  });

  it('starts as a list, so a second host does not need a refactor', () => {
    assert.ok(Array.isArray(RECON_HOSTS));
    assert.ok(RECON_HOSTS.includes(PORTAL_HOST));
  });
});

/**
 * Source-text assertions, because the alternative needs a signed-in production
 * browser. `login.page.test.ts` in the Anthem automation uses the same
 * technique for the same reason.
 */
describe('the signed-in landmark', () => {
  const read = (file: string): string =>
    readFileSync(path.join(import.meta.dirname, file), 'utf8')
      // The comments quote the literal these tests forbid, so they are stripped
      // before matching - otherwise the explanation fails the rule it explains.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

  /**
   * Three places ask "are we signed in?": the stored-session probe, the
   * post-login wait, and the dashboard step. Two copies of the literal would
   * let arrival and departure disagree the moment UHC renames the tile, and the
   * failure would look like a broken locator in whichever half was missed.
   */
  for (const file of ['login.page.ts', 'case-start.page.ts']) {
    it(`${file} shares the landmark rather than duplicating the literal`, () => {
      const body = read(file);
      assert.doesNotMatch(body, /Small Group Quoting/, 'use SIGNED_IN_LANDMARK, not a second copy');
      assert.match(body, /SIGNED_IN_LANDMARK/);
    });
  }

  /**
   * `probeSignedIn` is consumed as a step() POSTCONDITION by
   * createCarrierPortalSession, so a non-waiting check there does not merely
   * fail - it takes the full login branch and spends an MFA code on a session
   * that was alive. AGENTS.md rule 9b.
   */
  it('probes the stored session with a waiting gate, not isVisible()', () => {
    const body = read('login.page.ts');
    const probe = body.slice(body.indexOf('async probeSignedIn'), body.indexOf('async enterCredentials'));
    assert.doesNotMatch(probe, /isVisible/, 'probeSignedIn is a gate; it must wait');
    assert.match(probe, /visible\(/);
  });
});
