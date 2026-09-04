# PROMPT — UHC New Plans (PoC)

Paste this into a fresh Claude Code session with this repo open.
**[`PROMPT-00-shared-foundations.md`](../PROMPT-00-shared-foundations.md) is DONE.**
The MFA and session layer works and is proven on Anthem. Do not rebuild it.

Two findings from the Anthem run apply directly to UHC:

- **UHC's codes are not email.** The `Access Token (UnitedHealthcare)` label is
  fed by Google Voice **SMS-to-email** (`...@txt.voice.google.com`) plus an
  internal forward from `carrierops@gusto.com`. There is no `uhc.com` sender at
  all, so the original allow-list matched nothing and every code would have been
  rejected. It is now `["txt.voice.google.com", "carrierops@gusto.com"]`.
- **Do not re-tune MFA timeouts or reintroduce `is:unread`.** See
  `docs/poc/anthem-ca-new-plans/PROMPT.md` section 0b and AGENTS.md rule 10b.
  Explore with the persisted session instead of re-running the login.

---

You are a **senior RPA developer**. You are automating the UHC new-plan group
submission through the **SAMx** portal, against the **production** site.

Read first, in this order:

1. `AGENTS.md` — the repo's rules. Not optional.
2. `automations/group-submission/uhc-np-new-plans/README.md` — the scope.
3. `docs/poc/uhc-np-new-plans/process-steps.md` — the runbook.
4. `automations/group-submission/uhc-np-new-plans/src/pages/case-start.page.ts`
   — the exemplar. Stages 1–2 are already written this way. Match it.

## 1. The most important thing: the runbook is a hypothesis, not a specification

`process-steps.md` was written **before this code, from a portal that has since
had a week to change**. SAMx in particular moves — screens get reordered, fields
get renamed, validation gets added.

**Every locator in this automation is an unverified guess.** Your first job is to
re-map the process against the live portal.

### How to re-map

Playwright MCP is already configured (`playwright-mcp.config.json`, `pnpm mcp`).
Use it to walk the documented steps against the real portal, read the
accessibility tree at each screen, and derive real
`getByRole` / `getByLabel` / `getByPlaceholder` locators.

**Do not translate the runbook's prose into guessed CSS.**

Two things before you point MCP at UHC:

- `playwright-mcp.config.json` allow-lists only `saucedemo.com` today. Add the
  UHC host deliberately — that allow-list is what stops an agent-driven browser
  wandering off the portal.
- You will be on a **real logged-in production session**. Navigate read-only.
  **Never** trigger an attestation, a Finalize or a Submit while mapping.

### You must reach the end of the stage

When a screen does not match: find the equivalent, work out what changed, and
**carry on**. Do not stop at the first divergence and report that the docs are
wrong. A half-mapped process is not a deliverable.

Record every divergence in [`drift-log.md`](drift-log.md), then correct
`process-steps.md` and `field-map.md`.

## 2. Every interaction is precondition → action → postcondition

Use `step()` from `@rpa/core` for **every** portal interaction, including
"just clicking Save & Continue".

```ts
await step(steps, {
  name: 'enter the group zip and confirm the county resolved',
  precondition: async () => page.getByLabel(/zip/i).isVisible(),
  action: async () => page.getByLabel(/zip/i).fill(payload.zip),
  // Not "the zip is filled" - the COUNTY is what the portal has to derive, and a
  // silently missing county surfaces much later as a rating error.
  postcondition: async () => page.getByText(payload.county).isVisible(),
  businessCheck: async () => readPortalValidationError(page),
});
```

- **precondition** — a failure means the session is wrong → `SystemException`,
  runner recovers.
- **businessCheck** — reads SAMx's *own* message → `BusinessException` with the
  portal's wording.
- **postcondition** — read back the *consequence*, not the input.

### The trap: postconditions must be transaction-specific

`step()` checks the postcondition **before** the action and skips when it is
already satisfied. That is what makes resuming safe — and how you can destroy
data if the check is vague. `"a case exists"` would be satisfied by the previous
group's case.

**Anchor on a payload value.** Where genuinely impossible, use `alwaysRun: true`
and say why. `CaseStartPage.createNewCase()` is the worked example: the group is
not identified until the next screen, so it uses `alwaysRun` *and* is gated
behind `findExistingCase()`.

## 3. Resuming is a first-class path in this process

The runbook says it outright:

> "If automation started the submission: search for your group by clicking Case
> Name. Skip to the step that automation stopped at."

So the process was **already designed** around partial automation. Honour that:

- `findExistingCase()` is the resume entry point and is already written.
- **Creating a second case for a group that already has one is the worst failure
  available here.** That is why creation is gated behind the search result rather
  than relying on the skip-ahead. Do not restructure that.

## 4. Scope, and the guard

Build stages 3–8. Stages 1–2 are done.

| Stage | What | State |
|---|---|---|
| 1 | Sign in + MFA | done (via `PROMPT-00`) |
| 2 | Dashboard, resume-or-create case, owner assignment | **done — read it** |
| 3 | Employer info, locations, contact, products to quote | build |
| 4 | SAMx bulk census upload | build |
| 5 | Plan selection, contribution, TIN, proposal | build |
| 6–7 | Employer application + producer | build |
| 8 | Attestation | build, **behind the guard** |
| — | Employee enrollment, direct debit, documents, Finalize | **out of scope** |

### `allowSubmit` — read this twice

