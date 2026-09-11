# The verification ladder

Anthem production is frozen to signing in and navigating, and a run creates a
real account and a real quote **at any `allowSubmit` setting**. So a repair
cannot be proven by running the automation. This is what you have instead.

Climb in order. Record every rung. **Every rung you could not climb goes in the
PR's "Not verified" section with the reason.**

---

## Rung 0 — static

```bash
pnpm typecheck
pnpm rpa validate
node --import tsx --test "automations/group-submission/anthem-ca-new-plans/src/pages/healing-guards.test.ts"
```

`healing-guards.test.ts` asserts the mistakes this repo has already paid for: no
XPath, no generated ids, no `isVisible()` inside a gate, `allowSubmit` never
assigned, every submit-fronting method guarded by a `BusinessException`, no
`ignoreHTTPSErrors`, and — the genuinely new one — **no gate budget exceeding
its enclosing step's `timeoutMs`**, which is the truncation that once cut the
quote-documents page off mid-render and made the runner retry a transaction that
had already created a real quote.

**Proves:** it compiles, respects the import boundaries, and repeats none of the
known mistakes.
**Does not prove:** that a single locator resolves on the real portal.

---

## Rung 1 — the suite

```bash
pnpm test        # read the count it PRINTS. Never quote one from a document
```

Includes the source-level guard tests on `quote-start.page.ts`,
`carrier-portal-session.test.ts` (836 lines of sign-in ordering), and
`portal-errors.test.ts` — every string in which is one the live portal actually
produced. **If your fix touched classification, add the newly captured string
there.**

**Proves:** no regression in the pinned behaviours.
**Does not prove:** that the portal emits that wording on that screen.

---

## Rung 2 — live locator resolution. **This is the rung that carries the fix.**

```bash
pnpm tsx tooling/scripts/anthem-serve.ts &
pnpm tsx tooling/scripts/anthem-do.ts "u <screenUrl>"
pnpm tsx tooling/scripts/anthem-verify-locators.ts --role combobox --name "Group County"
pkill -f anthem-serve
```

Reports, against the live DOM:

| Reported | Why it is the evidence |
|---|---|
| `count()` | 0 = the locator is wrong |
| **visible** count | 1 is what you want. `count() > 1` with `visible: 1` is normal — the wizard pre-renders every branch |
| resolved role + accessible name + `data-value` | Catches the `aria-label`-overrides-text family and the `value`-vs-`data-value` family |
| the ambiguity list | Names what to scope against |

Read-only **by construction**: a source-level test asserts the script contains
no `.click(`, `.fill(`, `.check(`, `.press(`, `.selectOption(` or
`.setInputFiles(`.

**Proves:** the locator resolves, uniquely and visibly, on the real production
screen.
**Does not prove:** that the action after it lands, that the postcondition
becomes true, or anything about screens downstream.

---

## Rung 3 — gate semantics, live

Two read-only measurements:

1. **Cold.** Navigate, then immediately verify with no settle. A correct waiting
   gate answers `true`; an `isVisible()` gate answers `false`. This is the
   "dashboard still painting *Loading, please wait ...*" failure turned into a
   measurement.
2. **Negation cost.** Time it. A negated `textVisible` burns its full budget to
   answer "no" — 46.6s, measured. A gate that takes its whole budget to say no
   is a finding.

---

## Rung 4 — the two permitted check scripts

```bash
pnpm tsx tooling/scripts/check-portal-access.ts        # credential-free, creates nothing
pnpm tsx tooling/scripts/check-portal-navigation.ts    # signs in, creates nothing
```

Run these when the change is in login / session / SAML / bot-protection
territory. `check-portal-navigation.ts` reaches the platform via the
`Small Group Quote & Enroll` launchpad tile — verified to create no account, no
quote and no application. `Create Quote` is **not** touched.

**Caveat that must be honoured:** it signs in, so it *can* spend an MFA code if
the stored session has lapsed. Check first:

```bash
pnpm rpa sentinel anthem-ca/portal-session
```

If the portal session has lapsed, **this rung is unavailable** and the PR says
so. Do not spend a code to climb a rung — that is an escalation (§ escalation.md,
"needs an MFA code").

---

## Rung 5 — container parity (a **human** rung)

```bash
docker compose run --rm -e HEADLESS=false \
  --entrypoint tooling/docker/with-display.sh rpa \
  pnpm tsx tooling/scripts/check-portal-access.ts
```

Only needed when the change touches the browser, session recovery or the
container. **`docker` is denied to a repair session**, so list this in the PR as
*"not run — requires the reviewer"*.

---

## Rung 6 — the reference automation, end to end

```bash
pnpm rpa queue group-submission/carrier-portal-submission-demo --reset
pnpm rpa run  group-submission/carrier-portal-submission-demo
```

Must produce **exactly**:

```
processed : 4        success : 2        business : 1        system : 1        retries : 3
```

with `SUB-1003` recovering on attempt 2 and `SUB-1004` exhausting its retries.
**If the numbers differ, something in the runner or the automation is wrong — do
not adjust the expectation.**

This is the most underused rung available under the freeze: a full, real,
unattended run of `step()`, the gates, the retry loop, session recovery and the
artifact store, on a portal where writing is safe.

**Any heal that edited `processTransaction.ts`, `initialize.ts` or a step spec
MUST climb it** — that is where an edit can break the `step()` contract in a way
no static check sees.

Report "reference automation unavailable" (saucedemo down) distinctly from
"reference automation failed".

---

## The `Not verified` section — mandatory, fixed phrasing

> **Not verified — and why**
>
> - `<step name>`: the action **writes** to the portal (`Create Quote` / a wizard
>   Continue / a census upload / a plan `Select` / the signature). Executing it
>   creates a real record; rule 10a forbids it. Nearest evidence obtained: rung 2
>   — the locator resolves to 1 visible match with accessible name `<…>` on the
>   live screen. **The action itself is unproven.**
> - **Skip-ahead semantics.** `step()` checks the postcondition before the
>   action; proving "already satisfied → skipped" requires the action to have run
>   once. Unprovable under the freeze.
> - **The `repair()` path.** Reached only after a live postcondition failure.
>   Unprovable.
> - **Everything downstream of `<screen>`.** The Vlocity rail refuses forward
>   jumps, so a screen can only be reached by walking the wizard, which writes.
> - **The DocuSign ceremony.** A CDP-attached browser does not expose
>   out-of-process iframes; the recon harness cannot see it at all.
> - **Container parity.** Rung 5 not run: `docker` is outside the healing policy.
>   Reviewer action.

And one computed line, because it is the failure mode of every autohealer:

> **No check was weakened to make this pass.** Preconditions removed: 0 ·
> `alwaysRun` added: 0 · timeouts raised: 0 · tests relaxed: 0 ·
> classifications changed: 0

Those five counters come from the healing policy's diff analysis, so the claim is
computed rather than asserted.
