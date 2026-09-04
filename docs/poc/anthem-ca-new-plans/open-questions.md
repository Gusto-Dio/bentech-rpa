# Open questions

Things that must be confirmed against the live portal or with the Benefits team
before this automation can be trusted. Answer them as you go, and move each
answer into the relevant doc.

## Answered by the 2026-09-03 re-map

- [x] **Does every screen still exist, in that order?** No. `Create Quote` opens
      a new tab on Anthem's Salesforce/Vlocity platform and stages 2.2–8 were
      restructured into a wizard. See [drift-log.md](drift-log.md).
- [x] **What is the actual validation-error container?** SLDS
      `.slds-form-element__help`, also exposed as `role="alert"`, with the
      wording `Error: <field> is required.`
- [x] **Which fields auto-populate?** On Group Setup: `Group Name`, `State`,
      `Group ZIP code`, `Group County` (readonly, derived from the ZIP lookup;
      County is UPPERCASE and drops the word "County"). `Paid Agency Encrypted
      TIN` populates from the writing agent. On Portfolios, `Benefit Period` is
      readonly and pre-set to `Calendar Year`.
- [x] **Is there a stable signed-in-only landmark?** Yes —
      `getByText('Book of Business').first()`, and the dashboard URL carries the
      agency code (`/apps/ptb/dashboard/<paid agency code>`).
- [x] **What does the MFA email look like?** `noreply@broker.anthem.com`,
      subject "One-Time Security Code", six digits.

## Still open, and blocking a real run

- [x] ~~The seed payload's contract codes are not offered~~ — **replaced** with
      codes read off the live plan list on 2026-09-03: `8VAY 8VAN` (Bronze),
      `8V5C` (Gold), `8V63` (Platinum), base `8VAY`. They will go stale the same
      way — Anthem rotates codes by plan year — so treat "contract code not
      offered" as a data signal, not a broken automation.
- [ ] **Re-running does not resume.** `create the quote` is `alwaysRun`, so
      every run builds a fresh quote rather than re-entering the in-flight one.
      The runbook's portal re-entry path (Quotes → search by FEIN → in-progress
      application) is not implemented, which is why development leaves several
      quotes for the same group behind.
- [ ] **The payload has no `typeOfBusiness`.** The employer application requires
      "Type of Business (Be Specific)", which the OA reads off the Task List /
      QA sheet. It is currently a config stopgap, which means every group from
      one environment claims the same line of business. The shared payload
      schema needs the field.
- [ ] **How do the quote PDF bytes come back?** The download card opens a popup
      at `/broker/apex/SG_ViewQuoteAttachment?...&dtype=pdf`; fetching that URL
      out of band gives 401 (API context) or the Visualforce HTML shell
      (in-page). The popup's own navigation response is the remaining candidate.
- [ ] **Does the census template's Relationship column accept `Spouse` for a
      domestic partner?** The `Key` sheet lists only Employee/Spouse/Child, so
      that is what the port emits — but the mapping has not been exercised with
      a real domestic partner.
- [x] ~~General Terms & Agreements and Attestation unmapped~~ — **done**.
      ERISA declaration and the OCE enrollment indication are built, and the
      runbook's Section L check is now an assertion on the auto-populated agency
      and agent.
- [ ] **`Signature Format` and the DocuSign flow are still unmapped**, and
      deliberately: mapping them means signing a real application.
      `lockApplication()` fronts the Continue that makes the application
      uneditable and refuses unless `allowSubmit` is true.
- [ ] **`Search by Contract Code or Product Name` does not filter.** Accepts
      text, list unchanged. Worth raising with Anthem — plan selection currently
      depends on metal-level filtering instead.

## Must be answered by the Benefits team

- [x] ~~The real values for every `REPLACE_ME` in `config/config.dev.json`~~ — the
      Benefits team supplied the producer and paid-agency values and they are
      verified against the live portal. They now come from **`.env`** rather than
      config: `ANTHEM_PRODUCER_FIRST_NAME`, `ANTHEM_PRODUCER_LAST_NAME`,
      `ANTHEM_PAID_AGENCY_CODE`, resolved through `ctx.secrets`
      (see [../sanitization.md](../sanitization.md))
- [x] ~~**What is the default answer on `Send EFT Via DocuSign`?**~~ —
      **answered 2026-09-03.** The screen asks *"Would you like to send the EFT
      form through DocuSign?"* with Yes/No radios and **No pre-selected**. So the
      earlier runs that crossed it with a bare Continue did *not* send EFT forms
      to employers. The automation now answers No explicitly anyway — a default
      is not a decision — and the screen is captured to
      `artifacts/<runId>/<ref>-post-signing-screen-1.{json,png}` on every run
- [ ] Which mailbox and Gmail label receive the MFA codes
- [ ] Is there **any** carrier test group or sandbox? Everything about this PoC
      would be easier if there were
- [ ] Who is allowed to flip `allowSubmit`, and under what circumstances?

- [ ] **Does `Create Quote` need to tolerate a SAML re-challenge?** A container
      run reusing a host session hit an Okta password prompt on that hop
      (`login.broker.anthem.com/app/.../sso/saml`) instead of Group Setup, while
      the host passed the same step. The container is NOT the variable — it
      reaches the platform fine via the `Small Group Quote & Enroll` launchpad
      tile. Most likely the community/SAML session was not yet established on
      that route. Confirming it means driving `Create Quote`, which writes, so it
      is blocked by the production freeze
- [ ] **Is a full unattended container run viable?** Login and navigation are
      proven in the container; everything past `Create Quote` is not, for the
      same reason. Headed under xvfb also costs more CPU and memory than
      headless, and has not been load tested with concurrent runs

## Decisions deferred to phase 2

- [ ] Orchestrator queue name and folder (the integration is built; see
      [../../orchestrator.md](../../orchestrator.md))
- [ ] 1Password or vault adapter behind `SecretProvider`
- [ ] Moving from `GmailProfileMfaProvider` to `GmailApiMfaProvider`
- [ ] Whether artifacts should ship to an Orchestrator storage bucket after each
      run (`BucketClient.uploadFile` already exists)
