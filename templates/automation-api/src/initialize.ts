import type { InitContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';

/**
 * REFramework's InitAllSettings. There is no application to start, because
 * automation.json declares sessionKind "none".
 *
 * MUST be idempotent: the runner re-invokes it after a System exception, and
 * anything cached in ctx.state has to tolerate being recomputed.
 *
 * Reference data belongs here rather than in processTransaction: loading it once
 * per run instead of once per transaction is the difference between one read
 * and ten thousand.
 */
export async function initialize(ctx: InitContext<AutomationConfig>): Promise<void> {
  ctx.state.set('startedAt', new Date().toISOString());
  ctx.logger.info({ inputFile: ctx.config.automation.inputFile }, 'Initialised (no browser)');
}
