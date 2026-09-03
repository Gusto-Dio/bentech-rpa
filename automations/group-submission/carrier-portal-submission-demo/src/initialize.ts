import { PortalLoginPage } from '@auto/group-submission-shared';
import type { WebInitContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';

/**
 * REFramework's InitAllSettings + InitAllApplications.
 *
 * MUST be idempotent, and here is exactly why: the runner calls this again
 * after every session.recover(). A recovered browser is a brand new browser
 * with no cookies, so the automation has to sign in again. If this function
 * assumed it only ever ran once, the first retry would run against a signed-out
 * portal and fail for a completely different reason than the original error.
 */
export async function initialize(ctx: WebInitContext<AutomationConfig>): Promise<void> {
  const { portalUrl, usernameEnv, passwordEnv } = ctx.config.automation;

  // Credentials come from the secret provider (env today, a vault later), so a
  // missing one is a SystemException that aborts before any group is touched.
  const username = await ctx.secrets.require(usernameEnv);
  const password = await ctx.secrets.require(passwordEnv);

  const login = new PortalLoginPage(ctx.page);
  await login.open(portalUrl);
  await login.signIn(username, password);

  ctx.logger.info(
    { portalUrl, credentialSource: ctx.secrets.providerName },
    'Signed in to the carrier portal',
  );
}
