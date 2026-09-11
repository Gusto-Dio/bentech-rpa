import { step, textVisible, valueIs, visible, type StepContext } from '@rpa/core';
import type { Page } from 'playwright';
import { assertContinuationMatches, primaryOptionFor, yearsInBusiness } from '../derived.ts';
import type { Payload } from '../payload.ts';
import type { ProducerIdentity } from '../producer-identity.ts';
import { readPortalValidationError } from './case-start.page.ts';
import {
  continuationOption,
  CURRENT_MEDICAL_COVERAGE,
  deductibleResetOption,
  FIELD_TIMEOUT_MS,
  organizationType,
  primaryOption,
  samxDate,
  SCREEN_STEP_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
  waitingPeriodAnswer,
} from './samx-options.ts';

/**
 * Stages 6-7: the employer application, and the producer screen that closes it.
 * Covers runbook stages 6.1 - 6.7 and 7.1.
 *
 * The longest stage, and the one where a quiet mistake costs the most: several
 * answers are DERIVED from payload counts rather than copied, the thresholds are
 * easy to invert, and nothing on the portal cross-checks them. Every derivation
 * lives in derived.ts as a tested pure function and every portal literal in
 * samx-options.ts, so this file only decides WHERE each answer is typed.
 *
 * ⚠ EVERY LOCATOR IN THIS FILE IS AN UNVERIFIED HYPOTHESIS.
 */
export class EmployerApplicationPage {
  readonly #page: Page;
  readonly #steps: StepContext;

  constructor(page: Page, steps: StepContext) {
    this.#page = page;
    this.#steps = steps;
  }

