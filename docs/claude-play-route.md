# The Claude + Playwright agentic route

This documents a path that was evaluated and **not approved** for BenOps/benefits
work, why, and where it is still a legitimate option.

## What it is

Not the deterministic execution this repo is built on. The "Claude + Playwright"
route means an AI agent reads the live page and decides, at runtime, what to
click or type next - no stored selectors, no committed mapping. `browser.py` /
`agent.py` in [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
is a public example of exactly this shape: an indexed action space, a small LLM
picking the operation and target every step.

## Why it was not approved here

In April, the steel thread team approved Claude Code + Playwright for benefits,
then ruled it out within the first week, on two grounds:

- **PHI access** - a live agent has broader, less controllable access to
  sensitive data on screen than a deterministic script touching only the
  fields it was told to.
- **No safe retry** - the same workflow ran differently at different times of
  day. That is disqualifying when a carrier submit is irreversible: a
  non-deterministic agent cannot give a guarantee that retrying a failed step
  does not double-submit or take a different, unreviewed path.

This is not a verdict on the technology. It is a verdict on running
non-deterministic decisions in the same path as an irreversible action on
sensitive data - which is exactly what this repo's deterministic core (see
[architecture.md](architecture.md)) exists to avoid.

## Where it is still a legitimate option

**Read this and know:** if you are building automation for something that is
**not** BenOps/benefits, and does not touch PHI or an irreversible carrier
submit - an internal tool, a low-stakes internal integration, a process
against a system with no sensitive data and a cheap undo - the Claude +
Playwright agentic route is a reasonable choice, and often faster to stand up
than mapping selectors by hand.

The two questions that decide it, every time:

1. **Does the process touch PHI, PII, or anything else sensitive?** If yes,
   stay deterministic.
2. **Is the end action reversible?** If a mistaken step can be undone or
   simply retried with the identical result, an agent deciding live is an
   acceptable risk. If it is a one-way submit, it is not.

If a future process here answers "no" and "yes" to those two, in that order,
reach for the agentic route deliberately - do not smuggle it in by copying an
automation that already answers differently. Whoever adds it should link back
to this file in their PR description, so the reasoning travels with the code
that pattern-matches it later.
