# Anthem CA New Plans (PoC)

Submits a new-plan group application to the **Anthem California producer
portal**: quote, group account, census, plan selection, and the employer
application.

| | |
|---|---|
| **Id** | `group-submission/anthem-ca-new-plans` |
| **Domain** | `group-submission` |
| **Owner** | @gusto/benefits-rpa-group-submission |
| **Session** | browser (Chromium, headless by default) + **MFA** |
| **Queue** | `group-submission.anthem-ca-new-plans` (local JSON in phase 1) |
| **Status** | **Login + stage 2 verified live. Stages 2.2–8 being re-mapped: the portal moved platform** |

## Read this before running it

This runs against the **production Anthem portal**. There is no sandbox.

- `allowSubmit` is `false` and must stay that way. The automation stops before
  the DocuSign signature, which is **semi-irreversible**: you cannot un-sign a
  group application, and the carrier may act on it. Note that the seed data
  being synthetic does **not** make signing safe — it files a real application
  with a real carrier under a real producer's license.
- The only group in the seed queue is the synthetic `The Company LLC`. Never add
  a real group while the PoC is under development.
- The runbook this was built from is **older than the portal**, and the portal
  has since moved platform entirely. Treat every locator that is not ticked in
  [field-map.md](../../../docs/poc/anthem-ca-new-plans/field-map.md) as an
  unverified hypothesis. See [PROMPT.md](../../../docs/poc/anthem-ca-new-plans/PROMPT.md).

## Scope

> ⚠ **The flow changed platform on 2026-09-03.** `Create Quote` now opens a new
> tab on Anthem's Salesforce/Vlocity site
> (`elevancehealthfulcrum.my.site.com`) — the "Small Group Quote & Enroll"
> platform. Producer Toolbox is only the launcher. Stages 2.2–8 of the original
> runbook **no longer exist as written**. See
> [drift-log.md](../../../docs/poc/anthem-ca-new-plans/drift-log.md) — read it
> before the runbook.

| Stage | What | State |
|---|---|---|
| 1 | Sign in + MFA | **working**; session reuse spends no code, and a skipped Okta challenge no longer fails the run |
| 2.1 | Start Quote → market/state → **Create Quote** (new tab) | **working** |
| 2.2 | `Group Setup` (was: license validation + group account + group contact) | **working** |
| 2.3 | `Select Portfolios` (was: SIC/eligible count + stage 3 products) | **working** |
| 4 | `Employee Census` — download template, fill, upload | **working**, round-trip proven against the real template |
| 5 | `Select Medical Plans` | **working**, via metal-level filtering |
| 6 | `Quote Review & Confirmation` + Member-Rated PDF | **working** |
| 7 | Employer application — all nine editable screens through `Attestation` | **working** |
| 8 | `Signature Format` → DocuSign | **not mapped, and deliberately so**: mapping it means signing. Guarded by `allowSubmit` |
| — | Employee enrollment, document upload, Uploads Complete | **out of scope** |

A full unattended run reaches the end of `Attestation` — the last screen the
portal lets you change — and stops on the `allowSubmit` BusinessException.
**That exception is the success condition.** Measured on 2026-09-03: 80 steps,
0 system failures, 0 retries, `signedInVia: "reused"`.

Known gaps — see
[open-questions.md](../../../docs/poc/anthem-ca-new-plans/open-questions.md):

- **contract codes go stale.** Anthem rotates them by plan year. The seed now
  carries codes verified on 2026-09-03 (`8VAY 8VAN 8V5C 8V63`); when stage 5
  reports "contract code not offered", re-read the plan list rather than
  assuming the automation broke
- the payload has no `typeOfBusiness`, so it currently lives in config
- **re-running does not resume.** `create the quote` is `alwaysRun`, so every
  run builds a fresh quote instead of re-entering the in-flight one. The
  runbook's portal re-entry path (Quotes → search by FEIN → in-progress
  application) is not implemented, which is why a day of development leaves
  several quotes for the same group

## Mapping the portal without burning MFA codes

A full login costs a real code and a wait. Reuse the persisted session instead:

```bash
pnpm tsx tooling/scripts/anthem-serve.ts &              # holds a signed-in browser
pnpm tsx tooling/scripts/anthem-do.ts "c Start Quote"   # attach, act, dump, detach
pkill -f anthem-serve                                   # release it when done
```

One long-lived browser and many fast commands: relaunching per command costs
~60s and throws away the portal's place, which is unworkable for a wizard this
long.

## Run it

