import type { WebInitContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';
import { BrokerPortalPage } from './pages/broker-portal.page.ts';

/**
 * REFramework's InitAllSettings + InitAllApplications.
 *
 * MUST be idempotent. It runs once at startup and again after every session
 * recovery, because a recovered browser is a brand new browser that is no
 * longer signed in. Anything cached in ctx.state must tolerate being recomputed.
 */
export async function initialize(ctx: WebInitContext<AutomationConfig>): Promise<void> {
  const { appUrl, usernameEnv, passwordEnv } = ctx.config.automation;

  // Values come from the secret provider, never from config. A missing
  // credential is a SystemException and aborts before any transaction is
  // touched - which is the correct outcome for a misconfigured environment.
  const username = await ctx.secrets.require(usernameEnv);
  const password = await ctx.secrets.require(passwordEnv);

  const portal = new BrokerPortalPage(ctx.page);
  await portal.open(appUrl);
  await portal.signIn(username, password);

  // BlueQuote opens a second tab; processTransaction needs it, so it goes
  // in ctx.state - the scratch space that lives for the whole run.
  const quotePage = await portal.openBlueQuote();
  ctx.state.set('quotePage', quotePage);

  ctx.logger.info({ appUrl }, 'Signed in to the BCBS MA broker portal');
}
