# Anthem CA New Plans — process steps

Sanitized and restructured from the Benefits runbook. **Stage numbers match the
page objects and `processTransaction.ts`.**

> ⚠ **This is a hypothesis, not a specification.** Written before the code, from
> a portal that has since had time to change. Re-map against the live site,
> record divergence in [drift-log.md](drift-log.md), then correct this file.

Placeholders in `{braces}` come from config (see
[sanitization.md](../sanitization.md)); `payload.x` comes from the queue item.

---

## Stage 0 — Gather documents (out of automation scope)

Done by a human before the queue item exists.

- Tax / wage / business documents: Gdrive
- EFT form: Hippo
- Waivers: Hippo
- More than 3 owners: create an ownership letterhead
- Anything missing or needing a signature you cannot provide: **ticket the OA**

The EFT/ACH form is filled by summing premiums for all enrolling members from
the OE census, ticking recurring payments, and completing banking details from
Panda. **Out of PoC scope** — but it is why `payload` carries `bankName`,
`routingNumber` and `accountNumber`.

## Stage 1 — Sign in

1. Sign in to the Anthem Producer portal (credentials from 1Password today;
   `.env` in the PoC).
2. Satisfy MFA — code arrives by email. See [../mfa-gmail.md](../mfa-gmail.md).

## ⚠ The flow changed platform on 2026-09-03

Stages 2.2 onwards below have been **re-mapped against the live portal**. What
the original runbook described no longer exists.

`Create Quote` in Producer Toolbox now **opens a new tab on a different host**:

```
https://elevancehealthfulcrum.my.site.com/broker/s/createquote
```

That is Anthem's **Salesforce Experience Cloud / Vlocity** "Small Group Quote &
Enroll" platform — the one the dashboard's own news carousel announces as "New,
improved". Producer Toolbox is now only the launcher. The new platform is a
single progressive **wizard** with a step rail, not a sequence of separate
screens, and it merges several of the runbook's old stages into one form.

Wizard steps, in order, as the rail reports them:

```
Group Setup → Select Portfolios → Employee Census → Upload Completed Census
            → Select Medical Plans → …
```

Read [drift-log.md](drift-log.md) before this file. Four platform behaviours
break naive automation and are documented there in full:
pre-rendered hidden branches, 1×1px inputs behind their labels, combobox values
on `data-value`, and generated ids.

## Stage 2 — Start the quote  *(re-mapped, verified)*

### 2.1 Reach the new platform — Producer Toolbox
1. Dashboard → **`Start Quote`** tile. It is a `div[role=button]` with the exact
   accessible name `Start Quote`. **Not** "Book of Business → Quotes"; that nav
   item is a `span[role="button"]` menu toggle that does not navigate, and the
   text appears five times.
   The dashboard URL carries the **paid agency code** as its account id:
   `/apps/ptb/dashboard/<paid agency code>`.
2. On `/apps/ptb/quotes/<agency code>`, inside the **`Create a New Quote`** card
   (scope to it — "Previous Quotes" repeats the same two pickers, and driving
   those filters a list):
   - **Select a Market** → `Small Group` (options are `label[role="option"]`:
     Individual / Medicare / Small Group)
   - **Select a State** → `California` (only renders once a market is chosen)
   - each button **renames itself to the selection**, which is the postcondition
3. **`Create Quote`** — renders only once both pickers are set. **Opens a new
   tab** on the Salesforce host. Follow the popup.

### 2.2 Group Setup  *(replaces old 2.2 "license & contract validation" + 2.3 "group account" + part of 6)*

One long form, three sections. Questions appear progressively as earlier ones
are answered.

**Group Details**
1. *Is the group currently covered by Anthem?* → **No** (new plan)
2. *Have you quoted this group with us before?* → **No**
3. `*Group Name` ← `payload.companyName` (max 50 chars)
4. `Employer Tax ID` ← `payload.fein`
5. `*Group ZIP Code` ← `payload.zip`