  /** Stage 6.1: general information. */
  async fillGeneralInformation(payload: Payload, asOf: Date): Promise<void> {
    const years = String(yearsInBusiness(payload.dateEstablished, asOf));
    const effectiveDate = samxDate(payload.coverageEffectiveDate);

    await step(this.#steps, {
      name: 'enter the group identity and address for the ID card',
      precondition: async () =>
        visible(this.#page.getByLabel(/group name.*id card/i), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByLabel(/group name.*id card/i).fill(payload.companyName);
        await this.#page.getByLabel(/street address/i).first().fill(payload.streetAddress1);
        await this.#page.getByLabel(/years in business/i).fill(years);
        await this.#page.getByLabel(/organization type/i).selectOption(organizationType(payload.entityType));
      },
      postcondition: async () =>
        valueIs(this.#page.getByLabel(/group name.*id card/i), payload.companyName),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'answer the plan-year and coverage questions',
      precondition: async () =>
        visible(this.#page.getByRole('group', { name: /employees.*(self|spouse)/i }), FIELD_TIMEOUT_MS),
      action: async () => {
        // The runbook answers both of these Yes outright for a new-plan group.
        await this.#page
          .getByRole('group', { name: /employees.*(self|spouse)/i })
          .getByRole('radio', { name: /^yes$/i })
          .check();
        await this.#page
          .getByRole('group', { name: /domestic partner/i })
          .getByRole('radio', { name: /^yes$/i })
          .check();

        await this.#page
          .getByLabel(/medical benefit plan option|deductible/i)
          .selectOption(deductibleResetOption(payload.medicalDeductibleReset));

        await this.#page
          .getByRole('group', { name: /workers.?\s*comp/i })
          .getByRole('radio', { name: payload.workersComp ? /^yes$/i : /^no$/i })
          .check();

        await this.#page.getByLabel(/requested effective date/i).fill(effectiveDate);
      },
      /**
       * The effective date is read back rather than the radios: it is the answer
       * on this screen a wrong value silently re-rates the group with, and it is
       * this group's own value so it cannot be satisfied by a previous case.
       */
      postcondition: async () =>
        valueIs(this.#page.getByLabel(/requested effective date/i), effectiveDate),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Stage 6.2: eligibility.
   *
   * Both derived answers are computed here through derived.ts so the branch
   * taken is logged by the step name, which is what makes the run readable as an
   * audit trail afterwards. `assertContinuationMatches` will stop the run when
   * the payload's declared continuation contradicts its own headcount.
   */
  async fillEligibilityInformation(payload: Payload): Promise<void> {
    const continuation = assertContinuationMatches(payload);
    const primary = primaryOptionFor(payload.eligibleEEs);

    await step(this.#steps, {
      name: `answer eligibility: ${continuation} continuation, ${primary} primary`,
      precondition: async () =>
        visible(this.#page.getByRole('group', { name: /erisa/i }), FIELD_TIMEOUT_MS),
      action: async () => {
        // Yes, barring the rare religious exemption the runbook mentions - which
        // is not something the payload can express, so it is not guessed at.
        await this.#page
          .getByRole('group', { name: /erisa/i })
          .getByRole('radio', { name: /^yes$/i })
          .check();
        await this.#page
          .getByRole('group', { name: /coverage during.*leave/i })
          .getByRole('radio', { name: /^yes$/i })
          .check();

        await this.#page
          .getByLabel(/continuation/i)
          .selectOption(continuationOption(continuation));
        await this.#page
          .getByLabel(/primary/i)
          .selectOption(primaryOption(primary));
      },
      postcondition: async () =>
        valueIs(this.#page.getByLabel(/continuation/i), continuationOption(continuation)),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Stage 6.3: the waiting period.
   *
   * The one mapping the runbook admits it does not have. `waitingPeriodAnswer`
   * throws until the dropdown has been read - see samx-options.ts, which
   * explains why one Hippo value can need two SAMx answers.
   */
  async fillWaitingPeriod(payload: Payload, basePolicyWaitingPeriod: string): Promise<void> {
    const answer = waitingPeriodAnswer(basePolicyWaitingPeriod);

    await step(this.#steps, {
      name: `set the waiting period to ${answer.option}`,
      precondition: async () => visible(this.#page.getByLabel(/waiting period/i), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByLabel(/waiting period/i).selectOption(answer.option);

        if (answer.durationDays !== undefined) {
          await this.#page.getByLabel(/duration|days/i).fill(String(answer.durationDays));
        }

        await this.#page
          .getByRole('group', { name: /waive.*initial|initial enrollees/i })
          .getByRole('radio', { name: payload.waivedWP ? /^yes$/i : /^no$/i })
          .check();
        // The runbook answers rehires No outright.
        await this.#page
          .getByRole('group', { name: /rehire/i })
          .getByRole('radio', { name: /^no$/i })
          .check();
      },
      postcondition: async () => valueIs(this.#page.getByLabel(/waiting period/i), answer.option),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Stage 6.4: contribution and participation.
   *
   * The counts here "should auto-populate from the quote". "Should" is not a
   * guarantee, and it has never been confirmed against a live screen - so they
   * are read back against the payload rather than trusted.
   */
  async fillContributionAndParticipation(payload: Payload): Promise<void> {
    await step(this.#steps, {
      name: 'confirm the participation counts carried over from the quote',
      precondition: async () => visible(this.#page.getByLabel(/eligible employees/i), FIELD_TIMEOUT_MS),
      action: async () => {
        // Filled rather than merely read: an auto-populated field that arrived
        // empty is the failure this guards against, and filling
        // an already-correct field is a no-op.
        await this.#page.getByLabel(/eligible employees/i).fill(String(payload.eligibleEEs));
        await this.#page.getByLabel(/atne|average total number/i).fill(String(payload.anteCount));
        await this.#page.getByLabel(/full.?time|fte/i).first().fill(String(payload.fteCount));
      },
      postcondition: async () =>
        valueIs(this.#page.getByLabel(/eligible employees/i), String(payload.eligibleEEs)),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /** Stage 6.5 and 6.6: consumer-driven plans, then additional eligibility. */
  async fillConsumerDrivenAndAdditionalEligibility(payload: Payload): Promise<void> {
    await step(this.#steps, {
      name: 'answer the consumer-driven health plan questions',
      precondition: async () =>
        visible(this.#page.getByRole('group', { name: /hsa|health savings/i }), FIELD_TIMEOUT_MS),
      action: async () => {
        /**
         * The runbook: HSA bank "none", or "other" when the group has an HSA
         * plan, unless the TTS notes say otherwise. The payload carries no HSA
         * plan flag, so the plan list is what decides.
         */
        const hasHsaPlan = payload.policies.some((policy) => /hsa/i.test(policy.planName));
        await this.#page
          .getByLabel(/hsa (bank|vendor)/i)
          .selectOption(hasHsaPlan ? { label: 'Other' } : { label: 'None' });

        /**
         * ICHRA is an Illinois-only question, answered No. Guarded on the
         * group's state rather than answered blind, because a question that is
         * not on the screen cannot be answered and a blind check would fail the
         * step for every group outside Illinois.
         */
        if (payload.state === 'IL') {
          await this.#page
            .getByRole('group', { name: /ichra/i })
            .getByRole('radio', { name: /^no$/i })
            .check();
        }
      },
      postcondition: async () => visible(this.#page.getByLabel(/hsa (bank|vendor)/i), FIELD_TIMEOUT_MS),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'answer the additional eligibility questions',
      precondition: async () =>
        visible(this.#page.getByRole('group', { name: /peo|elc|hro|aso/i }).first(), FIELD_TIMEOUT_MS),
      action: async () => {
        /**
         * "Is the group a PEO/ELC/HRO/ASO" and "common ownership with another
         * business" are both No unless the Task List says otherwise, and the
         * payload carries neither fact. Answering the two the runbook states
         * outright, and leaving the two that depend on TTS notes alone, is the
         * honest reading - a guessed Yes/No on an attested application is worse
         * than an unanswered field the portal will refuse.
         *
         * TODO(remap): confirm whether the portal blocks Continue on the two
         * unanswered questions. If it does, they have to come from the payload.
         */
        await this.#page
          .getByRole('group', { name: /is (a|an) (peo|elc|hro|aso)/i })
          .getByRole('radio', { name: /^no$/i })
          .check();
        await this.#page
          .getByRole('group', { name: /common ownership/i })
          .getByRole('radio', { name: /^no$/i })
          .check();
      },
      postcondition: async () =>
        this.#page
          .getByRole('group', { name: /common ownership/i })
          .getByRole('radio', { name: /^no$/i })
          .isChecked()
          .catch(() => false),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /** Stage 6.7: current carrier. New-plan groups answer NONE. */
  async fillCurrentCarrierInformation(): Promise<void> {
    await step(this.#steps, {
      name: 'record no current medical coverage',
      precondition: async () =>
        visible(this.#page.getByLabel(/current medical coverage/i), FIELD_TIMEOUT_MS),
      action: async () =>
        this.#page.getByLabel(/current medical coverage/i).selectOption(CURRENT_MEDICAL_COVERAGE),
      postcondition: async () =>
        valueIs(this.#page.getByLabel(/current medical coverage/i), CURRENT_MEDICAL_COVERAGE),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Stage 7.1: the producer screen.
   *
   * Every value here identifies a real licensed person or firm and arrives
   * through `resolveProducerIdentity`, never from config. General agent
   * information at the top of the screen is left blank per the runbook.
   */
  async fillProducer(producer: ProducerIdentity, commissionPercentage: number): Promise<void> {
    const commission = String(commissionPercentage);

    await step(this.#steps, {
      name: 'enter the producer and general agent',
      precondition: async () => visible(this.#page.getByLabel(/producer 1|producer name/i), FIELD_TIMEOUT_MS),
      action: async () => {
        await this.#page.getByLabel(/producer 1|producer name/i).fill(producer.fullName);
        await this.#page.getByLabel(/commission/i).fill(commission);

        // Commission payable to: Search -> General Agent.
        await this.#page.getByRole('button', { name: /^search$/i }).click();
        await this.#page.getByRole('option', { name: /general agent/i }).first().click();

        await this.#page.getByLabel(/general agent name/i).fill(producer.generalAgentName);
        await this.#page.getByLabel(/franchise code/i).fill(producer.generalAgentFranchiseCode);
        await this.#page.getByLabel(/email/i).first().fill(producer.generalAgentEmail);
        await this.#page.getByLabel(/pcis/i).fill(producer.pcisId);
      },
      /**
       * The PCIS id is read back rather than the producer name: the name field
       * is a lookup that portals routinely reformat (a middle initial appears),
       * where the PCIS id is an exact identifier.
       */
      postcondition: async () => valueIs(this.#page.getByLabel(/pcis/i), producer.pcisId),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Confirms the application is complete and the attestation is the next step.
   *
   * Read-only: it asserts where the wizard has arrived and presses nothing. This
   * is the last screen the PoC is allowed to reach.
   */
  async waitForAttestationStep(payload: Payload): Promise<void> {
    await step(this.#steps, {
      name: 'confirm the application is complete and attestation is next',
      action: async () => undefined,
      /**
       * Anchored on the group's own name so a resumed run cannot be satisfied by
       * the previous case's attestation screen.
       */
      postcondition: async () =>
        (await textVisible(this.#page, /attestation/i, SCREEN_TIMEOUT_MS)) &&
        (await textVisible(this.#page, payload.companyName, SCREEN_TIMEOUT_MS)),
      businessCheck: async () => readPortalValidationError(this.#page),
      timeoutMs: SCREEN_STEP_TIMEOUT_MS,
    });
  }
}
