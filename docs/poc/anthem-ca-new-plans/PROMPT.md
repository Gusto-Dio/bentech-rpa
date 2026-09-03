# PROMPT — Anthem CA New Plans (PoC)

Paste this into a fresh Claude Code session with this repo open.
**[`PROMPT-00-shared-foundations.md`](../PROMPT-00-shared-foundations.md) is DONE.**
Login, MFA and session reuse work against the live portal. Do not rebuild them.

---

You are a **senior RPA developer**. You are automating the Anthem California
new-plan group submission through the Anthem Producer portal, against the
**production** site.

Read first, in this order:

1. `CLAUDE.md` — the repo's rules. Not optional.
2. `automations/group-submission/anthem-ca-new-plans/README.md` — the scope.
3. `docs/poc/anthem-ca-new-plans/process-steps.md` — the runbook.
4. `docs/poc/anthem-ca-new-plans/drift-log.md` — **21 verified entries.** What
   the live portal actually does, versus what the runbook claims. Read it before
   the runbook, or you will re-discover all of it.
5. `automations/group-submission/anthem-ca-new-plans/src/pages/login.page.ts` and
   `quote-start.page.ts` — the exemplars. Stages 1 and 2.1–2.2 are re-mapped
   against the live portal. Match their shape.

## 0. State of play — start here

| Stage | State |
|---|---|
| Login, MFA, session reuse | **Working, proven in production.** A real code was read from the Gmail label, submitted, and the dashboard reached. `data/sessions/anthem-ca.json` persists, and a recovered session consumes **no** code (`signedInVia: "reused"`) |
| 2.1 open the quotes area | Re-mapped. The dashboard's `Start Quote` tile, not the runbook's Book of Business link |
| 2.2 create the quote | Re-mapped up to the final control. Market and state pickers verified |
| **the control that starts the quote** | **The one unverified step in stage 2.** Not clicked during reconnaissance, because clicking it creates a real quote. Confirm its accessible name on your first supervised run |
| 3–8 products, census, coverage, summary, employer application | **`notImplemented` stubs.** No code. This is your work |

So: your job is the create-quote control, then stages 3–8, ending at the
`allowSubmit` guard.

## 0b. Work without burning MFA codes

A full login costs a real code and a wait. You almost never need one.

```bash
# 1. Is the mailbox reachable? Run this BEFORE anything, not after it fails.
pnpm rpa mfa check --label "Access Token (Anthem)" --days 1 --diagnose

# 2. Is the stored session still good? This consumes nothing.
HEADLESS=false pnpm rpa run group-submission/anthem-ca-new-plans
#    -> look for: Step already satisfied: carrier-login  /  signedInVia: "reused"
```

**Explore with the persisted session, not by re-running the automation.** Load
`data/sessions/anthem-ca.json` into a context with `addCookies`, navigate, and
dump roles and accessible names. That costs nothing and is how stages 2.1–2.2
were mapped. `data/sessions/` and `data/profiles/` are credential-equivalent:
gitignored, never copied, never printed.

Three things that will otherwise waste your time:

- **Anthem blocks headless Chromium** (`Access Denied`). `.env` sets
  `HEADLESS=false`. The Ubuntu runtime has no display and is still blocked —
  it needs `xvfb`, which is unfinished work, not your bug.
- **An orphaned browser holds the Gmail profile** and every run then fails with
  `the profile is already in use`, which has nothing to do with your change.
  Clear it: `ps -Ao pid=,command= | grep "user-data-dir=.*data/profiles" | awk '{print $1}' | xargs kill`
- **Do not re-tune the MFA timeouts.** They were tuned twice against a broken
  reader and both readings were wrong. Measured truth: a code arrives in
  **10–26 seconds**. If one does not arrive, something is broken — do not raise
  a timeout to hide it.

Do not "improve" the MFA layer. In particular: `is:unread` must not go back
into the query (this mailbox's filter marks mail read on arrival, so it matched
0 of 21 labelled messages), and the watermark — not read-state — is what makes a
code un-reusable. See CLAUDE.md rule 10b.

## 1. The most important thing: the runbook is a hypothesis, not a specification

`process-steps.md` was written **before this code, from a portal that has since
had a week to change**. Screens get reordered, fields get renamed, validation
gets added, whole steps disappear.

**Every locator in this automation is an unverified guess.** Your first job is to
re-map the process against the live portal.

### How to re-map

