# Anthem CA — the `Document Checklist` step

The **last step in the wizard rail**, and the boundary of this PoC: the
automation reaches it, records its state, and stops. Nothing is uploaded and
`Submit` is never pressed.

> **This page used to describe eight slots, an `Upload Documents` button and an
> `Uploads Complete` control.** All three were wrong — it was written from the
> Benefits runbook, before the process moved to Salesforce/Vlocity. Everything
> below is read off the live screen (2026-09-03); the corrections are itemised in
> [drift-log.md](drift-log.md).

## The screen

Reached in-wizard after `Member Enrollment Type`, and also standalone from the
Application record's `Upload Documents` button at:

```
/broker/s/applicationrecordaction?c__ContextId=<applicationId>&c__isUploadDocument=true
```

Two accordion sections — `Step 1: Download & Complete Documents` and
`Step 2: Upload Documents` — over one table, plus `Progress: N%` and
`N out of 23 documents uploaded`.

**The two entry points differ, and it matters.** In-wizard, Step 1 carries a
`Download OCE Template` button and the footer is
`Cancel · Save for later · Previous · Submit`. Standalone, there is an
`Application Name` textbox and the footer is just `Submit · Cancel`. That field
is **absent in-wizard** — a postcondition that read it failed a step on a screen
it had correctly reached, which is [drift-log.md](drift-log.md)'s entry on
mapping a step from the wrong entry point. Anchor on the `Quote` row's file
name, which carries the quote number and is present on both.

| Column | Notes |
|---|---|
| (unnamed) | Holds the required marker, `lightning-icon.required-icon` |
| `No` | Row number |
| `Document Name` | The slot |
| `File Name` | Empty when nothing is attached — **this**, not `Status`, is how the automation decides |
| `Date Uploaded` | |
| `Status` | `Submitted` / `Not submitted` / `Document Signed` / `Uploaded`. **Wording is not stable** — the same row read `Document Signed` on one visit and `Submitted` on the next, so it is never compared |
| `Action` | A decorative `Choose File` button over the real `input[type=file]` |

Controls: `Help`, `X Remove All`, 23 × `Choose File`, `Submit`, `Cancel`.

## The 23 slots, in row order

`data-index` on the row's file input matches this order, 0-based.

| # | Document Name | Required | State on arrival |
|---|---|---|---|
| 0 | Employer Application | **yes** | attached by Anthem — the signed `SG_OHIX_CA_ER_0126.pdf` |
| 1 | Electronic Debit Form/Live Check Copy | **yes** | **outstanding** |
| 2 | Quote | **yes** | attached by Anthem — the generated member-rated quote |
| 3 | Approval | no | |
| 4 | Account Structure | no | |
| 5 | Online Census Tool | **conditional** | **outstanding** when `Member Enrollment Type` = `Online Census Tool` |
| 6 | Anthem Spending Accounts Questionnaire | no | |
| 7 | Legal Documents | no | |
| 8 | Waivers | no | |
| 9 | POP Section 125 App/Check | no | |
| 10 | Quarterly Withholding Rep | no | |
| 11 | Payroll | no | |
| 12 | Attestation Form | no | |
| 13 | Prior Carrier Bill | no | |
| 14-16 | REQ OUT 1-3 | no | |
| 17-19 | REQ IN 1-3 | no | |
| 20-22 | OTHER 1-3 | no | |

Three rows are always required and Anthem attaches two of them itself. A fourth
becomes required **because of the enrollment channel**: selecting
`Online Census Tool` on the preceding `Member Enrollment Type` step marks the
matching row required. Verified by reading the same checklist either side of that
step — three required while the field was `--None--`, four once it was set.

**So on arrival the outstanding required documents are the Electronic Debit Form
and the Online Census Tool census** — which is why `readChecklist()` reports
`required` per row rather than trusting a fixed list.

## Why the automation stops here rather than uploading

The Electronic Debit Form wants the group's **banking details**, and this PoC's
payload carries references, not records (CLAUDE.md rule 2) — so there is nothing
to put there and inventing it is not an option. The Online Census Tool slot wants
the completed OCE census, which is the employee-enrollment stage and out of scope
for a different reason. `attachDocument` is
implemented and guarded, but it is not wired into the process.

`payload.s3Link` points at the group's submission folder, which is where a real
run's documents would come from. A missing required document is a
**BusinessException** — the runbook's instruction is to ticket the OA, i.e. a
human has to produce it.

## Two locator traps on this screen

- **`Submit` cannot be found by role.** Its visible text is `Submit`, its
  `aria-label` is `documentCheckListSubmit`, and an aria-label wins — so
  `getByRole('button', { name: 'Submit' })` matches **nothing**. The repo's
  `button()` helper filters on text and does find it.
- **`Choose File` is not the upload mechanism.** Each row owns an
  `input[type=file].hidden-file-input[data-index=N]`, accepting
  `.pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx,.txt,.csv,.xlsm,…` at max 10 MB
  each. `setInputFiles` on that input works; clicking the button opens an OS
  file picker, which cannot be driven.

## Missed a document after submitting?

If the group was submitted a day or more ago, **wait for the carrier to send the
pending item** rather than uploading late and causing confusion. Otherwise
reopen the Application record and use its `Upload Documents` button, which
returns to this same screen.
