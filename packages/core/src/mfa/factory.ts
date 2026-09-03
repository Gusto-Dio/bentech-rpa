import path from 'node:path';
import type { Logger } from 'pino';
import type { MfaConfig } from '../config/schema.ts';
import type { SecretResolver } from '../secrets.ts';
import { GmailApiMfaProvider } from './GmailApiMfaProvider.ts';
import { GmailUiMfaProvider } from './GmailUiMfaProvider.ts';
import { ManualMfaProvider } from './ManualMfaProvider.ts';
import type { MfaCodeProvider } from './MfaCodeProvider.ts';

/**
 * Builds the MFA provider this environment is configured for.
 *
 * The same shape as the queue factory, for the same reason: an automation asks
 * for "the MFA provider" and never names one, so swapping a persistent Gmail
 * profile for the Gmail API is a config change in one environment file rather
 * than an edit to every automation that signs in to a portal.
 */

export interface CreateMfaProviderOptions {
  config: MfaConfig;
  logger: Logger;
  secrets: SecretResolver;
  /** config.profileDir is relative to this, the way dataDir is. */
  repoRoot: string;
  /** The run's stop signal, so waiting for mail does not hold up SIGTERM. */
  abortSignal?: AbortSignal;
}

export function createMfaProvider(options: CreateMfaProviderOptions): MfaCodeProvider {
  const { config, logger, secrets, repoRoot, abortSignal } = options;
  const signal = abortSignal === undefined ? {} : { abortSignal };

  switch (config.provider) {
    case 'manual':
      return new ManualMfaProvider(logger);

    case 'gmail-cdp':
      return new GmailUiMfaProvider({
        mode: { kind: 'cdp', endpoint: config.cdpEndpoint },
        logger,
        pollIntervalMs: config.pollIntervalMs,
        ...signal,
      });

    case 'gmail-profile':
      return new GmailUiMfaProvider({
        mode: {
          kind: 'profile',
          userDataDir: path.resolve(repoRoot, config.profileDir),
          // Gmail is one of the sites most likely to challenge a headless
          // browser, and this profile only ever runs on a machine with a
          // display anyway.
          headless: false,
        },
        logger,
        pollIntervalMs: config.pollIntervalMs,
        ...signal,
      });

    case 'gmail-api':
      return new GmailApiMfaProvider({
        config: config.gmail,
        secrets,
        logger,
        pollIntervalMs: config.pollIntervalMs,
        ...signal,
      });

    default: {
      // Exhaustiveness, not defence: adding a provider to the enum without a
      // branch here becomes a type error rather than a runtime surprise.
      const unreachable: never = config.provider;
      throw new Error(`Unsupported mfa.provider: ${String(unreachable)}`);
    }
  }
}
