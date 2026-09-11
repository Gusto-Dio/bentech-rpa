import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { OKTA_HOST, PLATFORM_HOST, PORTAL_HOST, RECON_HOSTS, isReconOrigin } from './portal-origins.ts';

/**
 * The reconnaissance harness drives a browser holding a live production broker
 * session. Its navigation fence is therefore a security control, not a
 * convenience, and it fails in the same way `isPortalUrl` failed: a substring
 * test says yes to a URL that merely MENTIONS an allowed host.
 */
describe('isReconOrigin', () => {
  it('accepts the three Anthem hosts the harness legitimately visits', () => {
    assert.equal(isReconOrigin(`https://${PORTAL_HOST}/apps/ptb/`), true);
    assert.equal(isReconOrigin(`https://${OKTA_HOST}/oauth2/x/v1/authorize`), true);
    assert.equal(isReconOrigin(`https://${PLATFORM_HOST}/broker/s/createquote`), true);
  });

  /**
   * THE REGRESSION THIS FENCE EXISTS FOR, in the direction that matters here.
   * Okta's authorize URL carries
   * `redirect_uri=https://brokerportal.anthem.com/apps/ptb/_codexch` in its
   * query string - the exact URL from login.page.test.ts. A substring check
   * against the allow-list would therefore approve ANY host that appends an
   * allowed one as a parameter.
   */
  it('does not approve a foreign host that merely quotes an allowed one', () => {
    const smuggled =
      'https://evil.example/collect' +
      '?redirect_uri=https://brokerportal.anthem.com/apps/ptb/_codexch' +
      /**
       * `login_hint` is SYNTHETIC here. The captured URL carried the real
       * portal username, which is half of a licensed producer's credential and
       * has no business in a tracked file (rule 3). The trap this test exists
       * for is the `redirect_uri` query parameter quoting the portal host, and
       * that is unaffected by the hint.
       */
      '&origin=/apps/ptb/?utm_source=landing&login_hint=a-producer-username';

    assert.equal(isReconOrigin(smuggled), false);
  });

  /** `endsWith` would accept this. The host must match exactly. */
  it('rejects a look-alike host rather than matching on a suffix', () => {
    assert.equal(isReconOrigin('https://evil-brokerportal.anthem.com.example/apps/ptb/'), false);
    assert.equal(isReconOrigin(`https://${PORTAL_HOST}.evil.example/apps/ptb/`), false);
  });

  it('rejects a subdomain that was never allow-listed', () => {
    assert.equal(isReconOrigin('https://mail.anthem.com/'), false);
    assert.equal(isReconOrigin('https://anthem.com/'), false);
  });

  /**
   * `about:blank` and `file:` are "not an allowed host" too, and a fresh popup
   * is `about:blank` at its first `domcontentloaded` - the same fact that once
   * let the SAML guard report success on the case it exists to catch.
   */
  it('requires an http(s) scheme', () => {
    assert.equal(isReconOrigin('about:blank'), false);
    assert.equal(isReconOrigin(`file:///etc/passwd`), false);
    assert.equal(isReconOrigin(`javascript:alert(1)`), false);
    assert.equal(isReconOrigin(`data:text/html,<h1>x</h1>`), false);
  });

  it('returns false for anything unparseable instead of throwing', () => {
    assert.equal(isReconOrigin('not a url'), false);
    assert.equal(isReconOrigin(''), false);
    assert.equal(isReconOrigin(`//${PORTAL_HOST}/apps/ptb/`), false);
  });

  it('allow-lists exactly the three hosts, so widening it is a visible diff', () => {
    assert.deepEqual([...RECON_HOSTS], [PORTAL_HOST, OKTA_HOST, PLATFORM_HOST]);
  });
});

/**
 * The fence is only worth anything if the harness actually consults it. These
 * read the scripts as text, the same technique `login.page.test.ts` uses on
 * `quote-start.page.ts` - and for the same reason: exercising the real code
 * path needs a signed-in production browser, so the property has to be pinned
 * statically or not at all.
 */
describe('the reconnaissance harness honours the fence', () => {
  const scripts = path.join(import.meta.dirname, '..', '..', '..', '..', '..', 'tooling', 'scripts');
  const read = (file: string): string => readFileSync(path.join(scripts, file), 'utf8');
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('gates anthem-recon.ts\'s navigate command on isReconOrigin', () => {
    const body = strip(read('anthem-recon.ts'));
    const branch = body.slice(body.indexOf("answer.startsWith('u ')"));
    const upToGoto = branch.slice(0, branch.indexOf('page.goto'));

    assert.match(upToGoto, /isReconOrigin/, 'the fence must be checked BEFORE the goto');
    assert.match(upToGoto, /return/, 'a refused target must not fall through to the goto');
  });

  /**
   * A URL argument here was an egress path for anything able to spawn the
   * script, because this process is what attaches the credentials.
   */
  it('gives anthem-serve.ts no way to be pointed somewhere else', () => {
    const body = strip(read('anthem-serve.ts'));
    assert.doesNotMatch(body, /process\.argv/);
  });

  it('keeps the host literals in one place', () => {
    assert.doesNotMatch(strip(read('anthem-serve.ts')), /'https:\/\/brokerportal\.anthem\.com/);
    assert.doesNotMatch(strip(read('check-portal-navigation.ts')), /'elevancehealthfulcrum\.my\.site\.com'/);
  });
});
