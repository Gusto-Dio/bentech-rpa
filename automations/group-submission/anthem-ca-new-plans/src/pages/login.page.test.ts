import assert from 'node:assert/strict';
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
