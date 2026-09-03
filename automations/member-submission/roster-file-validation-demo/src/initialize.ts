import { parseDelimited } from '@auto/member-submission-shared';
import { SystemException, type InitContext } from '@rpa/core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AutomationConfig } from './config.ts';
import { setPlanCodes } from './state.ts';

/**
 * REFramework's InitAllSettings. There is no InitAllApplications here, because
 * automation.json declares sessionKind "none" - no browser is launched at all.
 *
 * MUST be idempotent: the runner calls this again after a System exception, and
 * re-reading the catalog is exactly the right behaviour on a retry (the file may
 * well be what changed).
 *
 * The catalog is loaded once per run rather than once per transaction. With
 * 10,000 members in a queue that is the difference between one file read and
 * ten thousand.
 */
export async function initialize(ctx: InitContext<AutomationConfig>): Promise<void> {
  const catalogPath = path.join(ctx.paths.automationDir, ctx.config.automation.planCatalogFile);

  let text: string;
  try {
    text = await readFile(catalogPath, 'utf8');
  } catch (cause) {
    // Reference data missing is an environment problem, so it is a System
    // exception: it aborts Initialize before a single member is touched, rather
    // than failing all 10,000 of them one at a time.
    throw new SystemException(`Could not read the plan catalog at ${catalogPath}`, { cause });
  }

  const rows = parseDelimited(text);
  const planCodes = new Set(
    rows.map((row) => row['plan_code'] ?? '').filter((code) => code.length > 0),
  );

  if (planCodes.size === 0) {
    throw new SystemException(`Plan catalog at ${catalogPath} contains no plan codes`);
  }

  setPlanCodes(ctx, planCodes);
  ctx.logger.info(
    { catalog: ctx.config.automation.planCatalogFile, planCodes: planCodes.size },
    'Plan catalog loaded (no browser launched)',
  );
}
