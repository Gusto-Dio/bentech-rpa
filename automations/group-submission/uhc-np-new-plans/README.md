# UHC New Plans (PoC)

Submits a new-plan group application through the **UHC SAMx** portal: case,
employer information, bulk census, plan selection, proposal, and the employer
application.

| | |
|---|---|
| **Id** | `group-submission/uhc-np-new-plans` |
| **Domain** | `group-submission` |
| **Owner** | @gusto/benefits-rpa-group-submission |
| **Session** | browser (Chromium, headless by default) + **MFA** |
| **Queue** | `group-submission.uhc-np-new-plans` (local JSON in phase 1) |
| **Status** | **Stages 1–2 wired, 3–8 mapped and not implemented** |

## Read this before running it

This runs against the **production UHC portal**. There is no sandbox.

- `allowSubmit` is `false` and must stay that way. The automation stops before
  the attestation, which is **signing on the producer's behalf**.
- The only group in the seed queue is the synthetic `The Company LLC`.
- The runbook this was built from is **older than the portal**. Selectors here
  are unverified hypotheses. See [PROMPT.md](../../../docs/poc/uhc-np-new-plans/PROMPT.md).

## Scope

| Stage | What | State |
|---|---|---|
| 1 | Sign in + MFA | wired (needs `PROMPT-00`) |
| 2 | Dashboard, resume-or-create case, owner assignment | **wired** |
| 3 | Employer information, locations, contact, products | mapped |
| 4 | SAMx bulk census upload | mapped |
| 5 | Plan selection, contribution, TIN, proposal | mapped |
| 6–7 | Employer application + producer | mapped |
| 8 | Attestation | mapped, **guarded** |
| — | Employee enrollment, direct debit, documents, Finalize | **out of scope** |

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

`.env` needs `UHC_PORTAL_USERNAME` and `UHC_PORTAL_PASSWORD`. Config holds only
the names. `config/config.dev.json` has `REPLACE_ME` placeholders for the
producer, general agent, franchise code, PCIS id and PCP code — removed during
sanitization, see [docs/poc/sanitization.md](../../../docs/poc/sanitization.md).

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

## The two traps in this process

1. **Riders.** Plans must be selected *with* the domestic-partner rider and
   *never* the "aged 29" rider. Picking the wrong one produces a valid-looking
   quote for the wrong coverage — so postconditions assert the rider, not just
   the plan.
2. **Derived thresholds.** Continuation is State below 20 FTE and COBRA at 20 or
   above; primary is Medicare below 20 employees and Plan Primary at 20 or
   above. Both are easy to invert. Compute them in code and log which branch was
   taken.
