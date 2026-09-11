import { isEvidenceCapable, type StepContext, type WebTxContext } from '@rpa/core';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AutomationConfig } from './config.ts';
import type { Payload } from './payload.ts';
import { readScreen } from './pages/read-screen.ts';

/** Keeps a step name usable as a filename without losing which step it was. */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/**
 * The StepContext for one transaction, with gate failures captured as evidence.
 *
 * A failed gate is the single most useful moment to have a picture of: it means
 * the portal was not where we believed, and the whole question afterwards is
 * "where was it instead?". The runner already captures a screenshot when the
 * transaction ends, but by then the session has often been recovered and the
 * screen has moved on - this catches the actual moment.
 *
 * It matters more on UHC than on Anthem right now, because every locator in this
 * automation is an unverified guess. The first real run will fail on one of
 * them, and what makes that cheap to fix is a file naming the step, the gate and
 * what was on screen instead.
 *
 * Written as a callback so page objects depend on neither the artifact store nor
 * Playwright's screenshot API, which is why StepContext declares the hook rather
 * than doing the capture itself.
 */
export function createStepContext(ctx: WebTxContext<Payload, AutomationConfig>): StepContext {
  return {
    logger: ctx.logger,
    onGateFailure: async ({ step, gate }) => {
      ctx.logger.warn({ step, gate }, 'Capturing evidence for a failed gate');

      const file = path.join(
        ctx.paths.runArtifactsDir,
        `${slug(ctx.item.reference)}-${slug(step)}-${gate}.png`,
      );

      /**
       * Deliberately not guarded by a try/catch: step() already swallows
       * anything this hook throws, precisely so evidence capture can never
       * replace the failure that triggered it.
       *
       * The DOM diagnostics come FIRST, because they are what actually explains
       * the failure and because they survive in the log even if the screenshot
       * fails. The portal's own wording is the highest-value thing here.
       */
      const diagnostics = await readScreen(ctx.page);

      if (diagnostics === undefined) {
        ctx.logger.warn({ step, gate }, 'Could not read portal diagnostics from the DOM');
      } else {
        ctx.logger.error(
          {
            step,
            gate,
            url: diagnostics.url,
            portalAlerts: diagnostics.alerts,
            headings: diagnostics.headings,
            modal: diagnostics.modal,
          },
          diagnostics.alerts.length > 0
            ? `The portal is reporting: ${diagnostics.alerts.join(' | ')}`
            : 'The portal reported no validation message for this failure',
        );
        await writeFile(`${file.replace(/\.png$/, '')}.json`, JSON.stringify(diagnostics, null, 2), 'utf8');
      }

      if (!isEvidenceCapable(ctx.session)) return;
      await ctx.session.captureScreenshot(file);
      ctx.logger.info({ step, gate, file }, 'Captured gate-failure screenshot');
    },
  };
}

/**
 * Records what a screen is showing, without asserting anything about it.
 *
 * Used to learn a screen that has not been mapped yet - which, on this
 * automation, is every screen after owner assignment. Reaching one of them costs
 * a sign-in, an MFA code and a real case on a production portal, so arriving at
 * an unknown screen and ending the run blind wastes the one chance to look at
 * it. This writes the headings, fields and buttons into the run's artifacts
 * instead.
 */
export async function describeCurrentScreen(
  ctx: WebTxContext<Payload, AutomationConfig>,
  page: Page,
  label: string,
): Promise<void> {
  const diagnostics = await readScreen(page);

  if (diagnostics === undefined) {
    ctx.logger.warn({ label }, 'Could not describe the current screen');
    return;
  }

  const file = path.join(ctx.paths.runArtifactsDir, `${slug(ctx.item.reference)}-${slug(label)}.json`);
  await writeFile(file, JSON.stringify(diagnostics, null, 2), 'utf8');
  await page.screenshot({ path: file.replace(/\.json$/, '.png'), fullPage: true }).catch(() => undefined);

  ctx.logger.info({ label, file, screen: diagnostics }, `Recorded the ${label} screen`);
}