**Group & Contact Information** — `Group Name`, `State`, `Group ZIP code` and
`Group County` are **readonly** and derive from the above plus a ZIP lookup.
County comes back uppercase and without the word "County" (`SAN FRANCISCO`).
6. `Main Phone Number` ← `payload.companyPhoneNumber` → reformats to `(303) 555-1234`
7. `*Group Contact Name` ← `benefitsAdmin.firstName + ' ' + .lastName`
8. `Title` ← `benefitsAdmin.title`
9. `Street Address` ← `payload.streetAddress1` (27-char limit still applies)
10. `City` ← `payload.city`
11. `Contact Phone Number` ← `payload.companyPhoneNumber`
12. `Contact Email Address` ← `benefitsAdmin.email`

**Agent Details**
13. `*Writing Agent Name or Encrypted TIN` — typeahead over `li` results. Type
    the producer's **full name**; `<producer name>` returns exactly one,
    `<producer name> <producer encrypted TIN>`. Typing only the first name returns seven
    unrelated agencies. The field also accepts an encrypted TIN.
14. `Paid Agency Encrypted TIN` — **auto-populates** from the writing agent
    (`<paid agency name> <paid agency code>`). Assert, do not select.
15. `General Agency Encrypted TIN` — leave `--None--`, per the original runbook.
16. **Continue** → a modal appears *because* the GA is blank:
    "No General Agency Selected… Do you want to select a GA?" →
    **`No, Continue`**. An automation that does not expect it hangs.

### 2.3 Select Portfolios  *(absorbs old 2.3 SIC/eligible count and old stage 3)*
1. `*# of Eligible Employees` ← `payload.eligibleEEs`
2. `SIC Code or Industry Name Search` ← `payload.sicCode`
3. **Quote Eligible Portfolios** → check **`Affordable Care Act (ACA)`**
4. then → **`Medical Only`** radio (vs *Medical + Specialty*)
5. `*Benefit Period` — **readonly and already `Calendar Year`**. Read
   `data-value`; clicking it times out because it is `aria-disabled`.
6. `*Coverage Effective Date` — combobox of allowed dates in **`MMM D YYYY`**
   (no comma), e.g. `Sep 1 2026` ← `payload.coverageEffectiveDate`
7. `Quote Contact Name` / `Phone` / `Email` — **left blank.** This is the
   runbook's "individual receiving all correspondence for this quote".
8. **Continue**

## Stage 4 — Employee Census  *(wizard step `Employee Census`)*

Two paths, both offered on the same screen:
- **`Download Template`** → fill → **`Upload Completed Census`** (its own wizard
  step). This is the `Anthem_NewPlans` macro path.
- Manual entry: `*First Name`, `*Last Name`, `*Date of Birth`, `Select an
  Option`, `+ Add Dependent`, `Add Employee`.

Date of birth format on this screen is **`MMM D, YYYY` — with a comma**
(`Dec 31, 2024`), unlike the effective date. Enrolling people only; waivers never
go on this template.

See [../excel-macros.md](../excel-macros.md) — the macro source has been
recovered, so the Quoting transform is known exactly.

## Stage 5 — Select Medical Plans  *(wizard step `Select Medical Plans`)*

Search each `payload.policies[].planCode` by contract code and **Select Plan**,
not *compare*. A code the portal does not offer is a `BusinessException`.

*Not yet re-mapped against the new platform.*

## Stage 6 — Quote

Generate the quote and download the **Member Rated Quote** PDF.

*Not yet re-mapped against the new platform.*

## Stage 7 — Employer application  *(re-mapped, working)*

Its own wizard at `/broker/s/enrollgroupca-co?c__ContextId=<quoteId>`, headed
"Employer Enrollment Application for Small Groups". The rail:

```
Company Information · Ownership · Medical Coverage · Eligibility ·
LOA/COBRA/Medical Leave · Prior Coverage · Electronic Access ·
General Terms & Agreements · Attestation · Signature Format ·
Print and Sign Now · Send EFT Via DocuSign ·
Member Enrollment Type · Document Checklist
```

