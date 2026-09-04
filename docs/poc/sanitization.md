# Sanitization

What was removed from the source material, and what replaced it.

## Why

The source runbooks name a real producer, a real agency with its code, real
franchise and PCIS identifiers, and a real ops mailbox. The censuses carry
PII-shaped rows. None of that belongs in a repository, so the repo holds only
sanitized derivatives and Gdrive stays the source of truth.

`docs/poc/**/*.{zip,xlsx,xlsm,docx,pdf}` is gitignored precisely so the
originals cannot be committed by accident.

## What was already synthetic

Two things needed no sanitizing, and it is worth knowing why so nobody
"improves" them:

- **`The Company LLC`** and its field values — the source document says so
  explicitly ("This is dummy data and does not reflect a real company"). It is
  now the seed payload for both PoCs.
- **The census SSNs** — `000-12-3456` and similar. The `000` area prefix is
  never issued, so these are invalid by construction, which is exactly what
  test data should be.

## What was replaced

| Source value | Replaced with | Where the real value goes |
|---|---|---|
| Portal username | `ANTHEM_PORTAL_USERNAME` / `UHC_PORTAL_USERNAME` | `.env` |
| Portal password | `ANTHEM_PORTAL_PASSWORD` / `UHC_PORTAL_PASSWORD` | `.env` |
| Producer first/last name (Anthem) | `producerFirstNameEnv` / `producerLastNameEnv` = the env-var NAMES | `.env` (gitignored) |
| Paid agency code (Anthem) | `paidAgencyCodeEnv` = the env-var NAME | `.env` (gitignored) |
| Paid agency **name** (Anthem) | removed — no code ever read it | — |
| Producer first/last name (UHC) | `producerFirstName` / `producerLastName` = `REPLACE_ME` | `config/config.<env>.json` — **still the old shape**, see below |
| General agent name | `generalAgentName` = `REPLACE_ME` | UHC config |
| General agent franchise code | `generalAgentFranchiseCode` = `REPLACE_ME` | UHC config |
| General agent email | `generalAgentEmail` = `REPLACE_ME` | UHC config |
| PCIS ID | `pcisId` = `REPLACE_ME` | UHC config |
| Dummy PCP code | `dummyPcpCode` = `REPLACE_ME` | UHC config |
| A payroll-summary PDF whose **filename named a real company** | not committed | Gdrive |
| Producer's own **encrypted TIN** (distinct from the agency's) | `<producer encrypted TIN>` in prose | Benefits runbook |
| Paid agency code / encrypted TIN / dashboard account id | `paidAgencyCode` = `REPLACE_ME`; `<paid agency code>` in prose | Anthem config |
| The census template's **example names** and its `lastModifiedBy` author metadata | synthetic names; metadata stripped | — (the original stays in Gdrive) |

## Re-sanitized before publishing (2026-09-03)

The Anthem config had been **filled in** with the real producer and paid-agency
values during the live PoC, and the same values had spread into
`automations/group-submission/anthem-ca-new-plans/README.md`, the page-object
comments, `drift-log.md`, `field-map.md`, `process-steps.md` and
`open-questions.md`. The config even carried a comment arguing they were
"business config, not secrets".

They are a **real named individual** holding an insurance licence, that person's
encrypted TIN, and an agency code that doubles as the agency's encrypted TIN and
the portal's account id. That is exactly what the table above says must not be
committed, so all four are back to `REPLACE_ME`, and the prose uses
`<producer name>` / `<paid agency code>` style placeholders. The *findings* were
kept — the middle-initial mismatch, the auto-populating paid agency — because
those are the parts that cost time and none of them need the real value to be
useful.

`anthem-census-template.xlsx` is Anthem's own downloaded workbook and two tests
read it, so it stays. Its `Example Census` sheet held sixteen real-looking
person names and `docProps/core.xml` named the person who last saved it in 2019.
The names are now synthetic and the author metadata is gone; the header row and
`Key` sheet — the only things the tests and `write-template.ts` depend on — are
untouched.

`REPLACE_ME` is deliberate: it is structurally valid so `rpa validate` passes,
and `rpa orchestrator check`-style diagnostics or the first real run will name
exactly what is still a placeholder. A plausible-looking fake value would be
worse — it would look configured.

## What was deliberately kept

Internal system names — **Hippo, Gdrive, Panda, SAMx, Task List, TTS notes, QA
sheet**. They are internal tool names, not secrets, and stripping them would
make the process documentation unusable to the people who have to maintain it.

## The rule going forward

No real group, member or employee data in this repo. Not in seed files, not in
fixtures, not in a comment, not in a screenshot committed as evidence. The
`member-submission` domain README states the same rule for the same reason.

If you need a second test group, invent one. If you need to reproduce a
production failure, put the payload in the ticket, not in `data/seed/`.

## The Anthem values moved to `.env` (2026-09-03, later the same day)

Re-sanitizing them to `REPLACE_ME` left the automation **unrunnable**: the only
way to drive it was to paste a real producer's licence identity back into
`config/config.dev.json` — a tracked file — and remember to scrub it afterwards.
That is a control which depends on nobody forgetting, and it had already been
forgotten once, spreading the values across seven files.

So the Anthem four took the route the portal credentials already take, which is
the seam CLAUDE.md rule 3 describes: **config holds the name of an environment
variable, `.env` holds the value.** `resolveProducerIdentity()` reads them
through `ctx.secrets` at the start of each transaction, and a missing one is a
`SystemException` at that point rather than a mystery failure on the
writing-agent screen.

`paidAgencyName` was dropped outright — nothing in the codebase read it, so it
was one real value being handled for no purpose.

> **UHC still has the old shape.** `producerFirstName` / `producerLastName`,
> `generalAgentName`, `generalAgentEmail`, `generalAgentFranchiseCode`,
> `pcisId` and `dummyPcpCode` are still plain `REPLACE_ME` config values in
> `automations/group-submission/uhc-np-new-plans`. They have the same problem
> and want the same fix; it was left alone rather than changed blind, since that
> automation has not been driven this far.
