import { defineAutomation } from '@rpa/core';
import { automationConfigSchema, type AutomationConfig } from './config.ts';
import { endProcess } from './endProcess.ts';
import { initialize } from './initialize.ts';
import { parsePayload, type Payload } from './payload.ts';
import { processTransaction } from './processTransaction.ts';

/**
 * __AUTOMATION_NAME__ (__AUTOMATION_ID__)
 *
 * defineAutomation, not defineWebAutomation: automation.json declares
 * sessionKind "none", so no Chromium is launched and there is no ctx.page to
 * reach for. That saves a couple of seconds and a few hundred MB per run.
 */
export default defineAutomation<Payload, AutomationConfig>({
  configSchema: automationConfigSchema,
  parsePayload,
  initialize,
  processTransaction,
  endProcess,
});
