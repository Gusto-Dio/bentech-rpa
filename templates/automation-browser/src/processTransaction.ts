import { BusinessException, type WebTxContext } from '@rpa/core';
import type { AutomationConfig } from './config.ts';
import { ExamplePage } from './pages/example.page.ts';
import type { Payload } from './payload.ts';

/**
 * One transaction. Exactly one queue item, start to finish.
 *
 * Throw BusinessException when the data or the rules say no - it will be marked
 * failed with no retry. Throw anything else, or let an error escape, and the
 * framework treats it as a System exception: screenshot, trace, session
 * recovery, retry.
 */
export async function processTransaction(
  ctx: WebTxContext<Payload, AutomationConfig>,
): Promise<void> {
  const { recordId, displayName } = ctx.item.payload;
  const page = new ExamplePage(ctx.page);

  ctx.logger.debug({ recordId }, 'Submitting record');

  const confirmation = await page.submitRecord(recordId);

  // A business rule: the portal accepted the request but declined the record.
  // No amount of retrying changes that answer.
  if (confirmation.toLowerCase().includes('rejected')) {
    throw new BusinessException(`Portal rejected ${displayName}`, {
      details: { recordId, confirmation },
    });
  }

  ctx.logger.info({ recordId, confirmation }, 'Record submitted');
}
