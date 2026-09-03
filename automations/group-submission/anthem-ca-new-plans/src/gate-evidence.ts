import { isEvidenceCapable, type StepContext, type WebTxContext } from '@rpa/core';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AutomationConfig } from './config.ts';
import type { Payload } from './payload.ts';

/**
 * Reads the portal's own validation messages and rendered fields out of the DOM.
 *
 * A screenshot shows you a page; this tells you what the page is complaining
 * about, in text you can grep at 03:00 without opening an image viewer. On this
 * platform that matters more than usual: the messages are the only reliable
 * account of WHY a Continue refused, and they sit in shadow roots that
 * `document.body.innerText` does not reach.
 */
const READ_DIAGNOSTICS = `() => {
  const walk = (root, out) => {
    for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }
    return out;
  };
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sq = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const all = walk(document, []);
  const labelOf = (el) => {
    const root = el.getRootNode();
    const l = el.id && root.querySelector ? root.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    return sq(l?.textContent);
  };
  return {
    url: location.href,
    alerts: [...new Set(all
      .filter((el) => shown(el) && el.matches('.slds-form-element__help,[role=alert],[class*=errorMessage]'))
      .map((el) => sq(el.textContent)).filter(Boolean))].slice(0, 15),
    wizardStep: [...new Set(all
      .filter((el) => shown(el) && el.matches('button'))
      .map((el) => sq(el.textContent))
      .filter((t) => /Untouched|In Progress|Completed/.test(t)))],
    fields: all
      .filter((el) => el.matches('input,textarea') && shown(el) && !['radio','checkbox','file'].includes(el.type))
      .map((el) => ({ label: labelOf(el).slice(0, 60), value: el.getAttribute('data-value') ?? el.value })),
    buttons: [...new Set(all
      .filter((el) => shown(el) && el.matches('button,a[role=button]'))
      .map((el) => sq(el.textContent)).filter(Boolean))].slice(0, 40),
    answered: all
      .filter((el) => el.matches('input[type=radio],input[type=checkbox]') && shown(el) && el.checked)
      .map((el) => labelOf(el).slice(0, 60)),
    modal: (() => {
      const m = all.find((el) => shown(el) && el.matches('section.slds-modal.slds-fade-in-open'));
      return m ? sq(m.textContent).slice(0, 300) : null;
    })(),
  };
}`;

/** Keeps a step name usable as a filename without losing which step it was. */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/**
 * The StepContext for one transaction, with gate failures captured as evidence.
 *
 * A failed gate is the single most useful moment to have a picture of: it means
 * the portal was not where we believed, and the whole question at 03:00 is
 * "where was it instead?". The runner already captures a screenshot when the
 * transaction ends, but by then the session has often been recovered and the
 * screen has moved on - this catches the actual moment.
 *
 * Written as a callback so page objects depend on neither the artifact store nor
 * Playwright's screenshot API, which is why StepContext declares the hook rather
 * than doing the capture itself.
 */
/**
 * Records what a screen is showing, without asserting anything about it.
 *
 * Used to learn a screen that has not been mapped yet. Driving this process
 * costs about eight minutes and a real production quote, so arriving at an
 * unknown screen and ending the run blind wastes the one chance to look at it -
 * this writes the wizard rail, headings, fields and buttons to the run's
 * artifacts instead.
 */
export async function describeCurrentScreen(
  ctx: WebTxContext<Payload, AutomationConfig>,
  page: Page,
  label: string,
): Promise<void> {
  const diagnostics = await page.evaluate(`(${READ_DIAGNOSTICS})()`).catch((cause: unknown) => {
    ctx.logger.warn({ label, err: cause }, 'Could not describe the current screen');
    return undefined;
  });

  if (diagnostics === undefined || diagnostics === null) return;

  const file = path.join(ctx.paths.runArtifactsDir, `${slug(ctx.item.reference)}-${slug(label)}.json`);
  await writeFile(file, JSON.stringify(diagnostics, null, 2), 'utf8');
  await page.screenshot({ path: file.replace(/\.json$/, '.png'), fullPage: true }).catch(() => undefined);

  ctx.logger.info({ label, file, screen: diagnostics }, `Recorded the ${label} screen`);
}

export interface AnthemStepContext extends StepContext {
  /**
   * The page evidence should be captured from.
   *
   * It has to be mutable. `Create Quote` opens a NEW TAB and the rest of the
   * process happens there, while `ctx.session` still owns the original Producer
   * Toolbox tab - so the runner's own screenshot, and the first version of this
   * hook, both photographed a quotes page nobody was looking at. The first
   * gate-failure screenshot of the new flow was exactly that: a picture of the
   * launcher, taken while the failure was three screens deep on another host.
   */
  followPage(page: Page): void;
}

export function createStepContext(ctx: WebTxContext<Payload, AutomationConfig>): AnthemStepContext {
  let active: Page = ctx.page;

  return {
    followPage: (page: Page) => {
      active = page;
    },
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
       */
      /**
       * The DOM diagnostics come FIRST, because they are what actually explains
       * the failure and because they survive in the log even if the screenshot
       * fails. The portal's own wording is the highest-value thing here.
       */
      /**
       * Note the invoking parentheses. A string handed to evaluate() is an
       * EXPRESSION, so a bare arrow function comes back as an unserialisable
       * function - which Playwright returns as `undefined`, and the hook then
       * throws reading `.alerts` off it. The failure is swallowed by design, so
       * this presented as "no diagnostics" rather than as a bug.
       */
      const diagnostics = (await active.evaluate(`(${READ_DIAGNOSTICS})()`).catch((cause: unknown) => {
        // Swallowing this silently once already hid the real cause of a gate
        // failure behind "no diagnostics", so it is logged rather than dropped.
        ctx.logger.warn({ step, gate, err: cause }, 'Could not read portal diagnostics from the DOM');
        return null;
      })) as {
        alerts: string[];
        wizardStep: string[];
        modal: string | null;
      } | null | undefined;

      if (diagnostics !== null && diagnostics !== undefined) {
        ctx.logger.error(
          {
            step,
            gate,
            portalAlerts: diagnostics.alerts,
            wizardStep: diagnostics.wizardStep,
            modal: diagnostics.modal,
          },
          diagnostics.alerts.length > 0
            ? `The portal is reporting: ${diagnostics.alerts.join(' | ')}`
            : 'The portal reported no validation message for this failure',
        );
        await writeFile(`${file.replace(/\.png$/, '')}.json`, JSON.stringify(diagnostics, null, 2), 'utf8');
      }

      if (active !== ctx.page) {
        await active.screenshot({ path: file, fullPage: true });
      } else if (isEvidenceCapable(ctx.session)) {
        await ctx.session.captureScreenshot(file);
      } else {
        return;
      }
      ctx.logger.info({ step, gate, file }, 'Captured gate-failure screenshot');
    },
  };
}
