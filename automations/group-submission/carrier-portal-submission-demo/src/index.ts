import { defineWebAutomation } from '@rpa/core';
import { automationConfigSchema, type AutomationConfig } from './config.ts';
import { endProcess } from './endProcess.ts';
import { initialize } from './initialize.ts';
import { parsePayload, type Payload } from './payload.ts';
import { processTransaction } from './processTransaction.ts';

/**
 * Carrier Portal Submission (demo)
 *
 * defineWebAutomation, matching sessionKind "browser" in automation.json. That
 * pairing is what makes ctx.page a non-optional Page, so nothing in this
 * automation needs a null check or a cast.
 */
export default defineWebAutomation<Payload, AutomationConfig>({
  configSchema: automationConfigSchema,
  parsePayload,
  initialize,
  processTransaction,
  endProcess,
});
