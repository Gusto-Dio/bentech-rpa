import { defineWebAutomation } from '@rpa/core';
import { automationConfigSchema, type AutomationConfig } from './config.ts';
import { endProcess } from './endProcess.ts';
import { initialize } from './initialize.ts';
import { parsePayload, type Payload } from './payload.ts';
import { processTransaction } from './processTransaction.ts';

/**
 * UHC New Plans (group-submission/uhc-np-new-plans)
 *
 * defineWebAutomation is used instead of defineAutomation because
 * automation.json declares sessionKind "browser". That is what gives ctx.page a
 * non-optional type, so no step in this automation needs a null check or a cast.
 */
export default defineWebAutomation<Payload, AutomationConfig>({
  configSchema: automationConfigSchema,
  parsePayload,
  initialize,
  processTransaction,
  endProcess,
});