Playwright MCP is already configured in this repo (`playwright-mcp.config.json`,
`pnpm mcp`). Use it to walk the documented steps against the real portal, read
the accessibility tree at each screen, and derive real
`getByRole` / `getByLabel` / `getByPlaceholder` locators.

**Do not translate the runbook's prose into guessed CSS.** That is how you get an
automation that passes review and fails on first contact.

Two things you must do before pointing MCP at Anthem:

- `playwright-mcp.config.json` currently allow-lists only `saucedemo.com`. Add
  the Anthem host deliberately. That allow-list is what stops an agent-driven
  browser wandering off the portal.
- You will be on a **real logged-in production session**. Navigate read-only.
  **Never** trigger a submit, an attestation or a signature while mapping. The
  `allowSubmit` guard protects the automation, not a human driving MCP.

### You must reach the end of the stage

When a screen does not match the runbook: find the equivalent screen, work out
what changed, and **carry on**. Do not stop at the first divergence and report
that the docs are wrong. A half-mapped process is not a deliverable.

Record every divergence in [`drift-log.md`](drift-log.md) — date, documented
step, what the portal actually does, what the automation now does. Then correct
`process-steps.md` and `field-map.md` so the next person starts from reality.

### Locators: check the accessible name, not the visible text

Every one of these cost a failed run on this portal:

| What you would write | Why it fails here |
|---|---|
| `getByRole('button', { name: 'Continue' })` | The visible text is "Continue"; the accessible name is **`Login`**, from `aria-label` |
| `getByRole('button', { name: 'Verify' })` for the password step | It is an `input[type=submit]`, whose name comes from `value="Next"` |
| `getByRole('link', { name: 'Resend Code' })` | An **anchor with no `href`** has no link role at all. Match by text |
| `getByRole('link', { name: 'Book of Business' })` | It is a `span[role="button"]` menu toggle, and the text appears **five times** on the dashboard |
| `getByLabel('Select a market').selectOption(...)` | Not a `<select>`. A **button** opening a list of `label[role="option"]` |

So: dump the role and accessible name from the live page before writing a
locator, and scope to the surrounding card — "Previous Quotes" carries an
identical market/state pair, and driving those filters a list instead of
starting a quote.

## 2. Every interaction is precondition → action → postcondition

Use `step()` from `@rpa/core` for **every** portal interaction. No exceptions,
including "just clicking Next".

```ts
await step(steps, {
  name: 'enter the employer tax id',
  precondition: async () => page.getByLabel(/tax id/i).isVisible(),
  action: async () => page.getByLabel(/tax id/i).fill(payload.fein),
  postcondition: async () => (await page.getByLabel(/tax id/i).inputValue()) === payload.fein,
  businessCheck: async () => readPortalValidationError(page),
});
```

Why each part earns its place:

- **precondition** — "are we where we think we are?" A failure means the session
  is wrong, so it is a `SystemException` and the runner recovers and retries.
- **action** — the click or fill.
- **businessCheck** — reads Anthem's *own* validation message. A non-empty result
  is a `BusinessException` carrying the portal's wording, which is what an
  operator actually wants to read.
- **postcondition** — "did it take effect?" Read the value back. Do not trust a
  `fill()`.

### The trap: postconditions must be transaction-specific

`step()` checks the postcondition **before** the action and skips if it is
already satisfied. That is what makes a resumed submission safe.

It is also how you can destroy data. `"a quote exists"` would be satisfied by the
**previous group's** quote still on screen, and the step would skip — leaving this
group without one.

**Anchor every postcondition on a payload value.** `page.getByText(payload.fein)`,
not `page.getByText('Quote created')`. Where that is genuinely impossible — the
value is not on screen yet — set `alwaysRun: true` and say why in a comment.

## 3. Scope, and the guard

Build stages 3–8. Stages 1–2 are done.

| Stage | What | State |
|---|---|---|
| 1 | Sign in + MFA | done (via `PROMPT-00`) |
| 2 | Quote, license & contract validation, group account | **done — read it** |
| 3 | Products and coverage | build |
| 4 | Census template download, fill from Hippo census, upload | build |
| 5 | Select medical coverage by contract code | build |
| 6 | Group contact, generate quote, download PDF | build |
| 7 | Employer application — 10 screens | build |
| 8 | E-signature | build, **behind the guard** |
| — | Employee enrollment, document upload, Uploads Complete | **out of scope** |

### `allowSubmit` — read this twice

`config.allowSubmit` is `false` and **stays false**. The e-signature in stage 8
produces a **signed group application** on the production portal. You cannot
un-sign it, and the carrier may act on it.

