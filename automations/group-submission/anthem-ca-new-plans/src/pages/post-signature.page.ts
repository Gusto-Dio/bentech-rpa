import {
  BusinessException,
  SystemException,
  hidden,
  step,
  textVisible,
  visible,
  type StepContext,
} from '@rpa/core';
import type { Locator, Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import {
  DOCUMENT_TIMEOUT_MS,
  FIELD_TIMEOUT_MS,
  RAIL_POLL_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
  answerIfPresent,
  button,
  field,
  isSelected,
  select,
  stepIs,
} from './lightning.ts';
import { readPortalValidationError } from './portal-errors.ts';

/**
 * The tail of the wizard: everything between the DocuSign signature and the
 * `Document Checklist`, which is the LAST step in the rail.
 *
 * ── HOW THIS WAS MAPPED, AND WHAT IS VERIFIED ────────────────────────────────
 * First mapped 2026-09-03 by reopening the application that run
 * `20260903T172508Z-d0d83a` had signed - no MFA code and no new quote spent -
 * and then driven for real by run `20260903T190608Z-093764` (group
 * `The Company LLC 2`, quote `02284005`).
 *
 * Every step below has now run in-wizard against production:
 *
 * and finally proven end to end by run `20260903T195143Z-839b76` (group
 * `The Company LLC 4`, quote `02284068`): 94 steps, 10m36s,
 * `processed: 1 success: 1 business: 0 system: 0 retries: 0`.
 *
 *   Signature confirmation   VERIFIED  `leave the signature step`
 *   Print and Sign Now       CROSSED   unnamed in the rail; Continue
 *   Send EFT Via DocuSign    CROSSED   ditto. `crossPostSigningSteps` now
 *                                      answers its question No explicitly and
 *                                      records both screens - see that method
 *   Member Enrollment Type   VERIFIED  a combobox; outcome "completed"
 *   Document Checklist       VERIFIED  reached and confirmed against the
 *                                      transaction's own quote number
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── WHY THE GUARD IS ON EVERY METHOD ─────────────────────────────────────────
 * These screens are only reachable once the application is signed and filed, so
 * everything here mutates a live carrier submission: choosing an enrollment
 * channel writes to the filed application, and `submitChecklist` transmits the
 * documents. Same reasoning, and same deliberate duplication, as
 * signature.page.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The rail entry for the last step, used as both a target and an assertion. */
const DOCUMENT_CHECKLIST = 'Document Checklist';
const MEMBER_ENROLLMENT_TYPE = 'Member Enrollment Type';

/**
 * The portal's own confirmation that the ceremony landed.
 *
 * VERIFIED verbatim: "You have successfully signed the document. Please select
 * Continue to move to the next step."
 */
const SIGNED_CONFIRMATION = /successfully signed the document/i;

/** One row of the `Document Checklist` table. */
export interface ChecklistRow {
  /** `Document Name`, e.g. `Employer Application`, `Waivers`. */
  readonly name: string;
  /** `File Name`, empty when nothing is attached. */
  readonly fileName: string;
  /** `Status` as the portal words it - `Submitted`, `Not submitted`, ... */
  readonly status: string;
  /**
   * Whether the row carries the required marker.
   *
   * Read from the row's own `lightning-icon.required-icon`, whose assistive
   * text is "Required document". VERIFIED 2026-09-03: exactly three of the 23
   * rows carry it - `Employer Application`, `Electronic Debit Form/Live Check
   * Copy` and `Quote`.
   */
  readonly required: boolean;
}

/**
 * Reads the checklist table.
 *
 * Kept as a browser-side string for the same reason the reconnaissance harness
 * does it: this repo has no `dom` lib, deliberately, and a page.evaluate body
 * runs in a runtime this tsconfig does not describe.
 *
 * ── IT MUST WALK SHADOW ROOTS ────────────────────────────────────────────────
 * `document.querySelector('table.slds-table')` finds NOTHING here. The
 * checklist is a Lightning web component, so the table lives in a shadow root,
 * and `querySelector` does not cross one. The first version of this reader did
 * exactly that and threw "the table read as empty" against a screen showing all
 * 23 rows - which looks like a screen that had not rendered, and is not.
 *
 * Playwright's own locators DO pierce shadow DOM, which is why the postcondition
 * in `reachDocumentChecklist` can use `page.locator('table.slds-table')`
 * directly. Only hand-written DOM traversal needs this.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The cell order is positional because the header row gives no other handle:
 * `[required icon] [No] [Document Name] [File Name] [Date Uploaded] [Status]
 * [Action]`.
 */
const READ_CHECKLIST = `() => {
  const walk = (root, out) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'TABLE' && el.classList.contains('slds-table')) out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot, out);
    }
    return out;
  };
  const table = walk(document, [])[0];
  if (!table) return [];
  const sq = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  return [...table.querySelectorAll('tr')]
    .filter((row) => row.querySelector('td'))
    .map((row) => {
      const cells = [...row.children];
      return {
        name: sq(cells[2]?.textContent),
        fileName: sq(cells[3]?.textContent),
        status: sq(cells[5]?.textContent),
        required: cells[0]?.querySelector('lightning-icon.required-icon') !== null,
      };
    })
    .filter((row) => row.name !== '');
}`;

export class PostSignaturePage {
  readonly #page: Page;
  readonly #steps: StepContext;
  readonly #config: AutomationConfig;

  constructor(page: Page, steps: StepContext, config: AutomationConfig) {
    this.#page = page;
    this.#steps = steps;
    this.#config = config;
  }

  /**
   * The guard, checked at the top of every public method.
   *
   * Repeated per method rather than once in the constructor on purpose: a
   * future method added without it would otherwise be the one that transmits.
   */
  #assertMaySubmit(what: string): void {
    if (!this.#config.allowSubmit) {
      throw new BusinessException(
        `${what} was called with allowSubmit=false. This is the guard that stops the PoC from ` +
          'advancing a signed group application on the production portal.',
        { details: { guard: 'allowSubmit', method: what } },
      );
    }
  }

  /**
   * The `Continue` that leaves the signature step.
   *
   * The precondition is the portal's confirmation text, not the button: a
   * `Continue` is present on every screen of this wizard, so gating on it would
   * be satisfied while the ceremony was still open and would press Continue on
   * an unsigned application.
   */
  async acknowledgeSignature(): Promise<void> {
    this.#assertMaySubmit('acknowledgeSignature');

    await step(this.#steps, {
      name: 'leave the signature step',
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () => textVisible(this.#page, SIGNED_CONFIRMATION, DOCUMENT_TIMEOUT_MS),
      action: async () => button(this.#page, 'Continue').last().click(),
      /**
       * `alwaysRun` because the postcondition cannot distinguish "already left"
       * from "never arrived" - the confirmation banner disappearing is the only
       * evidence, and it is gone in both cases.
       */
      alwaysRun: true,
      /**
       * `hidden()`, not `!textVisible()`. Both answer the same question, but
       * `textVisible` waits for the banner to APPEAR and only reports false on
       * timeout - so negating it always costs the full screen budget, 45s, even
       * when the banner went away instantly. `hidden()` returns as soon as it
       * has gone.
       */
      postcondition: async () =>
        hidden(this.#page.getByText(SIGNED_CONFIRMATION).first(), SCREEN_TIMEOUT_MS),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Presses `Continue` until the rail reports `target` as the current step.
   *
   * ── THE TWO STEPS IT CROSSES ────────────────────────────────────────────────
   * Between `Signature Format` and `Member Enrollment Type` the rail holds
   * **`Print and Sign Now`** and **`Send EFT Via DocuSign`**. Neither carries
   * its name in the button TEXT - only the last three rail entries do - so
   * `stepIs()` cannot address them; their names are only readable from a
   * screenshot, which is how they were finally identified (2026-09-03).
   *
   * Both were crossed by a bare Continue and the rail marked them Completed, so
   * neither demands input on this path. `Send EFT Via DocuSign` is the one to
   * watch: the runbook answers it **No**, and a Continue accepting the default
   * is only correct if the default IS No. It has not been read directly - see
   * open-questions.md.
   *
   * The loop advances only while the portal raises NO validation message, and
   * the moment a screen answers back it stops and surfaces that wording. A
   * confirmation screen is passed through; a screen that actually wants input
   * fails with the portal's own sentence and a DOM dump from the gate-failure
   * hook, rather than being guessed at on a filed application.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async #advanceTo(target: string, name: string, maxScreens = 4): Promise<void> {
    await step(this.#steps, {
      name,
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () => visible(button(this.#page, 'Continue'), SCREEN_TIMEOUT_MS),
      action: async () => {
        for (let screen = 0; screen < maxScreens; screen += 1) {
          if (await stepIs(this.#page, target, 'In Progress', RAIL_POLL_TIMEOUT_MS)) return;

          const complaint = await readPortalValidationError(this.#page);
          if (complaint !== undefined) {
            throw new BusinessException(
              `An unmapped screen between the signature and "${target}" is asking for input: ` +
                `${complaint}. Nothing here may guess an answer on a filed application - map this ` +
                'screen from the attached DOM dump and give it its own step.',
              { details: { target, portalMessage: complaint } },
            );
          }

          await button(this.#page, 'Continue').last().click();
          await this.#page.waitForTimeout(2_000);
        }

        throw new SystemException(
          `The wizard did not reach "${target}" within ${maxScreens} screens after the signature.`,
          { details: { target, maxScreens } },
        );
      },
      // The rail is the only trustworthy signal: the form repaints in place, so
      // "the fields changed" says nothing. See stepIs().
      postcondition: async () => stepIs(this.#page, target, 'In Progress'),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * `Member Enrollment Type` - how members will be enrolled once the group is set up.
   *
   * The five option strings are VERIFIED, off the Application record's own
   * picklist for this field (`--None--`, `Online Census Tool`, `Ease`,
   * `Real-Time`, `Simple Census`, `API`), and the chosen one comes from config
   * so it cannot be a literal buried here.
   *
   * VERIFIED 2026-09-03 as a Vlocity **combobox**, in-wizard, on a real run: the
   * step reported `outcome: "completed"` (not `"skipped"`), so the action ran
   * and `isSelected` read the committed value back. A radio branch was written
   * alongside it while the shape was unknown; it is gone now that the answer is
   * known, because a dead branch in a step that runs once after a filing is
   * just somewhere for a future bug to hide.
   *
   * Choosing `Online Census Tool` here also makes the checklist's own
   * `Online Census Tool` row REQUIRED - the enrollment channel decides which
   * documents the carrier then wants. See documents.md.
   */
  /**
   * `Send EFT Via DocuSign` - the one screen between the signature and
   * `Member Enrollment Type`. MAPPED 2026-09-03, run `20260903T215139Z-1d3674`.
   *
   * The rail also lists `Print and Sign Now` between them, but that step is
   * completed by the signing ceremony itself and shows a green tick by the time
   * this runs - so only ONE screen is actually crossed here, not two as the
   * rail suggests.
   *
   * ── THE SCREEN, VERBATIM ────────────────────────────────────────────────────
   *   heading   "Send EFT Via DocuSign"
   *   body      "You can help your clients set up their EFT through DocuSign.
   *              Or, if you already have a completed signed EFT form, attach it
   *              to the EFT section on the Document Checklist page instead."
   *   question  "*Would you like to send the EFT form through DocuSign?"
   *   radios    Yes / No, with **No pre-selected by default**
   *
   * That default is why runs 1-4, which crossed this with a bare Continue, did
   * NOT send EFT forms to employers. It is still answered explicitly here: the
   * runbook's answer is No, a default is not a decision, and the alternative -
   * a Yes nobody asked for - mails a real employer a form to sign against an
   * application that is already filed.
   *
   * The body text also explains the checklist's outstanding required
   * `Electronic Debit Form/Live Check Copy` row: answering No means that form
   * is attached there instead.
   * ───────────────────────────────────────────────────────────────────────────
   *
   * It could not be pre-mapped. The screen exists only between the signature
   * and the enrollment type, and re-entering the wizard for a group whose
   * application is already filed is refused outright - "Application Matching
   * Error", whose only control is `Exit`. Verified against every filed group.
   * Hence `recordScreen`, which captures each screen BEFORE anything is
   * answered; it is passed in rather than imported so the page object depends
   * on neither the artifact store nor Playwright's screenshot API, the same
   * reasoning as `StepContext.onGateFailure`.
   */
  async crossPostSigningSteps(
    recordScreen: (label: string) => Promise<void>,
    maxScreens = 4,
  ): Promise<void> {
    this.#assertMaySubmit('crossPostSigningSteps');

    for (let screen = 0; screen < maxScreens; screen += 1) {
      if (await stepIs(this.#page, MEMBER_ENROLLMENT_TYPE, 'In Progress', RAIL_POLL_TIMEOUT_MS)) {
        return;
      }

      // Recorded BEFORE anything is answered, so the dump shows the screen as
      // the portal presented it. This is the only chance to see it.
      await recordScreen(`post-signing-screen-${screen + 1}`);

      await step(this.#steps, {
        name: `cross post-signing screen ${screen + 1}`,
        timeoutMs: DOCUMENT_TIMEOUT_MS,
        precondition: async () => visible(button(this.#page, 'Continue'), SCREEN_TIMEOUT_MS),
        action: async () => {
          /**
           * Best-effort and deliberately so. If the question is there we answer
           * the runbook's No; if this regex does not match it, Continue still
           * proceeds exactly as runs 1-4 did, so nothing regresses - and the
           * dump above is what lets the next pass write the real locator.
           */
          const answered = await answerIfPresent(
            this.#page,
            /eft|electronic (debit|funds)|docusign/i,
            'No',
            FIELD_TIMEOUT_MS,
          );

          this.#steps.logger.info(
            { screen: screen + 1, eftQuestionAnswered: answered },
            answered
              ? 'Answered the EFT-via-DocuSign question No, per the runbook'
              : 'No EFT-via-DocuSign question found on this screen; continuing',
          );

          const complaint = await readPortalValidationError(this.#page);
          if (complaint !== undefined) {
            throw new BusinessException(
              `A post-signing screen is asking for input this automation does not supply: ${complaint}`,
              { details: { screen: screen + 1, portalMessage: complaint } },
            );
          }

          await button(this.#page, 'Continue').last().click();
          await this.#page.waitForTimeout(2_000);
        },
        alwaysRun: true,
        // The rail is the only trustworthy signal: the form repaints in place.
        postcondition: async () => true,
        businessCheck: async () => readPortalValidationError(this.#page),
      });
    }

    throw new SystemException(
      `The wizard did not reach "${MEMBER_ENROLLMENT_TYPE}" within ${maxScreens} screens after the signature.`,
      { details: { maxScreens } },
    );
  }

  async selectMemberEnrollmentType(): Promise<void> {
    this.#assertMaySubmit('selectMemberEnrollmentType');
    const wanted = this.#config.memberEnrollmentType;

    await this.#advanceTo(
      MEMBER_ENROLLMENT_TYPE,
      'advance from the signature to the member enrollment type',
    );

    await step(this.#steps, {
      name: 'choose the member enrollment type',
      timeoutMs: SCREEN_TIMEOUT_MS,
      precondition: async () => visible(field(this.#page, /member enrollment type/i), FIELD_TIMEOUT_MS),
      action: async () => select(this.#page, /member enrollment type/i, wanted),
      postcondition: async () => isSelected(this.#page, /member enrollment type/i, wanted),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * Advances to `Document Checklist`, the last step in the rail.
   *
   * ── WHAT ANCHORS THIS ───────────────────────────────────────────────────────
   * "A checklist is on screen" is precisely the postcondition rule 9 warns
   * about: the PREVIOUS group's checklist satisfies it, and the skip-ahead then
   * sails past reaching this one. So the anchor is the `Quote` row's own file
   * name, which carries THIS transaction's quote number - verified in-wizard on
   * 2026-09-03, where row 3 read `02284005-Small-group-quote-ACA-Member-ra...`
   * for quote `02284005`.
   *
   * It used to also read the screen's `Application Name` field, and that is what
   * failed the step on a screen it had correctly reached. That field exists only
   * on the STANDALONE checklist (`applicationrecordaction?...&c__isUploadDocument=true`),
   * which is where this screen was first mapped - in-wizard the evidence dump
   * shows `fields: []`. Mapping a step from a different entry point than the
   * process actually uses is its own hazard, recorded in drift-log.md.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async reachDocumentChecklist(quoteNumber: string | undefined): Promise<void> {
    this.#assertMaySubmit('reachDocumentChecklist');

    await this.#advanceTo(DOCUMENT_CHECKLIST, 'advance to the document checklist');

    await step(this.#steps, {
      name: 'confirm the document checklist belongs to this group',
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      action: async () => undefined,
      alwaysRun: true,
      /**
       * ── IT MUST WAIT, NOT READ ────────────────────────────────────────────
       * The checklist is built SERVER-SIDE after the step opens. The screen
       * paints its table header first, reading `0 out of 0 documents uploaded`,
       * and the 23 rows arrive a few seconds later. So a postcondition that
       * READS the rows once sees an empty table and fails a step that had
       * arrived perfectly - which is how this step failed a second time, on a
       * screen the evidence screenshot shows it had reached.
       *
       * A Playwright locator rather than `readChecklist()` is the fix, not a
       * stylistic choice: a locator re-evaluates on every poll AND pierces the
       * Lightning shadow root, so this is a real wait for THIS transaction's
       * row to appear. `readChecklist()` is a snapshot and belongs after
       * arrival is established, which is where processTransaction calls it.
       * ──────────────────────────────────────────────────────────────────────
       */
      postcondition: async () => {
        if (quoteNumber !== undefined) {
          return visible(
            this.#page.locator('table.slds-table tr').filter({ hasText: quoteNumber }),
            DOCUMENT_TIMEOUT_MS,
          );
        }

        /**
         * `readQuoteNumber` upstream is best-effort, so this can genuinely be
         * unknown. Rather than silently fall back to a check any group would
         * satisfy, it waits only for the checklist to populate and records that
         * arrival was NOT verified as this group's.
         */
        this.#steps.logger.warn(
          'No quote number was read upstream, so the checklist cannot be confirmed as this group\'s',
        );
        return visible(this.#page.locator('table.slds-table tr:has(td)'), DOCUMENT_TIMEOUT_MS);
      },
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * The 23 checklist rows, as the portal currently shows them.
   *
   * Read-only, and the reason this method exists: the PoC stops here, so the
   * checklist state IS the deliverable of the last step - which documents the
   * carrier already holds, and which required one is still outstanding.
   */
  async readChecklist(): Promise<readonly ChecklistRow[]> {
    const rows = (await this.#page.evaluate(`(${READ_CHECKLIST})()`)) as ChecklistRow[];

    if (rows.length === 0) {
      throw new SystemException(
        'The document checklist table read as empty. Either the screen had not rendered or ' +
          '`table.slds-table` is no longer the checklist.',
      );
    }

    return rows;
  }

  /**
   * `X Remove All` - detaches every uploaded document.
   *
   * Never called by the process. It exists so that the guard, rather than the
   * absence of a method, is what stands between a run and this control: it sits
   * next to the upload rows and would discard the Employer Application and
   * Quote the portal attached itself.
   */
  async removeAllDocuments(): Promise<void> {
    this.#assertMaySubmit('removeAllDocuments');
    throw new SystemException(
      'removeAllDocuments is deliberately not implemented. It would detach the Employer ' +
        'Application and Quote that the portal attaches on its own.',
    );
  }

  /**
   * Attaches a file to one checklist row.
   *
   * The `Choose File` buttons are decoration: each row holds its own
   * `input[type=file].hidden-file-input[data-index=N]`, and `setInputFiles` on
   * it is both simpler and immune to the file-picker dialog. VERIFIED: 23
   * inputs, indexed 0-22 in row order, accepting
   * `.pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx,.txt,.csv,...` at max 10 MB each.
   *
   * Not wired into the process, and deliberately so: the outstanding required
   * document is the `Electronic Debit Form/Live Check Copy`, which carries the
   * group's BANKING DETAILS. This PoC's payload carries references, not
   * records (rule 2), so it has nothing to put there and must not invent it.
   */
  async attachDocument(documentName: string, filePath: string): Promise<void> {
    this.#assertMaySubmit('attachDocument');

    const rows = await this.readChecklist();
    const index = rows.findIndex((row) => row.name === documentName);
    if (index < 0) {
      throw new BusinessException(
        `"${documentName}" is not one of the ${rows.length} slots on Anthem's document checklist.`,
        { details: { documentName, slots: rows.map((row) => row.name) } },
      );
    }

    await step(this.#steps, {
      name: `attach ${documentName}`,
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      action: async () =>
        this.#fileInput(index).setInputFiles(filePath),
      postcondition: async () => {
        const after = await this.readChecklist();
        return (after[index]?.fileName ?? '') !== '';
      },
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  #fileInput(index: number): Locator {
    return this.#page.locator(`input.hidden-file-input[data-index="${index}"]`);
  }

  /**
   * `Submit` - transmits the checklist to Anthem. THE END OF THE WIZARD.
   *
   * ── THE LOCATOR TRAP ────────────────────────────────────────────────────────
   * This button reads `Submit` and its `aria-label` is `documentCheckListSubmit`.
   * An aria-label WINS over the visible text, so
   * `getByRole('button', { name: 'Submit' })` matches NOTHING - measured, zero
   * matches on the live screen - while the repo's `button()` helper finds it,
   * because that helper filters on text rather than on the accessible name.
   * This is the same class of trap as Anthem's "Continue" button whose
   * accessible name is `Login`.
   * ───────────────────────────────────────────────────────────────────────────
   *
   * Left unimplemented behind the guard rather than written and never run. The
   * PoC boundary is ARRIVING at this step, and pressing this would transmit an
   * incomplete checklist: the required `Electronic Debit Form/Live Check Copy`
   * has no source in a payload that deliberately carries no banking details.
   */
  async submitChecklist(): Promise<void> {
    this.#assertMaySubmit('submitChecklist');
    throw new SystemException(
      'submitChecklist is deliberately not implemented. Reaching the Document Checklist is the ' +
        'end of this PoC, and submitting it would transmit a checklist whose one outstanding ' +
        'required document - the Electronic Debit Form - has no source in this payload.',
    );
  }
}
