# UHC New Plans (PoC)

Submits a new-plan group application through the **UHC SAMx** portal: case,
employer information, bulk census, plan selection, proposal, and the employer
application.

| | |
|---|---|
| **Id** | `group-submission/uhc-np-new-plans` |
| **Domain** | `group-submission` |
| **Owner** | @gusto/bentech-rpa-group-submission |
| **Session** | browser (Chromium, headless by default) + **MFA** |
| **Queue** | `group-submission.uhc-np-new-plans` (local JSON in phase 1) |
| **Status** | **Stages 1–8 written; NO locator verified — the portal has never been reached** |

## Read this before running it

This runs against the **production UHC portal**. There is no sandbox.

- `allowSubmit` is `false` and must stay that way. The automation stops before
  the attestation, which is **signing on the producer's behalf**.
- The only group in the seed queue is the synthetic `The Company LLC`.
- The runbook this was built from is **older than the portal**. Selectors here
  are unverified hypotheses. See
  [docs/poc/uhc-np-new-plans/](../../../docs/poc/uhc-np-new-plans/).

### It cannot run end to end yet, and that is not a bug

`portalUrl` is `https://www.uhceservices.com/en/prelogin` — confirmed reachable
and serving a page titled "Pre-login Page" (HTTP 200). It replaced the scaffold
placeholder `www.uhc.com`. But the sign-in form is *not* on that page: sign-in
crosses to One Healthcare ID at `identity.onehealthcareid.com`, a separate
origin. No UHC session has ever existed and no locator has been checked against
a live screen, so a run gets as far as the sign-in hop and stops.

Everything that does not depend on the portal is built and tested: the census
transform, every derived value, the evidence hook, the session seam and the
`allowSubmit` guard. Everything that does is **recorded as `null` and throws when
resolved** — see [`src/vocabulary.ts`](src/vocabulary.ts). The automation fails
closed rather than submitting a plausible guess, because a guessed dropdown
value either fails loudly or matches a real option meaning something else, and
then the portal accepts a submission that is quietly wrong.

Start the re-map with the harness, which spends one MFA code and then none:

```bash
pnpm tsx tooling/scripts/check-portal-access.ts --automation group-submission/uhc-np-new-plans
pnpm tsx tooling/scripts/uhc-serve.ts &     # headed; sign in by hand
pnpm tsx tooling/scripts/uhc-do.ts save     # persist the session
pnpm tsx tooling/scripts/uhc-do.ts "c New Case"
```

## Scope

"written" means the steps, gates and postconditions exist and typecheck.
"verified" would mean a live screen agreed, and nothing here is verified.

| Stage | What | Code | Locators | Portal vocabulary |
|---|---|---|---|---|
| 1 | Sign in + MFA | written | `TODO(remap)` | — |
| 2 | Dashboard, resume-or-create case, owner assignment | written | `TODO(remap)` | — |
| 3 | Employer information, locations, contact, products | written | `TODO(remap)` | — |
| 4 | SAMx bulk census upload | written + **tested** | `TODO(remap)` | **unrecorded → throws** |
| 5 | Plan selection, contribution, TIN, proposal | written | `TODO(remap)` | rating labels `TODO(remap)` |
| 6–7 | Employer application + producer | written | `TODO(remap)` | **unrecorded → throws** |
| 8 | Attestation | written + **tested**, **guarded** | `TODO(remap)` | — |
| — | Employee enrollment, direct debit, documents, Finalize | **out of scope** | — | — |

Unit-tested without a browser: the census transform
([`src/census/`](src/census/)), every derived value
([`src/derived.ts`](src/derived.ts)), the SAMx option mappers
([`src/pages/samx-options.ts`](src/pages/samx-options.ts)), the recon origin
fence and the `allowSubmit` guard on every `AttestationPage` method.

## Resuming is a first-class path here

The runbook says it directly:

> "If automation started the submission: search for your group by clicking Case
> Name. Skip to the step that automation stopped at."

So the process was already designed around partial automation. `CaseStartPage.findExistingCase()`
is the resume entry point, and `step()` skips any later stage whose postcondition
is already satisfied. Creating a **second** case for a group that already has one
is the worst failure available here, which is why the search result gates
creation instead of relying on the skip-ahead.

## Run it

```bash
pnpm rpa run group-submission/uhc-np-new-plans
HEADLESS=false LOG_PRETTY=true pnpm rpa run group-submission/uhc-np-new-plans
pnpm rpa queue group-submission/uhc-np-new-plans --reset
```

## Credentials

`.env` needs `UHC_PORTAL_USERNAME` and `UHC_PORTAL_PASSWORD`, plus the producer
and general-agent identity: `UHC_PRODUCER_FIRST_NAME`, `UHC_PRODUCER_LAST_NAME`,
`UHC_GENERAL_AGENT_NAME`, `UHC_GENERAL_AGENT_FRANCHISE_CODE`,
`UHC_GENERAL_AGENT_EMAIL`, `UHC_PCIS_ID`, `UHC_DUMMY_PCP_CODE`.

**Config holds only the names.** These identify a real licensed producer and a
real agency, so a value never appears in a tracked file — see
[docs/poc/sanitization.md](../../../docs/poc/sanitization.md), which records this
shape leaking once already. `resolveProducerIdentity` resolves them per
transaction through `ctx.secrets`; a missing one is a `SystemException`, so the
group is never filed as a carrier rejection because the environment was wrong.

`data/sessions/uhc.json` is **credential-equivalent** — gitignored, written
`0600`, never copied or printed.

## Business vs System, for this process

| Failure | Class |
|---|---|
| Plan name not found in the portal filter | **Business** — UHC does not offer it |
| Bulk census template rejected (error popup) | **Business** — the census data is wrong |
| Zip does not generate a county | **Business** — the address is not serviceable as given |
| Ownership ≠ 100% | **Business** |
| MFA code never arrived | **System** — mail was late |
| Session expired mid-application | **System** — recover and resume |
| Rating method silently reset | **System** — postcondition catches it; re-apply |
| Wrong screen / unexpected state | **System** — precondition failure |
| A waiver reason with no UHC mapping | **Business** — an unfamiliar input; a human decides what UHC calls it |
| An entity type or waiting period the table has no row for | **Business** — same reason |
| A portal literal that has never been recorded | **System** — the automation is unfinished; no input would change it |
| Missing `UHC_PRODUCER_*` env var | **System** — `secrets.require` |
| Reaching stage 8 with `allowSubmit: false` | **Business** — and this is the **success** condition |

## The two traps in this process

1. **Riders.** Plans must be selected *with* the domestic-partner rider and
   *never* the "aged 29" rider. Picking the wrong one produces a valid-looking
   quote for the wrong coverage — so postconditions assert the rider, not just
   the plan.
2. **Derived thresholds.** Continuation is State below 20 FTE and COBRA at 20 or
   above; primary is Medicare below 20 employees and Plan Primary at 20 or
   above. Both are easy to invert. Compute them in code and log which branch was
   taken.
