import { BusinessException, type TxContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';
import type { Payload } from './payload.ts';

/** One queue item, start to finish. No browser - this is file, API or database work. */
export async function processTransaction(
  ctx: TxContext<Payload, AutomationConfig>,
): Promise<void> {
  const { recordId, amountCents } = ctx.item.payload;

  // A business rule. The data is well-formed but not acceptable, so no retry
  // could change the outcome.
  if (amountCents === 0) {
    throw new BusinessException(`Record ${recordId} has a zero amount`, {
      details: { recordId },
    });
  }

  ctx.logger.info({ recordId, amountCents }, 'Record processed');
}
