---
name: portal-drift-repair
description: >
  Repair a carrier-portal automation after the sentinel files a portal-drift
  issue. Debug against the live portal read-only, fix page objects and step
  definitions, prove the fix under the Anthem production freeze, append to the
  drift log, capture a masked before/after pair, and open a DRAFT pull request.
  Never merge. Escalate rather than guess. Use when handed a portal-drift issue
  number, when a gate or precondition has started failing on a screen that used
  to work, or when a locator resolves to zero elements or to many.
---

# Repairing portal drift

## 0. Stop conditions — read these first

Deliberately at the top, because every expensive mistake available here happens
in the first two minutes.

- **`pnpm rpa run group-submission/anthem-ca-new-plans` is forbidden.** Not with
  `allowSubmit: false`, not "just to see". A run creates a real account and a
  real quote on Anthem's production portal. AGENTS.md rule 10a.
  **You cannot verify your fix by running the automation.** §6 is how you verify
  it instead.
- **`allowSubmit` stays `false`.** You do not read it, write it, or reason about
  flipping it.
- **You are working with a live, signed-in production broker session** under a
  real licensed producer's licence. Navigate. Never click, type, fill, upload or
  submit — not through Playwright MCP, not through the recon harness.
- **Never re-tune an MFA timeout.** They were tuned twice against a broken
  reader and both readings were wrong. A code that does not arrive means
  something is broken; a longer timeout hides it.
- **Do not delete a failing precondition, add `alwaysRun`, widen a gate, or
  raise a timeout to make a check pass.** Each of these has already caused a
  worse failure here than the one it hid. If the fix requires one, that is an
  escalation (§9), not a repair.
- **If you are blocked three times in a row, stop and escalate.** Three
  refusals means you are arguing with a wall, not diagnosing.

## 1. Read these, in this order

1. `AGENTS.md` — the 13 rules and the "Gotchas that have already cost time"
   table.
2. **`docs/poc/anthem-ca-new-plans/drift-log.md` — before `process-steps.md`.**
   Read it first or you will re-derive a hundred rows of it. It records what the
   portal actually does, including several entries that retract an earlier and
   wrong diagnosis of the same failure.
3. `AGENTS.md` rules 9 and 9b — `step()`, and why a gate must WAIT rather
   than call `isVisible()`.
4. `automations/group-submission/anthem-ca-new-plans/README.md` — scope, the
   `allowSubmit` guard, and what is deliberately unmapped.
5. `src/pages/login.page.ts` and `src/pages/quote-start.page.ts` — the
   exemplars.
6. The issue itself, then the baseline for the affected screen under
   `sentinel/baselines/`.

Then: [locator-playbook.md](references/locator-playbook.md),
[verification-ladder.md](references/verification-ladder.md),
[classification.md](references/classification.md),
[drift-log-entry.md](references/drift-log-entry.md),
[screenshot-pairs.md](references/screenshot-pairs.md),
[escalation.md](references/escalation.md).

## 2. Reproduce — without re-running anything

```bash
gh issue view <n> --json body        # runId, step, gate, screenUrl, artifact paths
```

1. Read `artifacts/sentinel/<runId>/<probe>/screen.<screenId>.json`. That is the
   shadow-DOM-piercing reading: the portal's **own** `alerts`, the wizard rail,
   the field labels, the buttons, the modal. *The portal's own wording is the
   highest-value thing here.* Read `signature.<screenId>.json` beside it for the
   normalized comparison, and the masked screenshot if one exists.
2. Bring up the recon browser **once**:
   ```bash
   pnpm tsx tooling/scripts/anthem-serve.ts &
   pnpm tsx tooling/scripts/anthem-do.ts "u <screenUrl>"
   ```
   Confirm you are on the same screen the evidence shows.
3. **Kill it in a `finally`:** `pkill -f anthem-serve`. An orphan holds the
   persistent profile and every later command then fails for a reason unrelated
   to your problem. Twenty had accumulated once.
4. If the screen cannot be reached read-only — anything past `Create Quote` on a
   fresh group, the DocuSign ceremony (a CDP-attached browser cannot see
   out-of-process iframes at all), the `inprogressapplication` redirect — you are
   working from artifacts. **Say so, in the PR and in the drift log.**

