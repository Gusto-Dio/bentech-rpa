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

  /**
   * The happy path GOES THROUGH Okta: an auto-posting intermediate document
   * bounces the browser on to the platform. So the host alone proves nothing,
   * and deciding on it right after `domcontentloaded` would fail runs that were
   * fine. A visible passcode field is what distinguishes a challenge.
   */
  it('requires a visible passcode field, not merely an Okta URL', () => {
    assert.match(body, /OKTA_PASSCODE_FIELD/);
    assert.match(body, /state:\s*'visible'/);
  });

  it('races leaving Okta against being challenged, so neither has to time out', () => {
    assert.match(body, /Promise\.race/);
  });

  it('shares the Okta host with login.page.ts rather than duplicating the literal', () => {
    assert.doesNotMatch(body, /'login\.broker\.anthem\.com'/);
    assert.match(body, /OKTA_HOST/);
  });

  it('attempts recovery before giving up', () => {
    assert.match(body, /resolveSaml\?\.\(/);
  });

  /**
   * BUSINESS, and this reverses an earlier version of this test.
   *
   * By the time the guard fails, `Create Quote` has already created a REAL
   * quote. A SystemException is retryable, and the runner's recovery re-runs
   * the whole transaction - re-clicking `Create Quote` and creating a SECOND
   * quote for the same group, which then hits Anthem's "Application Matching
   * Error" and fails anyway. That is the pathology behind this PoC's production
   * cleanup list, so the item fails terminally instead.
   */
  it('fails an unrecovered hand-off as Business, because a retry would duplicate the quote', () => {
    const guard = body.slice(body.indexOf('#handOffFailed(because'));
    assert.match(guard.slice(0, 700), /BusinessException/);
    assert.doesNotMatch(guard.slice(0, 700), /SystemException/);
  });

  it('says in the message that a quote already exists', () => {
    assert.match(source, /ALREADY been created/);
  });
});
