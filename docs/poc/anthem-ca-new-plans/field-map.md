# Anthem CA — field map

Payload/config field → portal field, per screen.

> ⚠ **Every row is UNVERIFIED.** Derived from a runbook, not from the portal.
> Confirm each during the re-map, correct this file, and mark corrections so the
> diff stays visible. The **Locator** column is empty on purpose — fill it with
> the real locator you derive from the accessibility tree.

Legend: `payload.x` = queue item · `{x}` = config · **derived** = computed, not copied

> **Re-mapped 2026-09-03.** Rows marked ✓ were read off the live portal. The
> flow moved to Anthem's Salesforce/Vlocity platform — see
> [process-steps.md](process-steps.md) and [drift-log.md](drift-log.md).
>
> Locator conventions for that platform: radios and checkboxes are addressed by
> **clicking their `label`**, scoped to the fieldset whose direct-child `legend`
> matches; combobox values are read from **`data-value`**, not `value`.

## Producer Toolbox — reaching the new platform

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Start Quote tile | — | `getByRole('button', { name: 'Start Quote', exact: true })` | ✓ |
| Select a Market | *Small Group* | card-scoped `getByRole('button', { name: /select a market/i })` then `getByRole('option', { name: 'Small Group', exact: true })` | ✓ |
| Select a State | *California* | same shape; only renders after a market | ✓ |
| Create Quote | — | card-scoped `getByRole('button', { name: 'Create Quote', exact: true })` — **opens a new tab** | ✓ |

## Group Setup — Group Details

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Is the group currently covered by Anthem? | *No* | fieldset legend `Is the group currently covered by Anthem?` → `label.slds-radio__label` "No" | ✓ |
| Have you quoted this group with us before? | *No* | same shape | ✓ |
| \*Group Name | `payload.companyName` — **max 50** | `getByLabel('*Group Name')` | ✓ |
| Employer Tax ID | `payload.fein` | `getByLabel('Employer Tax ID')` | ✓ |
| \*Group ZIP Code | `payload.zip` | `getByLabel('*Group ZIP Code')` | ✓ |

## Group Setup — Group & Contact Information

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Group Name | **readonly**, derived | — do not fill | ✓ |
| Main Phone Number | `payload.companyPhoneNumber` | `getByLabel('Main Phone Number')` — reformats to `(303) 555-1234`, compare digits only | ✓ |
| \*Group Contact Name | `benefitsAdmin.firstName + ' ' + .lastName` | `getByLabel('*Group Contact Name')` | ✓ |
| Title | `benefitsAdmin.title` | `getByLabel('Title')` | ✓ |
| Street Address | `payload.streetAddress1` — **max 27 incl. spaces** | `getByLabel('Street Address')` | ✓ |
| City | `payload.city` | `getByLabel('City')` | ✓ |
| State / Group ZIP code / Group County | **readonly**, derived from ZIP. County is UPPERCASE and drops "County" | — do not fill, do not assert payload equality | ✓ |
| Contact Phone Number | `payload.companyPhoneNumber` | `getByLabel('Contact Phone Number')` | ✓ |
| Contact Email Address | `benefitsAdmin.email` | `getByLabel('Contact Email Address')` | ✓ |

## Group Setup — Agent Details

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| \*Writing Agent Name or Encrypted TIN | `{producerFirstName} {producerLastName}` | `input[type=search]`; type the **full name**, pick the single `li`. Resolves to `<producer name> <producer encrypted TIN>` — note the middle initial, so the config string is not the displayed string | ✓ |
| Paid Agency Encrypted TIN | `{paidAgencyCode}` | **auto-populates** from the writing agent — assert `<paid agency name> <paid agency code>`, do not select | ✓ |
| General Agency Encrypted TIN | *left blank* | stays `--None--` | ✓ |
| (modal) No General Agency Selected | — | `getByRole('button', { name: 'No, Continue' })` — appears **because** the GA is blank | ✓ |

## Select Portfolios

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| \*# of Eligible Employees | `payload.eligibleEEs` | `getByLabel('*# of Eligible Employees')` | ✓ |
| SIC Code or Industry Name Search | `payload.sicCode` | `getByLabel('SIC Code or Industry Name Search')` | ✓ |
| Affordable Care Act (ACA) | *checked* | click `label` "Affordable Care Act (ACA)" | ✓ |
| Medical Only | *selected* | click `label.slds-radio__label` "Medical Only" — only appears after ACA | ✓ |
| \*Benefit Period | *Calendar Year* | **readonly + aria-disabled, already set.** Read `data-value`; clicking times out | ✓ |
| \*Coverage Effective Date | `payload.coverageEffectiveDate` | combobox; format **`MMM D YYYY`** (no comma), e.g. `Sep 1 2026` | ✓ |
| Quote Contact Name / Phone / Email | *left blank* | assert empty | ✓ |