Stage 8 must check the flag and throw a `BusinessException` naming it when false.
`processTransaction.ts` already does this — keep it, and make every method in
`SignaturePage` check it too. This is the control that makes running a PoC
against production acceptable at all.

If you believe you need `allowSubmit: true` to verify something, **stop and ask**.

## 4. The census (stage 4) is its own problem

Anthem's census template is filled by the `Anthem_NewPlans` macro today. You are
porting that to TypeScript with `exceljs` — see
[`../excel-macros.md`](../excel-macros.md).

The Anthem layout is **not** documented, and the VBA is compiled. So:

1. Download Anthem's census template from the portal during your re-map.
2. Read its actual header row.
3. Map each column back to a Hippo census column
   (`_shared/src/census/hippo-census.ts` lists all 35).
4. Record the mapping in [`field-map.md`](field-map.md).

**Enrolling people only.** Waiving employees never go on this template. The
split is by whether `Waiver Reason - Medical` is populated.

Test it: `data/input/census-sample.csv` has three synthetic people, one waiving.
Assert on the produced template's cells, not on "it did not throw".

## 5. Business vs System, for this process

Getting this wrong is expensive — a Business failure thrown as System burns three
browser relaunches and three MFA codes per group.

| Failure | Class |
|---|---|
| Group name > 50 chars, address > 27 chars | **Business** — shortening is a human judgement call, do not improvise it |
| Contract code not offered in the portal | **Business** |
| More than 3 owners | **Business** — needs an ownership letterhead, out of scope |
| Ownership ≠ 100% | **Business** |
| Census template rejected by the portal | **Business** — the data is wrong |
| Required document missing | **Business** — the runbook says "ticket the OA" |
| MFA code never arrived | **System** — mail was late |
| Session expired mid-application | **System** — recover; `step()` skips what is done |
| Wrong screen / unexpected state | **System** — precondition failure |
| Portal 500 or timeout | **System** |

The test: *would running this again, on a fresh browser, plausibly give a
different answer?* Yes → System. No → Business.

## 6. Selectors and evidence

- `getByRole` → `getByLabel`/`getByPlaceholder` → `getByTestId` → CSS, and CSS
  only inside a page object. **No XPath.**
- All selectors live in `src/pages/`. Mark volatile steps with
  `// AUTO-HEALING SEAM:` and describe what a fallback would need to find.
- `readPortalValidationError()` in `quote-start.page.ts` is the **highest-value
  locator in the automation** — it is what separates Business from System across
  every screen. Verify it early and carefully.
- Capture on every failed gate: a screenshot named
  `<reference>-<step>-<gate>.png` in `ctx.paths.runArtifactsDir`. The
  `onGateFailure` hook in `processTransaction.ts` is where that goes — it is a
  TODO right now.
- Also keep the quote PDF and, if stage 8 ever runs, the application PDF.

## 7. Acceptance

- `pnpm check` clean. Read the test count it prints; do not quote one.
- `HEADLESS=false LOG_PRETTY=true pnpm rpa run group-submission/anthem-ca-new-plans`
  reaches the **end of the employer application** and stops with the
  `allowSubmit` BusinessException. That exception is the **success** condition.
- That run must show `signedInVia: "reused"` — i.e. it got there **without
  consuming an MFA code**. If every run costs a code, session reuse is broken
  and that is a bug in your change, not in the carrier.
- The run log reads as an audit trail: one `step` line per interaction, with
  `phase` and `outcome`.
- Re-running immediately **resumes** rather than redoing — several steps log
  `SKIPPED`. This is the single best evidence the postconditions are right.
- `drift-log.md` has real entries. If it is empty after re-mapping a week-old
  runbook against a live portal, you did not re-map.
- `process-steps.md` and `field-map.md` corrected to match reality.
- Unit tests for the census transform and for any derived value (counts,
  contribution percentages) using `@rpa/testkit`.

## 8. Do not

- Do not set `allowSubmit: true`.
- Do not put a real group in `data/seed/queue.json`, or real credentials
  anywhere but `.env`.
- Do not log a password, an MFA code, or the banking fields.
- Do not implement stages past the boundary because they seemed easy.
- Do not "fix" a failing precondition by deleting it.
- Do not leave a locator you never verified without a `TODO(remap)` marker.
- Do not rebuild or "harden" the MFA/session layer. Every guard added there for
  safety, other than the watermark, the sender allow-list and label scoping,
  turned a recoverable situation into a discarded code. CLAUDE.md rule 10b.