### 7.1 Company Information
Most fields carry over from Group Setup. Enter:
- `*Type of Business (Be Specific)` — **config stopgap**, the payload has no field
- `*Date Business Established` ← `payload.dateEstablished`, format **`MM/DD/YYYY`**
- `*Organization Type` ← `payload.entityType`; `llc` → `Limited Liability Company (LLC)`
- Billing address same? **Yes** · Association plan? **No** · Premium Only Plan? **No** · IRC 414? **No**

### 7.2 Ownership
- "Are there any individuals who own all or part of this company?" **Yes**
- `*First Name` / `*Last Name` / `*Percentage of Ownership` ← `payload.owners[0]`
- `*Eligible?` ← `owner.ownerEligible`
- **More than 3 owners** → `BusinessException` (needs a letterhead, out of scope)

### 7.3 Medical Coverage
- Contribution: **Percentage of plan option**, then `*Enter %` ← `eeContribution`
- `*Select Medical Plan` — a plain **4-character text input**; type the base
  contract code, exactly as the runbook says
- Then click **Select Plan** on every quoted plan again on this screen

### 7.4 Eligibility
- Total ← `anteCount` · Eligible full-time ← `fteCount` · Part-time ← **derived**
- Eligible declining ← **derived** from the census's waiving *employees*
- Ineligible ← part-time count
- Small employer? **Yes** · 20–29 hours covered? ← `partTimeCovered`
- One-time waiver of waiting period ← `waivedWP` · Another state? **No**
- **Cal-COBRA / COBRA** — mutually exclusive; answering the applicable one
  reveals `*Number of Cal-COBRA Enrollees`, default **0**
- `*Waiting Period for New Employees` → `First of month after hire date`
- `*Medicare Secondary Payer Rules` → "Medicare is primary for groups with less
  than 20 employees" below 20 eligible

### 7.5 + 7.7 LOA/COBRA/Medical Leave
- Medical and Personal are **comboboxes** (`6 months`, `3 months`), not numbers
- Will they exercise Cal-COBRA/COBRA? **No** · Return to work? **No**

### 7.6 Prior Coverage
Coverage within 12 months of signature? **No**

### 7.8 Electronic Access
**Do NOT check the box** — ticking it REVOKES the agency's authority to act for
the group. The step asserts it is still clear.

### 7.9 General Terms & Agreements
`*Is the group subject to ERISA?` → **Employer is subject to ERISA**

### 7.10 Attestation — **the last editable screen**
The portal warns: *"You won't be able to make changes to the application after
this step. Please review carefully."*
- `*Please indicate how the enrollment will be submitted` → **Online Census
  Enrollment (OCE)** (also offered: Simple Census, 834 EET, Other, Real-time)
- Agent name, agent TIN, agency name, agency TIN and the 100% commission split
  all auto-populate. The runbook's **Section L** check is implemented as an
  assertion on those derived values.

**The automation stops here.** Continue from Attestation locks the application.

## Stage 8 — Signature  *(guarded by `allowSubmit`)*

1. Choose **Sign electronically yourself**
2. Type the signatory's name and title → **Sign Now** → **I agree**
3. Agree to electronic records and signatures → **Continue**
4. Sign in *Company officer signature* → **Adopt and Sign** → date it
5. **Finish** (do not close the pop-up yet)
6. **View PDF → PRINT → Save As PDF** for an editable copy
7. Annotate the coinciding-language waiting period at the top
8. Send the EFT form via DocuSign? **No**

> ⚠ **Irreversible, and the data being synthetic does not make it safe.** This
> files a signed group application on the **production** portal under a real
> producer's license. `allowSubmit` defaults to `false` for that reason.

