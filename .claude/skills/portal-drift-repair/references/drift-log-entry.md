# Writing a drift-log entry

## The format

Four columns, appended to `docs/poc/anthem-ca-new-plans/drift-log.md`:

```
| Date | Documented step | What the portal actually does | What the automation does now |
```

The log's own header states the norm:

> An empty drift log after re-mapping a week-old runbook against a live portal
> means the re-mapping did not happen. Portals change; record it.

## The vocabulary that makes the log trustworthy

Column 2 carries a tag. These are load-bearing, not decoration.

| Tag | Means |
|---|---|
| `(not documented)` | The runbook never covered this at all |
| `(our bug)` | **We** were wrong, not the portal |
| `(measured)` | A number with a real observation behind it |
| `(harness limit)` | Our tooling cannot see it — e.g. CDP cannot see DocuSign's out-of-process iframes |
| `(root cause, Nth reading)` | An earlier row in this log is now wrong. **Say which one.** |
| `(unverified)` | Believed, not proven — because rule 10a forbade the proof |

`(our bug)` is the most valuable of these, and the one a repair session is least
likely to reach on its own. Seventeen of the existing rows carry it.

## Two rules

**An entry that only says "fixed the locator" is not an entry.** Column 3 must
say what the **portal** does; column 4 says what the **automation** now does.
Someone reading this in three months needs the former more than the latter.

**Never silently correct an earlier row.** Add a new row that retracts it, the
way the existing retractions do. One failure in this log has three successive
readings, the first two explicitly wrong and named as such. **A retraction is a
contribution.**

## Example

```
| 2026-09-11 | (not documented) The county picker on Group Setup | It is now a `role=combobox` whose value lives on `data-value`; the old `getByLabel('Group County')` resolves to the wrapper and reads as empty | Scoped to the combobox and asserts `data-value`; `field()` in lightning.ts already did this for other controls |
```

## Also update

- `process-steps.md` and `field-map.md`, **marking the corrected lines** so the
  diff against the original stays visible.
- The screen baseline, so the next comparison is meaningful:
  ```bash
  pnpm tsx tooling/scripts/screen-baseline.ts write --screen <screenId> --note "<why>"
  ```
  Without the baseline refresh, "the portal changed" stays a feeling. With it,
  it is a diff.
