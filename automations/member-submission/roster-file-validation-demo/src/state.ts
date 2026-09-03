import { SystemException, type InitContext, type TxContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';
import type { Payload } from './payload.ts';

/**
 * Typed access to ctx.state.
 *
 * ctx.state is a Map<string, unknown> because the framework cannot know what an
 * automation wants to cache. Rather than casting at every read site, each
 * automation wraps it once - and the runtime check below means a missing entry
 * fails with "the catalog was not initialised" instead of a downstream
 * TypeError that says nothing about the cause.
 */
const PLAN_CODES = 'planCodes';

export function setPlanCodes(
  ctx: InitContext<AutomationConfig>,
  planCodes: ReadonlySet<string>,
): void {
  ctx.state.set(PLAN_CODES, planCodes);
}

export function getPlanCodes(
  ctx: TxContext<Payload, AutomationConfig>,
): ReadonlySet<string> {
  const value = ctx.state.get(PLAN_CODES);
  if (!(value instanceof Set)) {
    throw new SystemException(
      'Plan catalog is missing from run state - initialize() did not complete',
    );
  }
  return value as ReadonlySet<string>;
}
