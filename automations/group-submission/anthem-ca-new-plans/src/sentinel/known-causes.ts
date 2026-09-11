import type { KnownCause } from '@rpa/core';
import { OKTA_HOST, PLATFORM_HOST, PORTAL_HOST } from '../pages/portal-origins.ts';

/**
 * Anthem-specific causes, concatenated ahead of `GENERIC_CAUSES`.
 *
 * These name hosts and quote this carrier's exact wording, which is precisely
 * why they cannot live in `packages/core`: the engine is shared by every
 * automation, and a hostname there would be one carrier leaking into all of
 * them.
 *
 * Matching is first-match-wins and carrier rows go first, so anything here
 * pre-empts the generic equivalent. Every row below is a failure this team has
 * already diagnosed once, and the remedy is quoted verbatim into the issue.
 */
export const ANTHEM_CAUSES: readonly KnownCause[] = [
  /**
   * FIRST among the carrier rows, because it is the one most likely to be
   * misread as breakage. drift-log 2026-09-04, third and correct reading: the
   * Salesforce community session expires INDEPENDENTLY of the Producer Toolbox
   * one, and only elapsed time decides whether the hop is challenged. Two
   * earlier diagnoses (a device token bound to the host browser, then the
   * route) were both wrong and are explicitly retracted.
   *
   * `resolveSamlChallenge` already handles it, with the password alone - Okta
   * does not ask for a factor, because the device is trusted. So this is normal
   * operation, not a finding.
   */
  {
    id: 'okta-saml-relapse',
    title: 'The Salesforce community session lapsed and was re-authenticated',
    probes: 'any',
    match: { host: [OKTA_HOST] },
    action: 'none',
    reference: 'docs/poc/anthem-ca-new-plans/drift-log.md, 2026-09-04 (third reading)',
    remedy:
      'Expected, and already handled. The community session expires independently of the portal ' +
      'session and only elapsed time decides whether the SAML hop is challenged; ' +
      'resolveSamlChallenge answers it with the PASSWORD alone - no MFA code, because the device ' +
      'is trusted. Two earlier diagnoses of this (an Okta device token bound to the host browser, ' +
      'then the route) were wrong and are retracted in the drift log. Nothing to fix.',
  },
  {
    id: 'okta-credential-rejected',
    title: 'Okta rejected the password',
    probes: 'any',
    match: { text: [/Unable to sign in/i, /check your credentials/i] },
    action: 'human',
    reference: 'docs/poc/anthem-ca-new-plans/drift-log.md, 2026-09-02 (error region)',
    remedy:
      'Okta renders this in a role="alert" region and it means the credential is wrong or has been ' +
      'rotated - not that the automation is broken. A person must confirm ANTHEM_PORTAL_PASSWORD ' +
      'against the Benefits runbook. Do not retry in a loop: repeated failures are what locks the ' +
      'account.',
  },
  {
    id: 'anthem-account-locked',
    title: 'The Anthem portal account is locked or throttled',
    probes: 'any',
    match: { text: [/locked/i, /too many attempts/i, /temporarily (?:unavailable|suspended)/i] },
    action: 'human',
    reference: 'AGENTS.md rule 1, and _shared/src/carrier-portal-session.ts classifyPortalError',
    remedy:
      'A carrier decision, not a transient fault - which is why it is classified Business and never ' +
      'retried. A person must unlock it with Anthem. Note that a locked account also stops the ' +
      'sentinel from telling you anything else about this portal until it is cleared.',
  },
  /**
   * The `portalUrl` regression, made detectable. drift-log 2026-09-02: the
   * documented sign-in page was `anthem.com/ca/producer/`, which is a MARKETING
   * page - it carries a "Log In" button and no username field at all. That is
   * config drift rather than portal drift, and it is healable.
   */
  {
    id: 'anthem-marketing-page',
    title: 'The configured URL is a marketing page, not the login page',
    probes: 'any',
    match: { host: ['www.anthem.com', 'anthem.com'] },
    action: 'healable',
    reference: 'docs/poc/anthem-ca-new-plans/drift-log.md, 2026-09-02 (portalUrl)',
    remedy:
      `The probe landed on a marketing host rather than ${PORTAL_HOST}. That page has a "Log In" ` +
      'button and no username field, so every locator past it will time out. This has happened ' +
      'before: portalUrl was corrected to the Producer Toolbox login. Check portalUrl in ' +
      'config/config.<env>.json rather than the page objects.',
  },
  {
    id: 'anthem-application-matching-error',
    title: 'The group already has an application in progress',
    probes: 'any',
    match: { text: [/Application Matching Error/i, /inprogressapplication/i] },
    action: 'none',
    reference: 'src/pages/portal-errors.ts readApplicationMatchingError',
    remedy:
      'The portal redirected to /broker/s/inprogressapplication because that group already has an ' +
      'application in progress. A retry gets the same answer until a human finishes or cancels it, ' +
      'which is why it is Business rather than System. Not a code defect.',
  },
  /**
   * The platform host appearing where the portal host was expected, or vice
   * versa. Worth naming because the two quote each other in query strings and a
   * reader who does not know that will chase a locator instead.
   */
  {
    id: 'anthem-wrong-host',
    title: 'The probe is on the quoting platform rather than Producer Toolbox',
    probes: ['anthem-ca/portal-access'],
    match: { host: [PLATFORM_HOST] },
    action: 'healable',
    reference: 'src/pages/login.page.ts isPortalUrl, and AGENTS.md gotchas (URL checks)',
    remedy:
      `The credential-free access probe should only ever see ${PORTAL_HOST}. Landing on ` +
      `${PLATFORM_HOST} means a redirect changed. Parse the URL when checking it - these hosts ` +
      "quote each other inside query strings, so a substring test matches the wrong page in both " +
      'directions, and that has already cost a debugging pass.',
  },
];
