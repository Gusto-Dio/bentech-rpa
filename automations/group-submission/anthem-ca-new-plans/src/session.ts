import { createCarrierPortalSession, type CarrierPortalSession } from '@auto/group-submission-shared';
import type { Logger, MfaCodeProvider, MfaMatcher, SecretResolver } from '@rpa/core';
import path from 'node:path';
import type { AutomationConfig } from './config.ts';
import { AnthemLoginPage } from './pages/login.page.ts';

/**
 * How this automation signs in to Anthem, in one place.
 *
 * Extracted because it was being rebuilt: `initialize.ts` had it, and then the
 * `check-portal-navigation.ts` diagnostic grew a third copy of the same
 * `MfaMatcher` literal, the same `createCarrierPortalSession(...)` call and the
 * same storage-state path. A diagnostic that reconstructs the sign-in it is
 * meant to verify proves less the moment the two drift - and the copy most
 * likely to be forgotten is the one in `tooling/`.
 *
 * The MFA provider is passed in rather than built here because its LIFETIME
 * belongs to the caller: it holds a mailbox lock (the gmail-profile provider
 * holds a persistent Chromium profile) and has to be closed the moment sign-in
 * is over, which only the caller knows.
 */
export interface AnthemSessionOptions {
  config: AutomationConfig;
  secrets: SecretResolver;
  mfa: MfaCodeProvider;
  logger: Logger;
  /** `ctx.paths.dataDir`, or the resolved equivalent in a script. */
  dataDir: string;
}

export function createAnthemSession(options: AnthemSessionOptions): CarrierPortalSession {
  const { config, secrets, mfa, logger, dataDir } = options;

  const matcher: MfaMatcher = {
    label: config.mfaLabel,
    fromAllowList: config.mfaSenderAllowList,
    // Confirmed six digits against live codes read from the real mailbox.
    codePattern: /\b(\d{6})\b/,
    /**
     * Anthem's MFA screen states the subject verbatim, so this is evidence
     * rather than a guess. Omitted keys stay absent - a spread keeps the shape
     * honest whether or not exactOptionalPropertyTypes is on.
     */
    ...(config.mfaSubjectContains === undefined
      ? {}
      : { subjectContains: config.mfaSubjectContains }),
  };

  return createCarrierPortalSession({
    carrier: 'anthem-ca',
    loginUrl: config.portalUrl,
    usernameEnv: config.usernameEnv,
    passwordEnv: config.passwordEnv,
    secrets,
    mfa,
    mfaMatcher: matcher,
    mfaTimeoutMs: config.mfaTimeoutMs,
    ...(config.mfaResendAfterMs === undefined ? {} : { mfaResendAfterMs: config.mfaResendAfterMs }),
    ...(config.mfaMaxResends === undefined ? {} : { mfaMaxResends: config.mfaMaxResends }),
    storageStatePath: path.join(dataDir, 'sessions', 'anthem-ca.json'),
    login: new AnthemLoginPage(config),
    logger,
  });
}
