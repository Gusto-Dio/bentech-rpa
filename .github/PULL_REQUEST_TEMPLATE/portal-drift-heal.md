<!--
A NAMED template, so the repository default is untouched for humans.
Use with: gh pr create --draft --template portal-drift-heal.md
-->

## Drift

Closes #<issue>

**Symptom** — <the step, the gate, the run id>
**Screen** — `<url>` — `<wizard step / heading>`
**First seen** — <run id, timestamp>

## Root cause

<one paragraph, with a confidence word from the drift log's own vocabulary:
(not documented) | (our bug) | (measured) | (harness limit) | (unverified)>

<!--
If more than one cause is plausible, this pull request should not exist.
Escalate on the issue instead - see .claude/skills/portal-drift-repair/references/escalation.md
-->

## The change, and why this shape

| File | Change | Why not the obvious alternative |
|---|---|---|
| | | |

## Verification ladder

| Rung | Command | Result | What it proves |
|---|---|---|---|
| 0 static | `pnpm typecheck && pnpm rpa validate` | | compiles; boundaries intact |
| 0 guards | `healing-guards.test.ts` | | no isVisible() in a gate, no XPath, no gate over its step budget, allowSubmit untouched |
| 1 suite | `pnpm test` | | the pinned behaviours still hold |
| 2 live locator | `anthem-verify-locators.ts …` | | the locator resolves uniquely and visibly on the real screen |
| 3 gate semantics | `--cold` | | the gate waits |
| 4 portal access | `check-portal-access.ts` | | the carrier accepts this runtime |
| 4 navigation | `check-portal-navigation.ts` | | sign-in and the SAML hop still work, nothing created |
| 5 container | — | ⛔ not run | `docker` is outside the healing policy — **reviewer action** |
| 6 reference | `rpa run …/carrier-portal-submission-demo` | | the step/gate/retry contract, end to end |

### `pnpm check` output

```
<pasted verbatim, including the test count it printed. Never quote one from a document.>
```

## Not verified — and why

<the fixed phrasing from references/verification-ladder.md. This section is mandatory.>

**No check was weakened to make this pass.** preconditions removed: 0 ·
`alwaysRun` added: 0 · timeouts raised: 0 · tests relaxed: 0 ·
classifications changed: 0

<!-- Those five counters are COMPUTED from the diff by the healing policy, not asserted. -->

## Before / after (masked)

| Before | After |
|---|---|
| ![before](../docs/poc/anthem-ca-new-plans/evidence/heal-<issue>/<label>.before.masked.png) | ![after](../docs/poc/anthem-ca-new-plans/evidence/heal-<issue>/<label>.after.masked.png) |

Masked with `src/pages/masks.ts` v<N>, deny-by-default. Coverage verified by
`check-masked-evidence.ts`: <M> value-bearing controls, <M> covered.
Unmasked originals: `artifacts/<runId>/…` on the healing host. **Not uploaded.**

## Drift log

<the appended row, quoted>

## Reviewer checklist

- [ ] The root cause matches the evidence, and I would not have diagnosed it differently
- [ ] Nothing in the diff weakens a precondition, gate, timeout, test or classification
- [ ] The **Not verified** list is complete for what this diff touches
- [ ] The masked pair shows no group, member, producer or agency value — including
      anything a canvas or background image could have rendered, which the geometry
      check cannot see
- [ ] **I ran `pnpm check` myself** — Actions is disabled org-wide on this repo, so
      `.github/workflows/check.yml` never fires and the checks you see are security
      scanners that run no tests. Rungs 0 and 1 are only covered if you cover them
- [ ] Rungs 2–6 were reported honestly, including what was *not* verified
- [ ] If a live run is needed to confirm, it is scheduled for after the freeze lifts

## Session

Model: <asserted opus id> · Prompts: <n>/60 · Wall: <mm>/90 · Denials: <n>
Transcript: `artifacts/heal/<issue>/transcript.jsonl` (healing host, not uploaded)
