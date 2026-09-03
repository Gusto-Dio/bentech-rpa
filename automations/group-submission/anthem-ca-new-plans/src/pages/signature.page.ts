import {
  BusinessException,
  hidden,
  step,
  textVisible,
  valueIs,
  visible,
  type StepContext,
} from '@rpa/core';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import type { Payload } from '../payload.ts';
import {
  DOCUMENT_TIMEOUT_MS,
  SCREEN_TIMEOUT_MS,
  button,
  check,
  field,
  type as typeInto,
} from './lightning.ts';
import { readPortalValidationError } from './portal-errors.ts';

/**
 * Whatever DocuSign is living in - an iframe today, a popup if Anthem changes
 * it. Both `Frame` and `Page` expose `getByRole`, which is all the signing
 * steps need, so the structural type keeps the caller indifferent.
 */
type SigningSurface = Pick<Page, 'getByRole' | 'getByText'>;

/**
 * Stage 8 - `Signature Format` and the DocuSign ceremony that FILES the
 * application with Anthem.
 *
 * ── THE RISKIEST FILE IN THIS POC ────────────────────────────────────────────
 * Completing this produces a SIGNED group application on the PRODUCTION portal
 * under a real producer's licence. It cannot be un-signed and the carrier may
 * act on it. The group being synthetic does not make the filing synthetic.
 *
 * Every method checks `config.allowSubmit` FIRST and throws a BusinessException
 * naming the guard when it is false. That is not defensive decoration - it is
 * the control that makes running this PoC against production acceptable at all,
 * and `processTransaction` checks it too. The duplication is deliberate.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── ⚠ EVERY LOCATOR BELOW IS UNVERIFIED ──────────────────────────────────────
 * These screens have never been driven, because reaching them means signing.
 * The sequence comes from the Benefits runbook (stage 8), which for stages 2-7
 * proved right about INTENT and wrong about nearly every locator - the whole
 * flow had moved to Salesforce/Vlocity. Assume the same here.
 *
 * Everything carries `TODO(remap)`. Before this is trusted:
 *   1. flip `allowSubmit` in dev only, deliberately, with sign-off;
 *   2. drive it once supervised and headed, on the synthetic group;
 *   3. record what differed in drift-log.md and correct these locators.
 *
 * DocuSign runs in its own popup or iframe, and that is the single most likely
 * thing to be wrong below. `#ceremony()` is the one seam to change when the
 * truth is known.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class SignaturePage {
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
   * future method added without it would otherwise be the one that signs.
   */
  #assertMaySubmit(what: string): void {
    if (!this.#config.allowSubmit) {
      throw new BusinessException(
        `${what} was called with allowSubmit=false. This is the guard that stops the PoC from ` +
          'signing and filing a real group application against the production portal.',
        { details: { guard: 'allowSubmit', method: what } },
      );
    }
  }

  /**
   * `Signature Format` - VERIFIED 2026-09-03.
   *
   * The runbook's "Sign electronically yourself" is now **`Sign Now`**, under
   * the legend "*Choose a signature format for the application:". The other
   * option is `Email to the Client through DocuSign`, which hands the signing
   * to the employer instead - a different process with a different owner, so
   * picking the wrong one silently changes who is responsible for the
   * submission. Hence the exact-match anchors below.
   */
  async chooseElectronicSignature(): Promise<void> {
    this.#assertMaySubmit('chooseElectronicSignature');

    await step(this.#steps, {
      name: 'choose the Sign Now signature format',
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () =>
        textVisible(this.#page, /Choose a signature format for the application/i, DOCUMENT_TIMEOUT_MS),
      // The input is 1x1 px behind its label, like every other SLDS choice here.
      action: async () => check(this.#page, 'Sign Now'),
      postcondition: async () =>
        field(this.#page, 'Sign Now').first().isChecked().catch(() => false),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'continue from signature format',
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () => visible(button(this.#page, 'Continue'), SCREEN_TIMEOUT_MS),
      action: async () => {
        await button(this.#page, 'Continue').last().click();
      },
      alwaysRun: true,
      // TODO(remap): anchor this on whatever the ceremony screen actually shows
      // once it has been seen. `Signature Format` leaving the rail is the only
      // signal available before that.
      postcondition: async () =>
        hidden(
          this.#page.getByText(/Choose a signature format for the application/i).first(),
          SCREEN_TIMEOUT_MS,
        ),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * The signatory screen - VERIFIED 2026-09-03.
   *
   * Two required fields, `*Company Owner/Officer’s Name` and `*Title`, then a
   * `Sign Now` button that opens the DocuSign ceremony. The runbook's "Type
   * Signatory's name and title -> Sign Now" is exact for once.
   *
   * Note the apostrophe in `Officer’s`: the portal uses a CURLY one (U+2019),
   * not `'`. A guessed locator written with a straight apostrophe matches
   * nothing, so the `.` below deliberately accepts either.
   */
  #SIGNATORY_NAME = /Company Owner\/Officer.s Name/i;

  async enterSignatory(payload: Payload): Promise<void> {
    this.#assertMaySubmit('enterSignatory');

    const name = `${payload.benefitsSignatory.firstName} ${payload.benefitsSignatory.lastName}`;

    await step(this.#steps, {
      name: 'enter the signatory name and title',
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () => visible(field(this.#page, this.#SIGNATORY_NAME), DOCUMENT_TIMEOUT_MS),
      action: async () => {
        await typeInto(this.#page, this.#SIGNATORY_NAME, name);
        await typeInto(this.#page, /^\*?Title$/i, payload.benefitsSignatory.title);
      },
      /**
       * Reads the field back rather than looking for the name anywhere on the
       * page, and anchors on THIS payload's signatory - so a resumed run cannot
       * be satisfied by whatever the previous group left on screen.
       */
      postcondition: async () => valueIs(field(this.#page, this.#SIGNATORY_NAME), name),
      businessCheck: async () => readPortalValidationError(this.#page),
    });

    await step(this.#steps, {
      name: 'open the signing ceremony',
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () => visible(button(this.#page, 'Sign Now'), SCREEN_TIMEOUT_MS),
      action: async () => {
        await button(this.#page, 'Sign Now').last().click();

        /**
         * The interstitials, all best-effort: which of them appears depends on
         * whether this browser has consented to electronic records before, so
         * insisting on any one of them would fail on a second run.
         */
        await button(this.#page, /^I agree$/i).first().click().catch(() => undefined);
        await button(this.#page, /electronic records and signatures/i)
          .first()
          .click()
          .catch(() => undefined);
      },
      alwaysRun: true,
      // TODO(remap): the ceremony surface is still unseen - see #ceremony().
      postcondition: async () => (await this.#ceremony()) !== undefined,
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * The DocuSign surface - VERIFIED 2026-09-03.
   *
   * It is an IFRAME on the host page, inside a Lightning modal titled
   * "DocuSign Signing Ceremony", not the popup the runbook's "don't exit the
   * pop-up yet" wording suggested. The frame lands on
   * `https://na2.docusign.net/Signing/MTRedeem/v1/<guid>/na?slt=...` first,
   * which is a redeem hop that then navigates to the real signing UI.
   *
   * Two things make this awkward to detect. The page carries ~42 iframes, 41 of
   * them empty and hidden - so the src has to be matched, not the position. And
   * the frame takes time to appear: the first version of this checked for the
   * "Adopt and Sign" button immediately, found nothing, and reported that the
   * ceremony had failed to open when it was simply still loading.
   *
   * A `Frame` is returned rather than a `Page` because both expose `getByRole`,
   * which is all the caller needs.
   */
  async #ceremony(timeoutMs = SCREEN_TIMEOUT_MS): Promise<SigningSurface | undefined> {
    const deadline = Date.now() + timeoutMs;

    do {
      // A popup would still be honoured, in case Anthem changes its mind.
      const popup = this.#page
        .context()
        .pages()
        .find((candidate) => /docusign\.net/i.test(candidate.url()));
      if (popup !== undefined) return popup;

      const frame = this.#page.frames().find((candidate) => /docusign\.net/i.test(candidate.url()));
      if (frame !== undefined) return frame;

      // Only sleep if there is budget left to keep looking - `#ceremonyClosed`
      // calls this with 0 for a single-shot check, on a tight poll of its own.
      if (Date.now() >= deadline) break;
      await this.#page.waitForTimeout(1_000);
    } while (Date.now() < deadline);

    return undefined;
  }

  /**
   * Has the ceremony gone away?
   *
   * A SEPARATE poller from `#ceremony()`, which waits for the frame to APPEAR
   * and returns the instant it finds one. Using that to test for absence is an
   * inversion that cannot work: it returned the still-present frame after a
   * single second, so the postcondition failed immediately on a Finish that had
   * been accepted and was mid-submission. The log showed it plainly - Finish at
   * 11:08:04, "did not take effect" at 11:08:05, against a 300s budget.
   *
   * This polls until nothing DocuSign-shaped is left, which is what completion
   * actually looks like.
   */
  async #ceremonyClosed(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    do {
      if ((await this.#ceremony(0)) === undefined) return true;
      await this.#page.waitForTimeout(2_000);
    } while (Date.now() < deadline);

    return false;
  }

  /**
   * ── THE IRREVERSIBLE ACT ────────────────────────────────────────────────────
   * Adopt and Sign, then Finish. **Finish is the moment the application is FILED
   * with Anthem.** There is no undo, and the carrier may begin processing it.
   * ───────────────────────────────────────────────────────────────────────────
   *
   * TODO(remap): all of it. The runbook's sequence is "click sign in Company
   * officer signature -> Adopt and Sign -> populate a DocuSign signature and
   * date it -> Finish".
   */
  async signAndFile(): Promise<void> {
    this.#assertMaySubmit('signAndFile');

    await step(this.#steps, {
      name: 'sign the company officer signature and file the application',
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      precondition: async () => (await this.#ceremony()) !== undefined,
      action: async () => {
        const surface = await this.#ceremony(DOCUMENT_TIMEOUT_MS);
        if (surface === undefined) {
          throw new BusinessException(
            'The DocuSign signing surface never appeared. Note that a browser attached over CDP ' +
              'cannot see it at all - DocuSign is an out-of-process iframe, so it is only ' +
              'reachable from a Playwright-launched browser.',
          );
        }

        /**
         * The ceremony, as the portal ACTUALLY presents it - read off a
         * screenshot of a live envelope on 2026-09-03, after a first attempt
         * built from DocuSign's generic flow failed:
         *
         *   1. an "AI-Assisted / Summarize this agreement" popover is open on
         *      arrival and covers part of the document. It has to go first, or
         *      it intercepts clicks on the tabs behind it.
         *   2. there is NO "Start" button. Navigation is a red "Sign here" tab
         *      on the left rail and a purple `Sign` chip in the document.
         *   3. the envelope reports **"2 required fields left"**: the signature
         *      AND a `Date (MM/DD/YYYY)` field. Finish is refused until both
         *      are filled - which is why the first attempt's Finish did nothing
         *      and the frame stayed open.
         *   4. `Finish` sits top-right; a separate `Close` bottom-right merely
         *      abandons the ceremony, so the two must never be confused.
         */
        const click = async (name: RegExp, timeout = 15_000): Promise<boolean> =>
          surface
            .getByRole('button', { name })
            .first()
            .click({ timeout })
            .then(() => true)
            .catch(() => false);

        /**
         * 1. Dismiss the AI popover - WITHOUT clicking anything called "Close".
         *
         * This previously did `click(/^close$/i)` and it ABANDONED THE SIGNING.
         * The ceremony has its own `Close` button bottom-right which discards
         * the envelope, and it matches that regex just as well as the popover's
         * X does. The fields were being filled correctly and then thrown away.
         *
         * Escape closes the popover and does not dismiss the ceremony, so it is
         * both sufficient and safe. Nothing here may target "Close" by name
         * again.
         */
        await this.#page.keyboard.press('Escape').catch(() => undefined);

        const now = new Date();
        const signedOn =
          `${String(now.getMonth() + 1).padStart(2, '0')}/` +
          `${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;

        /**
         * 2-4. Complete the envelope.
         *
         * An explicit sequence, not a generic "read the chip and react" loop.
         * That loop looked tidier and was worse: the rail chip RE-RENDERS as
         * soon as it is clicked, so reading its label on the next pass returned
         * null, the loop broke early, and Finish was pressed on an unsigned
         * envelope. Naming the three phases removes that dependency entirely.
         *
         * Control names read out of the live frame on 2026-09-03:
         *
         *   `Start`                             - jumps to the first tab
         *   `Sign Required - Sign Here`         - a signature is outstanding
         *   `Sign Required - Signature Applied` - that signature is done
         *   `Fill In`                           - a non-signature tab remains
         *   `Finish`                            - THE FILING
         */
        const present = async (name: RegExp): Promise<boolean> =>
          surface
            .getByRole('button', { name })
            .first()
            .isVisible()
            .catch(() => false);

        // (a) Jump to the first tab. Absent once anything has been touched.
        await click(/^start$/i, 8_000);

        /**
         * (b) Every signature tab, until none is outstanding.
         *
         * The regex is deliberately LOOSE. `allTextContents()` reports the chip
         * as "Sign Required - Sign Here", but `getByRole` matches the ACCESSIBLE
         * NAME, which is not the same string - tightening this to
         * `/sign required - sign here/` matched nothing and skipped the
         * signature entirely, while `/sign required|sign here/` had already been
         * proven to work on a live envelope. Match on either half, never on the
         * punctuation between them.
         *
         * "Signature Applied" deliberately does NOT match, so an applied
         * signature ends the loop.
         */
        const SIGN_TAB = /sign required(?!.*applied)|sign here/i;

        for (let i = 0; i < 6 && (await present(SIGN_TAB)); i += 1) {
          this.#steps.logger.info({ pass: i }, 'Applying a DocuSign signature');
          await click(SIGN_TAB, 10_000);
          // The Adopt dialog appears the first time only.
          await click(/adopt and sign/i, 12_000);
        }

        /**
         * (c) Every remaining fill-in tab. The known one is the date, and it is
         * a CALENDAR, not a textbox - its month and year appear as `Sep` and
         * `2026` buttons, which is why `fill()` never completed it. Clicking the
         * chip focuses the tab, so the keyboard reaches it whatever it is; the
         * day-grid click is the fallback when the widget refuses typed text.
         */
        const today = String(now.getDate());
        for (let i = 0; i < 6 && (await present(/fill in/i)); i += 1) {
          this.#steps.logger.info({ pass: i }, 'Filling a DocuSign tab');
          await click(/fill in/i, 10_000);

          await this.#page.keyboard.type(signedOn, { delay: 40 }).catch(() => undefined);
          await surface
            .getByRole('button', { name: new RegExp(`^${today}$`) })
            .first()
            .click({ timeout: 4_000 })
            .catch(() => undefined);
          await this.#page.keyboard.press('Escape').catch(() => undefined);
        }

        /**
         * 5. Only now Finish. Logged first, because this is the irreversible
         * act and the log is the only record of the moment it was attempted.
         */
        /**
         * The frame's own control inventory, logged before Finish.
         *
         * The gate-failure hook photographs the HOST page, which shows the
         * ceremony but cannot enumerate what is inside a cross-origin iframe -
         * and CDP attach cannot reach it at all, so there is no cheap way to go
         * and look afterwards. Recording it here means a wrong locator names
         * itself in the log instead of costing another eight-minute run and
         * another production quote.
         */
        const controls = await surface
          .getByRole('button')
          .allTextContents()
          .then((all) => [...new Set(all.map((t) => t.replace(/\s+/g, ' ').trim()))].filter(Boolean))
          .catch(() => []);

        const remaining = await surface
          .getByText(/required fields? left/i)
          .first()
          .textContent()
          .catch(() => null);

        this.#steps.logger.info(
          { signedOn, ceremonyButtons: controls, requiredFieldsLeft: remaining },
          'Pressing Finish - this FILES the application with Anthem',
        );

        /**
         * Let DocuSign settle before pressing Finish.
         *
         * After the last tab is filled the ceremony shows a spinner, dims the
         * overlay and greys the Finish button while it saves. A click into that
         * state is ignored, which looked exactly like a wrong locator: every
         * field was correctly filled - signature, title, printed name and
         * 09/03/2026 - and Finish simply did nothing.
         */
        await this.#page
          .locator('.slds-modal lightning-spinner, .slds-modal .slds-spinner_container')
          .first()
          .waitFor({ state: 'hidden', timeout: 60_000 })
          .catch(() => undefined);

        await surface.getByRole('button', { name: /^finish$/i }).first().click({ timeout: 60_000 });
      },
      /**
       * ── NEVER SKIP THIS STEP ────────────────────────────────────────────────
       * `alwaysRun` is load-bearing, not caution.
       *
       * This postcondition used to be `textVisible(/signed|submitted|complete/i)`
       * and it silently destroyed the whole point of the automation: the wizard
       * rail prints "Completed" beside every finished step, so `/complete/i`
       * matched on arrival, `step()` took the skip-ahead branch, and the FILING
       * NEVER RAN. The run then reported `submitted: 1`. A false success on the
       * one step that cannot be verified by looking at it later is the worst
       * failure this automation can produce.
       * ───────────────────────────────────────────────────────────────────────
       */
      alwaysRun: true,
      /**
       * The ceremony surface going away is the honest signal: DocuSign tears
       * the iframe down when Finish is accepted. It is not anchored on the
       * payload - it cannot be, nothing in the envelope quotes the FEIN back -
       * so `alwaysRun` above is what keeps it safe rather than the specificity.
       */
      /**
       * DOCUMENT_TIMEOUT_MS, not a screen budget: Finish submits the envelope
       * to DocuSign and Anthem, and the frame only tears down once that round
       * trip completes. A 45s wait timed out on a ceremony that was mid-save,
       * reporting a failure on a filing that was in flight - the worst reading
       * to get wrong in either direction.
       */
      postcondition: async () => this.#ceremonyClosed(DOCUMENT_TIMEOUT_MS),
      businessCheck: async () => readPortalValidationError(this.#page),
    });
  }

  /**
   * View PDF -> the editable copy, for the evidence folder.
   *
   * Best-effort by design: the application is already filed by this point, so
   * failing to save a copy must not present as a failed submission.
   *
   * TODO(remap): the runbook says "View PDF -> PRINT -> Save As PDF", which is
   * an OS print dialog and not automatable. The quote PDF turned out to be a
   * popup at a stable Apex endpoint, so the application copy probably is too -
   * look for an `SG_View...Attachment` URL carrying the application id.
   */
  async saveSignedApplication(downloadDir: string): Promise<string | undefined> {
    this.#assertMaySubmit('saveSignedApplication');

    const result = await step<string | undefined>(this.#steps, {
      name: 'save the signed application pdf',
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      action: async () => {
        /**
         * The listener is attached before the click that causes the popup, but
         * it MUST be awaited or caught on every path - an unawaited
         * `waitForEvent` rejects with "Target page, context or browser has been
         * closed" once the runner tears the session down, which surfaces as an
         * unhandled rejection and a non-zero exit on a run that had otherwise
         * succeeded. That is exactly what it did.
         */
        const pending = this.#page
          .waitForEvent('popup', { timeout: 60_000 })
          .catch(() => undefined);

        try {
          await button(this.#page, /view pdf/i).first().click();
          const popup = await pending;
          if (popup === undefined) throw new Error('No PDF popup opened');
          const response = await popup.waitForResponse((r) => /Attachment|\.pdf/i.test(r.url()), {
            timeout: 60_000,
          });
          const to = path.join(downloadDir, 'anthem-signed-application.pdf');
          await writeFile(to, await response.body());
          await popup.close();
          return to;
        } catch (cause) {
          this.#steps.logger.warn(
            { err: cause },
            'Could not save the signed application PDF; the filing itself is unaffected',
          );
          return undefined;
        }
      },
      alwaysRun: true,
      postcondition: async () => true,
    });

    return result.value;
  }
}