`config.allowSubmit` is `false` and **stays false**. An attestation is **signed on
the producer's behalf** on the production portal.

Stage 8 must check the flag and throw a `BusinessException` naming it when false.
`processTransaction.ts` already does — keep it, and make every `AttestationPage`
method check it too.

If you believe you need `allowSubmit: true` to verify something, **stop and ask**.

## 5. The two traps specific to UHC

### Riders

Plans must be selected **with** the domestic-partner rider and **never** the
"aged 29" rider (shown in orange above the rate). Some plans also carry vision;
that is fine.

Picking the wrong rider produces a **valid-looking quote for the wrong
coverage** — the worst kind of failure, because nothing errors. So the
postcondition must assert the **rider**, not just that a plan is selected.

Also: the runbook says to confirm the rating method (Age-banded vs Composite)
**before and after** selecting plans. That phrasing usually means it has silently
reset on somebody. `processTransaction.ts` already calls
`confirmRatingMethod()` twice for that reason — keep both calls.

### Derived thresholds

Several answers are computed, not copied, and the thresholds are easy to invert:

```
continuation:  < 20 FTE  -> State       >= 20 FTE  -> COBRA
primary:       < 20 EEs  -> Medicare    >= 20 EEs  -> Plan Primary
```

Two more from the runbook:

- A California group at 100% contribution where **not everyone is enrolling** is
  entered as **99%**, and called out in the completion notes.
- A **flat-dollar** contribution is entered as **50%**.

Compute these in code, log which branch was taken, and unit-test them. Do not
inline the arithmetic at the point of typing.

### And one formatting rule

SAMx rejects phone numbers containing dashes or parentheses. `digitsOnly()` in
`case-start.page.ts` exists for this.

## 6. The census (stage 4)

You are porting `SAMx_PortalBulkCensus` to TypeScript with `exceljs` — see
[`../excel-macros.md`](../excel-macros.md). UHC is the better-specified of the
two ports; the runbook names the columns:

| Column | Contents |
|---|---|
| **R** | Medical Coverage Type |
| **S**, **AA** | Medical Waiver Reason |
| **Y** | Waive All Products |
| **Z** | Medical Plan Code |
| **AQ** | SSN (employees and dependents) |

Behaviours to honour:

- Dependents who are **waiving** are removed before transforming.
- Dental and vision columns stay **blank** — this covers medical and
  employee/dependent info only.
- **The upload is all-or-nothing.** If the template has any error, *no* employee
  data loads and the portal shows a popup listing the problems. So the
  postcondition must count loaded employees, and the error popup becomes a
  `BusinessException` carrying the portal's own list.

Only one waiver-reason mapping is documented:

```
Hippo `individual_policy` -> UHC `Individual Exchange`
```

**Read the rest off the portal's dropdown during your re-map. Do not guess it** —
a wrong waiver reason is a silently incorrect submission, not a visible error.
Record what you find in [`field-map.md`](field-map.md).

## 7. Business vs System, for this process

| Failure | Class |
|---|---|
| Plan name not found in the portal filter | **Business** — UHC does not offer it |
| Bulk census rejected (error popup) | **Business** — census data is wrong |
| Zip does not resolve a county | **Business** — address not serviceable as given |
| Ownership ≠ 100% | **Business** |
| MFA code never arrived | **System** — mail was late |
| Session expired mid-application | **System** — recover and resume |
| Rating method silently reset | **System** — postcondition catches it, re-apply |
| Wrong screen / unexpected state | **System** — precondition failure |
| SAMx 500 or timeout | **System** |

The test: *would running this again, on a fresh browser, plausibly give a
different answer?* Yes → System. No → Business.

## 8. Selectors and evidence

- `getByRole` → `getByLabel`/`getByPlaceholder` → `getByTestId` → CSS, and CSS
  only inside a page object. **No XPath.**
- `readPortalValidationError()` in `case-start.page.ts` is the **highest-value
  locator in the automation** — it separates Business from System everywhere.
  Verify it early.
- Mark volatile steps `// AUTO-HEALING SEAM:` with what a fallback would look for.
- Capture on every failed gate: `<reference>-<step>-<gate>.png` in
  `ctx.paths.runArtifactsDir`. The `onGateFailure` hook is a TODO right now.
- Keep the generated proposal PDF, and the employer-contribution screenshot the
  runbook asks for.

## 9. Acceptance

- `pnpm check` clean.
- `HEADLESS=false LOG_PRETTY=true pnpm rpa run group-submission/uhc-np-new-plans`
  reaches the **end of the employer application** and stops with the
  `allowSubmit` BusinessException. That exception is the **success** condition.
- Run it twice. The second run **resumes** — `findExistingCase` finds the case
  and several steps log `SKIPPED`. It must **not** create a second case. This is
  the most important test in the whole PoC.
- The log reads as an audit trail: one `step` line per interaction.
- `drift-log.md` has real entries.
- `process-steps.md` and `field-map.md` corrected, including the waiver-reason
  table you discovered.
- Unit tests for the census transform and for every derived value (continuation,
  primary, contribution percentages).

## 10. Do not

- Do not set `allowSubmit: true`.
- Do not create a case without checking `findExistingCase()` first.
- Do not select the "aged 29" rider, ever.
- Do not put a real group in `data/seed/queue.json`, or credentials outside `.env`.
- Do not log a password, an MFA code, or the banking fields.
- Do not implement stages past the boundary.
- Do not leave an unverified locator without a `TODO(remap)` marker.
