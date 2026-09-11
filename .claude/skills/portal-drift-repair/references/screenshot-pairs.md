# Masked before/after pairs

## Why "before" is a re-capture, not the failing run's screenshot

`mask` is a **capture-time** option of `page.screenshot()`. The screenshots the
failing probe already wrote are therefore unmasked and **cannot be masked
retroactively**. They stay in gitignored `artifacts/` and are referenced by path
in the PR; they are never uploaded.

So "before" is taken from the same screen, by the same script, **while the
working tree is still at the pre-fix revision**. One code path producing both
halves is what makes the pair comparable — two different capture routines would
differ in viewport, mask version or full-page behaviour, and the comparison
would then be of the capture rather than of the portal.

This is why §8 of the skill says *before first, then fix, then after*, and why
the check script refuses a pair whose two halves share a git revision.

## The commands

```bash
# BEFORE - tree still at the pre-fix revision, recon browser parked on the screen
pnpm tsx tooling/scripts/capture-masked-pair.ts --issue 412 --phase before --label county-picker

# ... apply the fix ...

# AFTER - same screen, same script
pnpm tsx tooling/scripts/capture-masked-pair.ts --issue 412 --phase after --label county-picker

# BLOCKING. Nothing gets committed until this passes.
pnpm tsx tooling/scripts/check-masked-evidence.ts --issue 412 --label county-picker
```

## Mask deny-by-default

`src/pages/masks.ts` does **not** mask "the fields we know are sensitive". It
masks **every value-bearing control unconditionally** — `input`, `textarea`,
`[role=combobox]`, `[data-value]`, `lightning-formatted-*` — whether or not the
list has heard of it, plus named regions that are not inputs (the producer name
in the header, the checklist's File Name column, the census grid, the agent
block), plus anything whose text contains a payload string.

**Publish structure, never values.**

The asymmetry is the argument: an over-mask costs a reviewer one question; an
under-mask puts a real producer's name or a group's FEIN into git history
permanently, because these images are committed.

What stays visible, deliberately: labels, legends, headings, buttons, the wizard
rail, modals and **alert text** — exactly what a locator-drift reviewer needs.
An alert that quotes the group's name is still covered, by the content-matched
masks.

## The coverage check is geometry, not trust

Each capture records a bounding box for every mask **and** for every visible
value-bearing control. The check asserts each control is **fully inside** the
union of the masks — not merely overlapping, because a half-covered FEIN is
still a FEIN.

That turns "we masked it" from a claim into a computed property.

**What it still cannot prove:** it verifies the boxes it *found*. A value drawn
into a canvas, a background image or an `svg <text>` would not be among them.
That residual risk is why the mask list is deny-by-default, why only **two**
images per heal are permitted, and why the reviewer checklist asks for an
explicit human confirmation.

## Where the images go

```
docs/poc/anthem-ca-new-plans/evidence/heal-<issue>/<label>.before.masked.png
docs/poc/anthem-ca-new-plans/evidence/heal-<issue>/<label>.after.masked.png
```

Committed, so they render in the PR diff and inline in the drift log. `gh` has
no image upload, and gists and any external host are ruled out by policy — so
the internal repository is the only place they can live and still be reviewable.

Guards: **exactly two** images per heal, ≤250 KB each, never a trace, never a
video, never the `READ_DIAGNOSTICS` reading (it contains `fields[].value`), never
an unmasked original.

## When "before" cannot be reached

Common, not exceptional: anything past `Create Quote` on a fresh group, the
DocuSign ceremony, the `inprogressapplication` redirect.

1. Capture `after` alone, with the reason declared:
   ```bash
   pnpm tsx tooling/scripts/capture-masked-pair.ts --issue 412 --phase after \
     --label county-picker --before-unreachable "the screen is only reachable via Create Quote, which writes"
   ```
   The check script permits a single-sided pair **only** with that flag set.
2. In its place, the PR carries a **text** before/after: the `READ_DIAGNOSTICS`
   reading reduced to `{alerts, wizardStep, buttons, modal, fields[].label}` —
   **labels only, values dropped** — then and now. This is often the
   higher-signal artifact anyway: one real tell was *"`Choose File` is absent
   from the button list"*, which is a text diff, not a picture.
3. State it verbatim in the PR:

   > No masked BEFORE: the failing screen is only reachable by an action that
   > writes to the portal (`<what>`), which rule 10a forbids. The unmasked
   > original from the failing run is at `artifacts/<runId>/<file>` on the
   > healing host and has not been uploaded.

**Corollary worth remembering:** the drift log records that the rail's unlabelled
step names were *finally read off a screenshot*. Sometimes the picture is the
only source — so when a screen IS reachable, capture the pair even if the diff
looks obvious.