## 3. Diagnose, and distrust yourself

Four candidate root causes, in the order they are actually likely here:

1. **The locator was always wrong and only now got unlucky.** Ambiguity
   resolving differently. Check the recon dump's `-- AMBIGUOUS --` section.
2. **The question was asked wrong, not the locator.** `isVisible()` in a gate; a
   negated `textVisible` burning its whole budget; a gate whose budget exceeds
   its step's `timeoutMs` and is therefore silently truncated.
3. **The postcondition is not transaction-specific**, so it was satisfied by the
   previous group's state and the step skipped.
4. **The portal genuinely changed** — a field renamed, a branch added, a modal
   introduced, a screen merged.

> The drift log contains **three successive readings** of the same SAML failure,
> two of them retracted by name. **State your confidence, and prefer a
> retraction to a silent correction.** If your diagnosis rests on something you
> have not measured, it is a hypothesis — escalate it rather than shipping it.

## 4. Re-map the screen

Two tools, in this order:

```bash
pnpm tsx tooling/scripts/anthem-do.ts          # the dump: role, accessible name,
                                               # tag, label, placeholder, text,
                                               # and the ambiguity list
```

It pierces shadow DOM, which `document.querySelectorAll` does not — a screen
with thirty controls dumps as five without it.

Then Playwright MCP `browser_snapshot` for the accessibility tree when you need
structure (which fieldset owns which legend). It is fenced to three hosts;
`ERR_BLOCKED_BY_CLIENT` is the fence working, not a bug, and **you do not widen
it.**

> **Read the accessible name, not the visible text.** On this portal a button
> reading "Continue" is named `Login`, and the checklist's "Submit" is named
> `documentCheckListSubmit`. See [locator-playbook.md](references/locator-playbook.md).

## 5. Write the fix

- Locator preference: `getByRole` → `getByLabel`/`getByPlaceholder` →
  `getByTestId` → CSS (page objects only). **No XPath.**
- Selectors only in `src/pages/`.
- Gates must wait: `visible` / `hidden` / `valueIs` / `textVisible` from
  `@rpa/core`. Never `isVisible()` in a gate.
- A postcondition anchors on a **payload value**, not on generic text.
- If a step is genuinely slow, raise `timeoutMs` on the **step spec** — a gate
  budget above the step's budget is silently truncated.
- Honour the `// AUTO-HEALING SEAM:` contract: an LLM-assisted locator is a
  **fallback after** the deterministic locator fails, never a replacement. If
  you add one, the deterministic locator stays first and the fallback logs that
  it fired.
- **Prefer a page-object fix over a flow fix.** Rung 2 can prove a locator on
  the live screen; nothing available under the freeze can prove a change to
  `processTransaction.ts` against Anthem. If both are possible, fix the page
  object and propose the flow change in the PR body instead of applying it.

## 6. Prove it

Climb [verification-ladder.md](references/verification-ladder.md). Record every
rung's result. **Every rung you could not climb goes in the PR's "Not verified"
section with the reason.** That section is mandatory.

## 7. Record it

Append to `drift-log.md` in the four-column format, typed with the log's own
vocabulary — see [drift-log-entry.md](references/drift-log-entry.md). Correct
`process-steps.md` and `field-map.md`, marking corrected lines so the diff
against the original stays visible. Refresh the screen baseline:

```bash
pnpm tsx tooling/scripts/screen-baseline.ts write --screen <screenId> --note "<why>"
```

## 8. Capture the pair

Before **first**, then fix, then after — see
[screenshot-pairs.md](references/screenshot-pairs.md). Masked, and
coverage-checked. `check-masked-evidence.ts` failing **blocks the PR**; no
unverified-masking image is ever pushed.

## 9. Open a draft pull request

Template and required sections in
[verification-ladder.md](references/verification-ladder.md) and
[escalation.md](references/escalation.md). Paste the `pnpm check` output
verbatim, including the test count it printed — **never quote a count from a
document.** Never `gh pr merge`, never `gh pr ready`.

And if you cannot fix it: escalating is a **completed heal with a diagnosis
deliverable**, not a failure. See [escalation.md](references/escalation.md).
