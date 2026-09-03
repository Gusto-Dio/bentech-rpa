import { defineAutomation } from '@rpa/core';
import { automationConfigSchema, type AutomationConfig } from './config.ts';
import { endProcess } from './endProcess.ts';
import { initialize } from './initialize.ts';
import { parsePayload, type Payload } from './payload.ts';
import { processTransaction } from './processTransaction.ts';

/**
 * Roster File Validation (demo)
 *
 * defineAutomation, not defineWebAutomation, matching sessionKind "none" in
 * automation.json. No Chromium is launched, there is no ctx.page to reach for,
 * and the run costs a fraction of a browser automation's startup and memory.
 */
export default defineAutomation<Payload, AutomationConfig>({
  configSchema: automationConfigSchema,
  parsePayload,
  initialize,
  processTransaction,
  endProcess,
});
