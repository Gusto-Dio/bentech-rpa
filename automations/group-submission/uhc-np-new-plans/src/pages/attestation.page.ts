import { BusinessException, step, visible, type StepContext } from '@rpa/core';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import type { ProducerIdentity } from '../producer-identity.ts';
import { readPortalValidationError } from './case-start.page.ts';
import { DOCUMENT_TIMEOUT_MS, FIELD_TIMEOUT_MS, SCREEN_TIMEOUT_MS } from './samx-options.ts';

/**
 * Stage 8: the attestation. Covers runbook stage 8.
 *
 * ── THE RISKIEST STEP IN THIS POC ────────────────────────────────────────────
 * Submitting an attestation SIGNS ON THE PRODUCER'S BEHALF against the
 * production portal. There is no UHC sandbox. Once it is submitted the group
 * application is filed under a real licensed producer's licence, and no part of
 * this repository can undo it.
 *
 * So `config.allowSubmit` is false and stays false, and EVERY method here checks
 * it before touching a locator. Not just the one that presses Submit:
 * `guardedByAllowSubmit` is repeated per method so that a method added later
 * cannot become the one that signs, which is the failure the guard exists to
 * prevent and the reason attestation.page.test.ts asserts each method
 * individually.
 *
 * AGENTS.md rule 10 and packages/core/src/sentinel/rule-map.ts both name this
 * screen. If you believe you need `allowSubmit: true` to verify something, stop
 * and ask.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ EVERY LOCATOR IN THIS FILE IS AN UNVERIFIED HYPOTHESIS - and unlike the
 * rest of the automation, these cannot be verified by trying them.
 */

/**
 * Refuses to act unless the guard is explicitly open.
 *
 * A BusinessException, deliberately, and it is the PoC's SUCCESS condition:
 * reaching here means every screen before it completed. A SystemException would
 * be retried, and a retry would re-drive a partially-filled application.
 */
export function guardedByAllowSubmit(config: AutomationConfig, action: string): void {
  if (config.allowSubmit) return;

  throw new BusinessException(
    `Refusing to ${action}: allowSubmit is false. An attestation is signed on the producer's ` +
      'behalf against the production portal, so this is the PoC safety boundary and everything ' +
      'up to here completed.',
    { details: { action, allowSubmit: false } },
  );
}

export class AttestationPage {
  readonly #page: Page;
  readonly #steps: StepContext;
  readonly #config: AutomationConfig;

  constructor(page: Page, steps: StepContext, config: AutomationConfig) {
    this.#page = page;
    this.#steps = steps;
    this.#config = config;
  }

  /** Checks every attestation box. Guarded: the boxes are part of the signature. */
  async acknowledgeAttestations(): Promise<void> {
    guardedByAllowSubmit(this.#config, 'check the attestation acknowledgements');

    await step(this.#steps, {
      name: 'check every attestation acknowledgement',
      // TODO(remap): "every checkbox on the screen" is a guess that is
      // deliberately broad. The runbook says "check all boxes"; if SAMx puts
      // unrelated checkboxes on this screen, this would tick those too, so the
      // container must be narrowed to the attestation region once it is seen.
      precondition: async () =>
        visible(this.#page.getByRole('checkbox').first(), FIELD_TIMEOUT_MS),
      action: async () => {
        const boxes = await this.#page.getByRole('checkbox').all();
        for (const box of boxes) await box.check();
      },
      postcondition: async () => {
        const boxes = await this.#page.getByRole('checkbox').all();
        const states = await Promise.all(boxes.map((box) => box.isChecked().catch(() => false)));
        return states.length > 0 && states.every(Boolean);
      },
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /** Types the producer's signature. Guarded. */
  async signAsProducer(producer: ProducerIdentity): Promise<void> {
    guardedByAllowSubmit(this.#config, "sign the attestation as the producer");

    await step(this.#steps, {
      name: 'sign the attestation as the producer',
      // TODO(remap): the signature field's label is unverified, and unlike
      // everywhere else in this automation it cannot be verified by trying it.
      precondition: async () => visible(this.#page.getByLabel(/signature/i), FIELD_TIMEOUT_MS),
      action: async () => this.#page.getByLabel(/signature/i).fill(producer.fullName),
      postcondition: async () =>
        visible(this.#page.getByRole('button', { name: /submit attestation/i }), FIELD_TIMEOUT_MS),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /** Presses Submit Attestation. The irreversible one. Guarded. */
  async submitAttestation(): Promise<void> {
    guardedByAllowSubmit(this.#config, 'submit the attestation');

    await step(this.#steps, {
      name: 'submit the attestation',
      // TODO(remap): read this control's exact accessible name off the screen
      // WITHOUT pressing it - the recon harness dumps buttons read-only.
      precondition: async () =>
        visible(this.#page.getByRole('button', { name: /submit attestation/i }), FIELD_TIMEOUT_MS),
      action: async () => this.#page.getByRole('button', { name: /submit attestation/i }).click(),
      postcondition: async () =>
        visible(this.#page.getByRole('button', { name: /print completed form/i }), SCREEN_TIMEOUT_MS),
      businessCheck: async () => readPortalValidationError(this.#page),
      /**
       * `alwaysRun` so this can never take the skip-ahead branch. The
       * postcondition is "the print control is showing", which the screen after
       * a PREVIOUS group's submission also satisfies - and a skipped submit
       * would report a filing that never happened.
       */
      alwaysRun: true,
    });
  }

  /** Print Completed Form, for the evidence folder. Guarded: only reachable post-submit. */
  async downloadCompletedApplication(downloadDir: string, reference: string): Promise<string> {
    guardedByAllowSubmit(this.#config, 'download the completed application');

    let saved: string | undefined;

    await step(this.#steps, {
      name: 'download the completed application form',
      // TODO(remap): only reachable after a real submission, so this is the one
      // locator in the automation that cannot be mapped at all under the guard.
      precondition: async () =>
        visible(this.#page.getByRole('button', { name: /print completed form/i }), FIELD_TIMEOUT_MS),
      action: async () => {
        const download = this.#page.waitForEvent('download', { timeout: DOCUMENT_TIMEOUT_MS });
        await this.#page.getByRole('button', { name: /print completed form/i }).click();
        const file = await download;
        saved = path.join(downloadDir, `${reference}-uhc-employer-application.pdf`);
        await file.saveAs(saved);
      },
      postcondition: async () => saved !== undefined,
      alwaysRun: true,
      timeoutMs: DOCUMENT_TIMEOUT_MS + SCREEN_TIMEOUT_MS,
    });

    if (saved === undefined) {
      throw new BusinessException('The completed application did not download, so there is no evidence of it.');
    }
    return saved;
  }
}
