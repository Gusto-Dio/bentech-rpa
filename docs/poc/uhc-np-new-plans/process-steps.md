# UHC New Plans — process steps

Sanitized and restructured from the Benefits runbook. **Stage numbers match the
page objects and `processTransaction.ts`.**

> ⚠ **This is a hypothesis, not a specification.** Written before the code, from
> a portal that has since had time to change. Re-map against the live site,
> record divergence in [drift-log.md](drift-log.md), then correct this file.

---

## Stage 1 — Sign in

Sign in to the UHC portal and satisfy MFA (code by email — see
[../mfa-gmail.md](../mfa-gmail.md)).

## Stage 2 — Case  *(implemented)*

### 2.1 Open the dashboard
1. **Small Group Quoting & Renewals** (top left) → **Samx One**
   (all states except out-of-scope markets)
2. **New Business Dashboard**

### 2.2 Resume or create
- **If automation already started this submission:** search for the group by
  clicking **Case Name**, and skip to where it stopped.
- **Otherwise:** click **New Case**.

> This is why resumability is first-class here. The process was already designed
> around partial automation. `findExistingCase()` is the entry point, and
> creating a **second** case for a group that already has one is the worst
> failure available in this automation.

### 2.3 Owner assignment
1. Under *Owner Assignment* → **Edit Owners**
2. **Search Producers**
3. First name `{producerFirstName}`, last name `{producerLastName}` → **Search**
4. **Assign** the producer
5. **Save & Continue**

## Stage 3 — Employer information

### 3.1 Employer information
- Company name ← `payload.companyName`
- Effective date ← `payload.coverageEffectiveDate`
- Franchise Code: leave blank at this stage

### 3.2 Company locations
- Zip ← `payload.zip`; **confirm it generates the county**
  (`payload.county`). A silently missing county surfaces much later as a rating
  error, so assert it
- Total employees applying (active + COBRA) ← count enrolling in a UHC plan
- Total eligible employees ← `payload.eligibleEEs`
- FTE count ← `payload.fteCount`

### 3.3 Primary contact
- Benefits admin name and email ← `payload.benefitsAdmin`
- Phone ← `payload.companyPhoneNumber` — **digits only.** SAMx rejects dashes
  and parentheses (`digitsOnly()` exists for this)
- Phone type **Business**, role **Benefit Administrator**, preferred contact
  **Email**
- Additional contacts: skip unless the TTS notes ask for them

### 3.4 Products to quote
- Check every product the group is offering with UHC (`payload.policies`)
- SIC code ← `payload.sicCode` — you may have to type it before the dropdown
  offers a match
- Cannabis-related industry? **No**

Then **Employee Census** (bottom right).

## Stage 4 — Bulk census

1. Download the **SAMx Portal Bulk Census** template from the quoting stage
2. Transform the Hippo OE census into it — the `SAMx_PortalBulkCensus` port, see
   [../excel-macros.md](../excel-macros.md)
3. **UPLOAD** → **SAMx Template** → upload the file
4. If the *Employee Info* sheet has errors, a popup lists them all. **No employee
   data loads at all unless everything is correct** — so correct and re-upload
5. If the error concerns company profile information, upload it from the Company
   Information page instead
6. Once all employees/dependents load: **Plan Selection**

