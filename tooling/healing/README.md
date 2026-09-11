# The healing harness

What an unattended repair session may do, and how that is enforced.

The procedure the agent follows is
[`.claude/skills/portal-drift-repair/SKILL.md`](../../.claude/skills/portal-drift-repair/SKILL.md).
This directory is the machinery around it.

| File | What it is |
|---|---|
| `policy.ts` | The boundary, as data and functions. Deny wins; unknown is deny |
| `policy.test.ts` | The regression net a settings file could not carry — 99 assertions, each a specific way an agent could reach something it must not |
| `permission-handler.ts` | The gate every tool call passes through. Pure `evaluate()` for testing, plus the transcript-recording wrapper |
| `transcript.ts` | The audit log. Scrubs structurally, not textually |
| `probe-self-test.ts` | `pnpm heal:selftest`. Group A proves the policy is correct; `assertWiringObserved` proves it is in the path |
| `session.ts` | Phases, budgets and the failure matrix |
| `mask-coverage.ts` | The containment geometry behind "is this screenshot safe to commit?" |

## Why the policy is code

`.claude/settings.local.json` is gitignored — per-machine, invisible to review,
and prone to silent widening on an always-on host. The failure mode of
settings-based permissions is that they get broader and nobody notices.

As a function, the policy gets what everything else load-bearing in this repo
gets: a regression test. `policy.test.ts` asserts that
`pnpm check; pnpm rpa run group-submission/anthem-ca-new-plans` is denied — a
JSON allow-list cannot carry that assertion, and this is a repo where one
forbidden command creates a real account and a real quote on a production
carrier portal.

`.claude/healing-permissions.json` is the **inner** layer, and it is tracked
rather than gitignored for the same reason. Two layers are needed because the
ACP permission handler only fires when the agent *chooses* to ask.

## Two things that are easy to get wrong

**`toolHost` must never be supplied** to the ACP client. Doing so makes it
advertise `fs.writeTextFile` and `terminal`, which are direct client methods and
**do not pass through the permission handler** — the two capabilities the entire
policy exists to constrain.

**`model` in the ACP config is a label, not a selector.** It labels stream
envelopes; it does not choose the agent's model. Opus has to be selected through
`args` or the environment, and `assertWiringObserved` checks the id that was
actually reported. A repair session silently running on something cheaper
against a production automation is an easy and invisible failure.

## Policy changes, and what motivated each

The drift log's own pattern, applied to the harness. Every widening or
narrowing below was prompted by something specific.

| Date | Change | Why |
|---|---|---|
| 2026-09-11 | Exact-pipeline check moved ahead of the deny patterns | The credential-path deny rule refused the documented orphan-browser sweep, because its `grep` argument mentions `data/profiles`. The sweep matches process command lines; it never reads a profile — and a policy that refuses the one cleanup command AGENTS.md tells you to run gets a reputation for being wrong, and then gets widened |
| 2026-09-11 | Transcript scrubbing made structural rather than textual | Scrubbing the stringified input silently stopped matching field names, because `"password"` had become `\"password\"`. The transcript *looked* scrubbed, since the secret-value pass still worked, while every field-name rule had quietly stopped firing |

When an escalation's trigger is **out of scope**, that is a signal about the
blast radius. When it is **three consecutive denials**, that is a signal that a
deny rule is either wrong or badly explained. Both belong in this table.