## Employee Census

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Download Template | — | `getByRole('button', { name: 'Download Template' })` | ✓ |
| Upload Completed Census | — | its own wizard step | ✓ |
| \*First Name / \*Last Name | census row | manual-entry path | ✓ |
| \*Date of Birth | census row | format **`MMM D, YYYY` — with a comma** (`Dec 31, 2024`) | ✓ |
| + Add Dependent / Add Employee | — | manual-entry path | ✓ |

## Stage 5 — Select Medical Plans *(not yet re-mapped)*

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Contract code search | `payload.policies[].planCode` | | ☐ |
| Select Plan (not compare) | one per policy | | ☐ |

## Employer application — verified 2026-09-03

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| \*Type of Business (Be Specific) | `{typeOfBusiness}` — **config stopgap** | `getByLabel` | ✓ |
| \*Date Business Established | `payload.dateEstablished` → **`MM/DD/YYYY`** | `getByLabel` | ✓ |
| \*Organization Type | `payload.entityType` → `Limited Liability Company (LLC)` | combobox | ✓ |
| Billing same? / Association? / POP? / IRC 414? | *Yes* / *No* / *No* / *No* | radio by legend | ✓ |
| Owner first/last/percentage | `payload.owners[0]` | `getByLabel` | ✓ |
| \*Eligible? | `owner.ownerEligible` | radio by legend | ✓ |
| Medical contribution | *Percentage of plan option* | `label.slds-radio__label` | ✓ |
| \*Enter % | `policies[0].eeContribution` | `getByLabel` | ✓ |
| \*Select Medical Plan | **base contract code**, `maxlength=4` plain text | `getByLabel` | ✓ |
| Select Plan (per plan, again) | `payload.policies[]` | card-scoped button | ✓ |
| Total / full-time / part-time / declining / ineligible | payload + **derived** (`src/derived.ts`) | `getByLabel` | ✓ |
| Cal-COBRA / COBRA | `payload.continuation` — **mutually exclusive** | radio by legend | ✓ |
| \*Number of Cal-COBRA Enrollees | *0* — appears only after Cal-COBRA=Yes | `getByLabel` | ✓ |
| \*Waiting Period for New Employees | `policies[].waitingPeriod` → `First of month after hire date` | combobox | ✓ |
| \*Medicare Secondary Payer Rules | **derived** from `fteCount` | combobox (commits a code) | ✓ |
| Medical / Personal leave of absence | *6 months* / *3 months* — **comboboxes** | combobox | ✓ |
| COBRA option exercised? / Return to work? | *No* / *No* | radio by legend | ✓ |
| Prior coverage in 12 months? | *No* | radio by legend | ✓ |
| Electronic access box | **do NOT check** — asserted clear | checkbox | ✓ |
| \*Is the group subject to ERISA? | *Employer is subject to ERISA* | combobox (`data-value` is a CODE) | ✓ |
| \*how the enrollment will be submitted | *Online Census Enrollment (OCE)* | combobox | ✓ |
| Agency Name / Agent Name (Section L) | **auto-populated** — asserted, never typed | `getByLabel` | ✓ |

## Stage 8 — Signature *(deliberately not mapped)*

`Signature Format` and the DocuSign flow beyond it are not mapped, because
mapping them means signing a real application.
`EmployerApplicationPage.lockApplication()` fronts the Continue that makes the
application uneditable and refuses unless `allowSubmit` is true.

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Signatory name / title | `payload.benefitsSignatory` | | ☐ |

## Census template columns — the `Anthem_NewPlans` Quoting tab

**Recovered from the macro**, not guessed: the `.xlsm`'s VBA is MS-OVBA
compressed, not compiled, and `Module10` decompresses intact. Ported in
`src/census/quoting-tab.ts` with unit tests asserting produced cells.

Enrolling people only — the split is `Waiver Reason - Medical` being populated.
The macro itself does **not** filter; the runbook has a human do it first, so the
port does it via `HippoCensusReader.splitByEnrollment`.

| Out | Hippo census column | Transform | ✓ |
|---|---|---|---|
| A | `First Name` | — | ✓ |
| B | `Last Name` | — | ✓ |
| C | `Gender` | — | ✓ |
| D | `Relationship` | `"Partner"` → `"Spouse"` as a **substring** (xlPart), so `Domestic Partner` becomes `Domestic Spouse` | ✓ |
| E | `DOB` | Excel serials converted to ISO; `33192` → `1990-11-15` | ✓ |

Header row is deleted; the tab is five columns of values only.

**Still to confirm against the live template:** Anthem's downloaded template is
the authority on column names, order and start row. If it disagrees with the
five above, the template wins — rebuild the mapping and log it in
[drift-log.md](drift-log.md). Also confirm the Relationship column's accepted
values; `Domestic Spouse` is what the macro has been sending, which is not
obviously what the portal wants.
