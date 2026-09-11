import type { CarrierPortalSession } from '@auto/group-submission-shared';
import { createMfaProvider, type WebInitContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';
import { createUhcSession } from './session.ts';

/**
 * REFramework's InitAllSettings + InitAllApplications for UHC SAMx.
 *
 * MUST be idempotent: the runner calls this again after every session
 * recovery, and a recovered browser is a brand new browser with no portal
 * cookies. The session helper handles that - it probes a stored session and
 * only performs a full login (and consumes an MFA code) when the probe fails.
 */
export async function initialize(ctx: WebInitContext<AutomationConfig>): Promise<void> {
  const { portalUrl } = ctx.config.automation;

  /**
   * Whether the code comes from a stdin prompt, a seeded Gmail profile, the
   * Gmail API or IMAP is environment configuration (mfa.provider), never a
   * decision made here - which is what lets the same automation run attended in
   * dev and unattended in production.
   *
   * Hoisted so this function owns its lifetime. See the finally below.
   */
  const mfa = createMfaProvider({
    config: ctx.config.mfa,
    logger: ctx.logger,
    secrets: ctx.secrets,
    repoRoot: ctx.paths.repoRoot,
    abortSignal: ctx.stop.abortSignal,
  });

  const session: CarrierPortalSession = createUhcSession({
    config: ctx.config.automation,
    secrets: ctx.secrets,
    mfa,
    logger: ctx.logger,
    dataDir: ctx.paths.dataDir,
  });

  let outcome;
  try {
    outcome = await session.ensureSignedIn(ctx.page, ctx.page.context());
  } finally {
    /**
     * Always release the mailbox browser, even when sign-in failed.
     *
     * The gmail-profile provider holds a lock on its persistent profile
     * directory for as long as its browser lives. Leaving it open after a
     * failed run means the NEXT run cannot open the profile at all and dies
     * with "the profile is already in use by another instance of Chromium" -
     * a failure that has nothing to do with the actual problem and buries it.
     * It is only needed while signing in, so it is closed the moment that is
     * over.
     */
    await mfa.close?.();
  }

  // Whether MFA was consumed is worth knowing: it is the rate-limited resource.
  ctx.logger.info(
    { portalUrl, signedInVia: outcome.how, hadStoredSession: outcome.hadStoredSession },
    'Signed in to the UHC SAMx portal',
  );

  ctx.state.set('carrierSession', session);
}
