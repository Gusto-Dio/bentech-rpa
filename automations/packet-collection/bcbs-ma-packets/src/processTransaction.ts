import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SystemException, type WebTxContext } from '@rpa/core';
import type { Page } from 'playwright';
import type { AutomationConfig } from './config.ts';
import { RenewalsPage } from './pages/renewals.page.ts';
import type { Payload } from './payload.ts';

/**
 * One transaction. Exactly one queue item, start to finish.
 *
 * Mirrors SearchForGroup&Download.xaml: find the group's renewal quote and
 * download the BQR Renewal Notice PDF. Any of the three "not found yet"
 * checks throws BusinessException from inside RenewalsPage - no amount of
 * retrying changes a document that simply is not on the portal yet.
 * Anything else (timeout, portal down) escapes as a System exception.
 *
 * Runs on the BlueQuote tab initialize() opened, stashed in ctx.state -
 * ctx.page is still the original broker-portal tab.
 */
export async function processTransaction(
  ctx: WebTxContext<Payload, AutomationConfig>,
): Promise<void> {
  const { groupNumber, groupName } = ctx.item.payload;

  const quotePage = ctx.state.get('quotePage') as Page | undefined;
  if (quotePage === undefined) {
    throw new SystemException('BlueQuote tab was not opened during Initialize');
  }

  const renewals = new RenewalsPage(quotePage);

  ctx.logger.debug({ groupNumber, groupName }, 'Looking up renewal packet');

  await renewals.openRenewals();
  await renewals.searchGroup(groupName);
  await renewals.openGroupAccount(groupName);
  await renewals.openQuotesTab(groupName);
  const pdf = await renewals.downloadRenewalNotice();

  // Saved as run evidence for now - not the destination. Handing the file
  // off for real (upload, SFDC update) is a separate step once this path is
  // proven end to end; this only proves the packet can be found and pulled.
  const outputDir = path.join(ctx.paths.runArtifactsDir, sanitizeSegment(ctx.item.reference));
  await mkdir(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, 'renewal-notice.pdf');
  await writeFile(outputFile, pdf);

  ctx.logger.info({ groupNumber, groupName, bytes: pdf.length, outputFile }, 'Renewal packet downloaded');
}

/** Mirrors the framework's own attemptDir sanitization for artifact paths. */
function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'unnamed';
}
