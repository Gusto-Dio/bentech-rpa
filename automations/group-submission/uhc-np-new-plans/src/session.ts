import { createCarrierPortalSession, type CarrierPortalSession } from '@auto/group-submission-shared';
import type { Logger, MfaCodeProvider, MfaMatcher, SecretResolver } from '@rpa/core';
import path from 'node:path';
import type { AutomationConfig } from './config.ts';
import { UhcLoginPage } from './pages/login.page.ts';

/** Where the reused storage state lives, relative to `dataDir`. */
export const UHC_SESSION_FILE = path.join('sessions', 'uhc.json');

/**
 * How this automation signs in to UHC SAMx, in one place.
 *
 * Extracted before it could be rebuilt. Anthem's equivalent grew three copies of
 * the same `MfaMatcher` literal, the same `createCarrierPortalSession(...)` call
 * and the same storage-state path - one in `initialize.ts` and two in
 * `tooling/`. A diagnostic that reconstructs the sign-in it is meant to verify
 * proves less the moment the two drift, and the copy most likely to be
 * forgotten is the one in `tooling/`. The recon harness added alongside this
 * needs exactly this builder, so it is a seam from the outset.
 *
 * The MFA provider is passed in rather than built here because its LIFETIME
 * belongs to the caller: it holds a mailbox lock (the gmail-profile provider
 * holds a persistent Chromium profile) and has to be closed the moment sign-in
 * is over, which only the caller knows.
 */
export interface UhcSessionOptions {
  config: AutomationConfig;
  secrets: SecretResolver;
  mfa: MfaCodeProvider;
  logger: Logger;
  /** `ctx.paths.dataDir`, or the resolved equivalent in a script. */
  dataDir: string;
}

export function createUhcSession(options: UhcSessionOptions): CarrierPortalSession {
  const { config, secrets, mfa, logger, dataDir } = options;

  const matcher: MfaMatcher = {
    label: config.mfaLabel,
    /**
     * There is no `uhc.com` sender at all. The codes are TEXT MESSAGES that
     * Google Voice forwards into the label as email, plus an internal forward
     * from carrierops@gusto.com - see drift-log.md, entries 1 and 2. The
     * original allow-list named UHC's own domains and therefore matched
     * nothing, which would have rejected every code that ever arrived.
     */
    fromAllowList: config.mfaSenderAllowList,
    // TODO(remap): unverified. No UHC code has been read end to end yet, so the
    // six-digit assumption comes from Anthem's codes, not from UHC's.
    codePattern: /\b(\d{6})\b/,
  };

  return createCarrierPortalSession({
    carrier: 'uhc',
    loginUrl: config.portalUrl,
    usernameEnv: config.usernameEnv,
    passwordEnv: config.passwordEnv,
    secrets,
    mfa,
    mfaMatcher: matcher,
    /**
     * Not re-tuned. Anthem's timeouts "were tuned twice against a broken
     * reader and both readings were wrong", and its codes
     * actually arrive in 10-26 seconds. Whatever this value should be, it is not
     * something to guess at before a single UHC code has been observed.
     */
    mfaTimeoutMs: config.mfaTimeoutMs,
    storageStatePath: path.join(dataDir, UHC_SESSION_FILE),
    login: new UhcLoginPage(config),
    logger,
  });
}