Columns to verify: **R** medical coverage type, **S**/**AA** medical waiver
reason, **Y** waive all products, **Z** medical plan code, **AQ** SSN.

Waiver reason mapping — only one is documented:
`individual_policy` → **Individual Exchange**. Read the rest off the portal's
dropdown during the re-map; do not guess.

## Stage 5 — Plan selection and proposal

1. **Confirm the rating method** (Age-banded or Composite) — `payload.ratingStructure`
2. Filter plans by pasting the plan name from `payload.policies[].planName`
3. Select the plan **with the domestic-partner rider**. Some also carry vision;
   that is fine. **Never select the "aged 29" rider** (orange text above the rate)
4. Repeat for all offerings, verifying riders each time
5. **Quote Review** → select the plans again
6. **Confirm the rating method again** — the runbook insists on before *and*
   after, which usually means it has silently reset on somebody
7. Update the employer contribution percentage:
   - `payload.policies[].eeContribution` / `dependentContribution`
   - **California group at 100% but not everyone enrolling → enter 99%** and note it
   - **Flat-dollar contribution → enter 50%**
8. Screenshot the contribution for Gdrive
9. Enter TIN ← `payload.fein` → **Save**
10. **Generate Proposal** → **Generate** → **PDF**; keep it
11. **Move to Enrollment**

## Stage 6–7 — Employer application

### 6.1 General information
- Requested effective date matches `payload.coverageEffectiveDate`
- Group name for ID card ← `payload.companyName`
- Street address ← `payload.streetAddress1`
- Years in business ← derived from `payload.dateEstablished`
- Organization type ← `payload.entityType`
- Employees other than yourself and spouse last year? **Yes**
- Medical benefit plan option ← `payload.medicalDeductibleReset`
  (Task List → QA sheet → carrier metadata; a 1/1 group defaults to plan year)
- Domestic partner coverage: **Yes**
- Workers comp ← `payload.workersComp`

### 6.2 Eligibility
- Subject to ERISA? **Yes** (rare religious exemptions aside)
- Continue medical coverage during leave of absence? **Yes**
- **Which continuation applies?** `< 20 FTE → State`, `>= 20 FTE → COBRA`
- **Which primary option?** `< 20 EEs → Medicare`, `>= 20 EEs → Plan Primary`

> Both thresholds are easy to invert. Compute them and log which branch was taken.

### 6.3 Waiting period
Hippo's vocabulary (no waiting period / 1st of month after hire / 1st of month
after 30-60-90 days) does **not** map one-to-one onto UHC's (Date of Event /
First of the Following Month / First of the Following Month after Specified
Duration / Date of Hire / Specified Duration).

**Read the mapping off the portal's dropdown during the re-map** and record it in
[field-map.md](field-map.md).

- Termination lag ← Hippo, end of the medical policy listing
- Waiting period waived for initial enrollees ← `payload.waivedWP`
- Waived for rehires: **No**

### 6.4 Contribution and participation
- Employee and dependent contribution percentages ← `payload.policies`
- Eligible employees / ATNE / FTE should auto-populate from the quote
  (`payload.eligibleEEs`, `payload.anteCount`, `payload.fteCount`)
- Minimum hours for eligibility ← TTS notes; adjust if part-timers are offered
  coverage (`payload.partTimeCovered`)

### 6.5 Consumer-driven health plans
- HSA bank: **none**; if the group has an HSA plan, **other** unless TTS says
- (Illinois only) ICHRA: **No**

### 6.6 Additional eligibility
- Uses a PEO/ELC/HRO/ASO? ← Task List / TTS
- Is a PEO/ELC/HRO/ASO? **No**
- Sponsors a plan covering more than one employer? ← Task List / TTS
- Common ownership with another business? **No** unless stated

### 6.7 Current carrier
- Current medical coverage: **NONE**
- Dependents currently disabled or hospitalised? ← Task List / TTS

### 7.1 Producer
- General agent information: leave blank
- Producer 1 ← `{producerFirstName} {producerLastName}`
- Commission ← `{commissionPercentage}`%
- Commission payable to → **Search** → **General Agent**
- Add general agent ← `{generalAgentName}`
- Franchise code ← `{generalAgentFranchiseCode}`
- Email ← `{generalAgentEmail}`
- PCIS ID ← `{pcisId}`

## Stage 8 — Attestation  *(guarded by `allowSubmit`)*

1. Check all boxes and sign as the producer
2. **Submit Attestation**
3. **Print Completed Form** for Gdrive
4. **Return to Enrollment Home**

> ⚠ **Signing on the producer's behalf, on production.** `allowSubmit` defaults
> to `false` for this reason.

---

## Out of PoC scope

- **Employee enrollment** — import summary, per-employee edits, owner/workers-comp
  questions, dependent disability, `{dummyPcpCode}` for Select Plus plans,
  Close Enrollment, attestation
- **Payment / billing** — Direct Debit Authorization from `payload.bankName`,
  `routingNumber`, `accountNumber` (tokenized alias from Plaid if that is the
  only option)
- **Required documents** upload — portal accepts **underscores only**, no other
  special characters
- **Finalize** → Member Group ID → copy to Hippo → screenshots

## Portal re-entry

1. New Business Dashboard in SAMx
2. Find the group (⌘F, or click **Case Name** and type it)
3. **Actions** → **View**

Status **Pending Acceptance** means the case is being installed.
