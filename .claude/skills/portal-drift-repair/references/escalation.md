# Escalation

**Escalating is a completed heal with a diagnosis deliverable, not a failure.**

A partial diagnosis, honestly labelled, is worth more than a fix that was guessed
at — and on this portal a guessed fix is edited into an automation that files
real applications.

## The five triggers

| Trigger | Recognised by | The comment must say |
|---|---|---|
| **Out of scope** | The fix needs a write-denied path — `packages/core`, `config/`, `automation.json`, `.mcp.json`, another automation | The diagnosis, the proposed patch **as a fenced diff**, and which rule puts it out of scope |
| **Needs the freeze lifted** | The only remaining evidence is a run, or the failing screen is only reachable by writing | What the run would prove, **what it would create on production**, and a pointer to `production-cleanup.md` |
| **Needs an MFA code** | The session probe says the *portal* session has lapsed | That a code takes a measured 132–600s and expires on a countdown, that `carrierops@gusto.com` is the primary recipient and unreadable to us, and that you deliberately did **not** spend one |
| **Ambiguous root cause** | Two or more hypotheses survive the evidence | Each hypothesis, the evidence for and against, and **the single cheapest experiment that would separate them** |
| **Budget exhausted** | Wall clock, prompt count, edit/diff caps, or three consecutive denials | What was established, what was ruled out, artifact paths, and the next thing to try |

## The comment template

```markdown
### Escalation — no PR opened

**Reproduced:** <yes / partially / no> — <how>
**Screen:** `<url>` — `<step / heading>`
**Evidence:** `artifacts/sentinel/<runId>/<probe>/{evidence,screen.<id>}.json`,
`artifacts/heal/<issue>/{transcript.jsonl,<label>.before.masked.png}`

**Diagnosis** `(not documented | our bug | measured | harness limit | unverified)`
<what I believe, and precisely how confident I am and why>

**Ruled out**
- <thing>, because <measurement>

**What I would change** (not applied)
```diff
<the patch>
```

**Why I stopped:** <trigger>
**What a human needs to decide:** <the one question>

**Not done:** no branch pushed, no PR opened, no portal record created.
Rungs climbed: <list>. Rungs unavailable: <list, with reasons>.
```

## The honesty requirements

These are drawn from the drift log's own behaviour, which retracts wrong
diagnoses **by name** — one failure has three successive readings, the first two
explicitly wrong.

- **A retraction is a contribution.** A guess presented as a fix is not.
- If you cannot say *how* you know, say that instead.
- Name the row you are retracting. Never silently correct one.

## The rule that stops the classic autohealer pathology

> If the ladder goes green only after you removed a precondition, widened a gate,
> raised a timeout or relaxed a test — **you have not fixed anything.** Revert it
> and escalate.

The healing policy refuses each of those as a diff rule, so you will be blocked
rather than merely discouraged. Being blocked three times in a row is itself an
escalation trigger: it means you are arguing with a wall instead of diagnosing.

## What never happens on an escalation

No branch pushed. No PR opened. No baseline re-blessed. No portal record
created. The issue gets a comment and the `sentinel:healing-in-progress` label is
**removed**, so the sentinel resumes reporting on it.