```bash
pnpm rpa run group-submission/anthem-ca-new-plans                 # headless
HEADLESS=false LOG_PRETTY=true pnpm rpa run group-submission/anthem-ca-new-plans
pnpm rpa queue group-submission/anthem-ca-new-plans --reset
```

Initialize signs in and **reuses the stored session** when one is valid — look
for `signedInVia: "reused"` in the log, which means no MFA code was spent. A run
currently gets through stage 2.1 and then stops where the page objects for the
new Salesforce platform are still to be written.

## Credentials

`.env` needs `ANTHEM_PORTAL_USERNAME` and `ANTHEM_PORTAL_PASSWORD`. Config holds
only the variable *names*.

`producerFirstName`, `producerLastName`, `paidAgencyName` and `paidAgencyCode`
ship as `REPLACE_ME`. They identify a **real named producer** and a real agency,
and the agency code doubles as the agency's encrypted TIN and the dashboard
account id — so they are not committed. Get them from the Benefits runbook and
fill them in locally. The values were verified against the live portal, and two
details cost time: the portal resolves the producer **with a middle initial**,
so the config's `first last` is not the displayed string, and the paid agency
**auto-populates** from the writing agent rather than being selected.
See [docs/poc/sanitization.md](../../../docs/poc/sanitization.md).

## The supervised signature drivers are NOT in the repo

Five hand-run scripts once sat at this automation's root —
`reach-signature.ts`, `resume-signature.ts`, `lock-and-look.ts`,
`sig-format.ts` and `sig-signatory.ts`. They are gitignored and deliberately
not committed.

Each one spread `allowSubmit: true` over the file config to get past the guard
in CLAUDE.md rule 10, so that the last unmapped screens — Attestation, the
application lock, the DocuSign ceremony — could be **reached and read** without
arming every ordinary `pnpm rpa run`. Granting the override in a hand-run
script rather than in `config.dev.json` was the right call and kept the
committed guard intact.

They are still not something a clone should carry: this is Anthem's
**production** portal with no sandbox, and running one can sign and file a real
group application under a real producer's licence. What they discovered is
recorded where it belongs — the page objects under `src/pages/`, and
[`docs/poc/anthem-ca-new-plans/drift-log.md`](../../../docs/poc/anthem-ca-new-plans/drift-log.md).
If you need them again, write them again, deliberately, and keep them out of
the repo.

## Where things live

- `src/pages/quote-start.page.ts` — **the exemplar.** Every other screen should
  follow its precondition → action → postcondition shape, and every gate must
  use the **waiting** helpers (`visible`, `valueIs`) from `@rpa/core`, never
  `isVisible()`. See CLAUDE.md rule 9b.
- `src/pages/portal-errors.ts` — `readPortalValidationError`, the locator that
  separates Business from System everywhere. Confirmed against the new platform:
  SLDS renders `Error: <field> is required.` in `.slds-form-element__help`.
- `src/pages/lightning.ts` — **read this before touching a page object.** Every
  helper encodes one Salesforce/Vlocity behaviour that breaks a naive locator:
  pre-rendered hidden branches, 1×1px inputs behind labels, combobox values on
  `data-value`, `getByRole` missing Lightning buttons.
- `src/pages/group-setup.page.ts`, `portfolios.page.ts`, `census.page.ts`,
  `medical-plans.page.ts`, `quote-review.page.ts`,
  `employer-application.page.ts` — one per wizard step.
- `src/census/quoting-tab.ts` — the `Anthem_NewPlans` macro port (the VBA was
  recovered, not reverse-engineered).
- `src/derived.ts` — the counts the employer application asks for that are not
  copied straight from the payload.
- `src/payload.ts` — thin wrapper; the real schema is shared across both
  carriers in `@auto/group-submission-shared`.
- `data/seed/queue.json`, `data/input/census-sample.csv` — synthetic only.

## Business vs System, for this process

| Failure | Class |
|---|---|
| Group name > 50 chars, address > 27 chars | **Business** — shortening is a human judgement call |
| Contract code not offered in the portal | **Business** |
| More than 3 owners | **Business** — needs an ownership letterhead, out of PoC scope |
| Ownership ≠ 100% | **Business** |
| Census template rejected by the portal | **Business** — the data is wrong |
| MFA code never arrived | **System** — mail was late, retry with a fresh trigger |
| Portal session expired mid-application | **System** — recover and resume; `step()` skips what is already done |
| Wrong screen / unexpected state | **System** — precondition failure, recover the session |
