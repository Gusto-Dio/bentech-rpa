import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isPortalUrl } from './login.page.ts';

/**
 * The OAuth hand-back between Anthem's portal and Okta is the one place in this
 * automation where a URL check has to be exact, because the two hosts quote
 * each other in query parameters. A substring test passes for the wrong page in
 * both directions, and it fails silently: the run reports a slow dashboard when
 * it is actually parked on a login screen.
 */
describe('isPortalUrl', () => {
  it('accepts a real portal URL', () => {
    assert.equal(isPortalUrl('https://brokerportal.anthem.com/apps/ptb/'), true);
    assert.equal(isPortalUrl('https://brokerportal.anthem.com/apps/ptb/dashboard/AAAABBBBCC'), true);
  });

  /**
   * THE REGRESSION. Okta's authorize URL carries
   * `redirect_uri=https://brokerportal.anthem.com/apps/ptb/_codexch`, so
   * `/brokerportal\.anthem\.com\/apps\/ptb/` matches it. That made
   * `isMfaRequired` decide the portal had already handed back, skip requesting
   * a code entirely, and leave the run stranded on the Okta screen.
   */
  it('rejects an Okta URL that mentions the portal in its query string', () => {
    const okta =
      'https://login.broker.anthem.com/oauth2/ausho9gifnbTGMMzK4h7/v1/authorize' +
      '?response_type=code&client_id=0oalzpafcysHExgKZ4h7' +
      '&redirect_uri=https://brokerportal.anthem.com/apps/ptb/_codexch' +
      '&origin=/apps/ptb/?utm_source=landing&login_hint=kudosinsurance';

    assert.equal(isPortalUrl(okta), false);
  });

  it('rejects the portal login page, which is not signed in', () => {
    assert.equal(
      isPortalUrl('https://brokerportal.anthem.com/apps/ptb/login?site=fullsite&brand=ABC', '/apps/ptb/dashboard'),
      false,
    );
  });

  it('honours a narrower path prefix', () => {
    const dashboard = 'https://brokerportal.anthem.com/apps/ptb/dashboard/AAAABBBBCC';
    assert.equal(isPortalUrl(dashboard, '/apps/ptb/dashboard'), true);
    assert.equal(isPortalUrl(dashboard, '/apps/ptb/quotes'), false);
  });

  it('rejects a look-alike host rather than matching on a suffix', () => {
    assert.equal(isPortalUrl('https://evil-brokerportal.anthem.com.example/apps/ptb/'), false);
  });

  it('returns false for anything unparseable instead of throwing', () => {
    assert.equal(isPortalUrl('not a url'), false);
    assert.equal(isPortalUrl(''), false);
  });
});

/**
 * `Create Quote` hands off to the Salesforce platform through Okta SAML, and
 * that hop was observed landing back on Okta with a Password field instead of
 * the platform. The host check that catches it must be parsed, not
 * pattern-matched, for the same reason `isPortalUrl` must be: the two hosts
 * quote each other in query strings, so a substring test matches the wrong page
 * in both directions.
 */
describe('the Create Quote SAML guard', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'quote-start.page.ts'), 'utf8');
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('parses the URL rather than matching the whole string', () => {
    assert.match(body, /new URL\(url\)\.host/);
  });

  /**
   * It tries to RECOVER before failing. A SystemException here relaunches the
   * browser, re-runs initialize() and retries the whole transaction - which
   * creates a second real quote for the same group. Answering the password is
   * cheaper by every measure, and costs no MFA code.
   */
  it('attempts recovery before throwing', () => {
    const guard = body.slice(body.indexOf('OKTA_HOST)'));
    assert.match(guard.slice(0, 900), /resolveSaml/);
  });

  it('still classifies an unrecovered re-challenge as System, not Business', () => {
    const guard = body.slice(body.indexOf('OKTA_HOST)'));
    assert.match(guard.slice(0, 900), /SystemException/);
    assert.doesNotMatch(guard.slice(0, 900), /BusinessException/);
  });
});
