import type { WebInitContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';
import { ExamplePage } from './pages/example.page.ts';

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

  const page = new ExamplePage(ctx.page);
  await page.open(appUrl);
  await page.signIn(username, password);

  ctx.logger.info({ appUrl }, 'Signed in and ready');
}
