# Roster File Validation (demo)

Validates member elections against the carrier plan catalog. **No browser is
launched** - this is the reference implementation for `sessionKind: "none"`.

| | |
|---|---|
| **Id** | `member-submission/roster-file-validation-demo` |
| **Domain** | `member-submission` |
| **Owner** | @gusto/benefits-rpa-member-submission |
| **Session** | none |
| **Queue** | `member-submission.roster-file-validation-demo` |

## Run it

```bash
pnpm rpa run member-submission/roster-file-validation-demo
pnpm rpa queue member-submission/roster-file-validation-demo --reset
```

No credentials needed, and no `HEADLESS` to think about - there is no browser.

## The four seeded transactions

| Reference | Outcome | Why |
|---|---|---|
| `MBR-2001` | success | Valid plan code, effective the first of a month, inside the window |
| `MBR-2002` | **business** | Plan code is not in the catalog. No retry can add it |
| `MBR-2003` | **system, recovered** | Injected fault fails attempt 1; attempt 2 succeeds |
| `MBR-2004` | **system, exhausted** | Injected fault always throws; failed after `maxRetries` |

Expected summary: `4 processed / 2 success / 1 business / 1 system`.

## Data rule

Payloads carry `memberRef` and nothing identifying - no names, no dates of
birth, no SSNs, no wages. See the note in
[the domain README](../README.md#a-note-on-data).