Verified end to end on 2026-09-03 (run `20260903T172508Z-d0d83a`): quote
`02283813`, DocuSign envelope `F48EBEE7-7B7D-8733-8262-52A5404B04CF`, signed and
filed. Step 5's "do not close the pop-up yet" is load-bearing — `Close`
**discards** the envelope; `Finish` is what commits it.

## Stage 9 — Member Enrollment Type  *(guarded by `allowSubmit`)*

After the signature the portal shows *"You have successfully signed the
document. Please select Continue to move to the next step."*

Two rail steps sit between that and this one — **`Print and Sign Now`** and
**`Send EFT Via DocuSign`**. Neither carries its name in the rail button's text
(only the last three do), so they are invisible to a DOM dump and were finally
identified from a screenshot. Both are crossed by a bare Continue and the rail
marks them Completed, so neither demands input on this path.

Choose how members will enrol. The picklist offers exactly **`Online Census
Tool`, `Ease`, `Real-Time`, `Simple Census`, `API`** and starts at `--None--`.

`memberEnrollmentType` in config, defaulting to **`Online Census Tool`** — the
only value consistent with the `Online Census Enrollment (OCE)` already declared
on Attestation (7.10). Note the two screens word their options differently.

It is a **Vlocity combobox**, verified in-wizard on a real run. The choice also
decides what the next step demands: `Online Census Tool` makes the checklist's
matching row required, taking it from three required documents to four.

## Stage 10 — Document Checklist — **the last step in the rail**

23 upload slots, of which only three are required and Anthem attaches two of
them itself. Full table, the `Submit` aria-label trap and the file-input
mechanism are in [documents.md](documents.md).

**This is where the automation stops.** It asserts the checklist belongs to this
group — anchored on the `Quote` row's file name, which carries this
transaction's quote number — writes the 23 rows to
`artifacts/<runId>/anthem-document-checklist.json`, and ends the transaction.

> The in-wizard screen and the standalone one are **not identical**. Do not
> anchor on the standalone screen's `Application Name` field; it does not exist
> in-wizard. See [documents.md](documents.md).

---

## Out of PoC scope

- **Employee enrollment** — Online Census Tool, OCE census download, macro,
  paste from the Hippo OCE tab, plan selection per employee, waivers tab,
  validate and save
- **Attaching documents** and pressing the checklist's `Submit`. The one
  outstanding required slot is the Electronic Debit Form, which carries banking
  details the payload deliberately does not hold. Both controls are implemented
  behind the `allowSubmit` guard — see [documents.md](documents.md)

## Portal re-entry (useful for resume)

> ⚠ **A group with an application already in progress cannot be re-submitted.**
> Entering the wizard for it redirects to `/broker/s/inprogressapplication`,
> headed **"Application Matching Error"**, whose only control is `Exit`. The
> automation reports this as a BusinessException naming the existing
> application; a human must finish or cancel it first. A second end-to-end test
> run therefore needs a **different group**.

1. Sign in → **Continue to Producer Toolbox**
2. **Menu** → *Quotes* → Previous quotes → Small Group and State → View quotes
3. **Search**, paste the group name or `payload.fein`
4. Click the group → **Related** tab
5. Click the in-progress quote or application

To return to the **Document Checklist** specifically: the community home's
*Recent Applications* card → the group's `Action` link → the Application record
→ **`Upload Documents`**. That renders the same step standalone at
`/broker/s/applicationrecordaction?c__ContextId=<applicationId>&c__isUploadDocument=true`,
which is how it was mapped without walking the whole wizard.

## FAQ worth knowing

| Question | Answer |
|---|---|
| Group address too long | Anthem's limit is **27 characters including spaces**. Shorten a suite to `Ste.`, or download the app, correct it and re-upload |
| Deductible reset year missing | Task List, then the QA sheet, then carrier metadata. If the employer may choose, ticket back. A 1/1 group defaults to policy/plan year |
| Travel & lodging plans | Submittable via portal; use the contract code that includes the T&L rider |
| Saving an editable group app copy | After signing: View PDF → PRINT → Save As PDF |
