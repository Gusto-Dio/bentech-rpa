# Porting the census macros

Both processes depend on Excel VBA macros that transform the Hippo OE census
into each carrier's upload template. Playwright cannot run VBA, so they are
being ported to TypeScript.

| Macro | Used by | Produces |
|---|---|---|
| `Anthem_NewPlans` | Anthem CA | Two tabs on the OE census: **OCE** and **Quoting** |
| `SAMx_PortalBulkCensus` | UHC | The **SAMx Portal Bulk Census** template |

## Why port rather than keep the manual step

An automation that still needs a human to open Excel and run two macros is a
partial automation. It also cannot run unattended on a Linux server, which is
where this framework is designed to run.

## The dependency

`exceljs@4.4.0`, added to `@auto/group-submission-shared`.

Chosen over sheetjs because it is **pure JavaScript with no native build** —
which keeps the macOS-arm64 → Ubuntu-amd64 portability promise intact. A native
xlsx module is exactly the class of dependency this repo avoids.

## The input: Hippo OE census

35 columns, one row per person. The header names are the contract with Hippo and
are listed verbatim in
[`_shared/src/census/hippo-census.ts`](../../automations/group-submission/_shared/src/census/hippo-census.ts).

The split that everything downstream depends on:

- **Enrolling** — `Waiver Reason - Medical` is empty
- **Waiving** — `Waiver Reason - Medical` is populated

Carrier census templates take **enrolling people only**. Waivers go on a
separate tab (Anthem) or are flagged in dedicated columns (UHC).

## `SAMx_PortalBulkCensus` — the specified columns

The runbook states these explicitly, which makes UHC the easier port to verify:

| Template column | Contents |
|---|---|
| **R** | Medical Coverage Type |
| **S** and **AA** | Medical Waiver Reason |
| **Y** | Waive All Products |
| **Z** | Medical Plan Code |
| **AQ** | SSN (employees and dependents) |

Two behaviours the runbook calls out:

- Dependents who are **waiving** are removed from the census before the
  transform runs.
- **Dental and vision columns are intentionally left blank** — this macro covers
  medical and employee/dependent information only.
- **PCP information is not automated.** Select Plus plans needing a PCP code use
  the placeholder in `dummyPcpCode`.

### Waiver reason mapping

Only one mapping is documented:

```
Hippo `individual_policy`  ->  UHC portal `Individual Exchange`
```

**The rest of this table has to be read off the portal's own dropdown during the
re-mapping pass. Do not guess it.** A wrong waiver reason is a silently incorrect
submission, not a visible error.

## `Anthem_NewPlans` — RECOVERED 2026-09-03

**This document previously said the VBA was compiled and the layout would have
to be reverse-engineered from the portal. That was wrong.** The `.xlsm` stores
its VBA under ordinary **MS-OVBA compression**, not compilation, and `Module10`
decompresses to readable source. No special tooling is needed — the compressed
container starts with a `0x01` byte inside `xl/vbaProject.bin` and the format is
a documented run-length scheme.

So the Quoting transform is now known exactly rather than inferred. Against the
real 35-column Hippo header, `Anthem_NewPlans` does:

1. deletes 19 named columns if present (only `Hours Worked` actually exists in
   the current export — the macro is older than the census format, and
   `Find(LookAt:=xlWhole)` simply skips the rest)
2. sums `Current Medical Cost - Premium` and writes a bold `Total Premium`
   header plus the sum two and three rows below the data — that is the **EFT
   form total**, not part of the census
3. copies the `Enrollment Census` sheet to an **OCE Census** tab (out of PoC
   scope — it belongs to employee enrollment)
4. copies it again to a **Quoting** tab and reduces it to five columns:

| Out | Source | Transform |
|---|---|---|
| A | `First Name` | — |
| B | `Last Name` | — |
| C | `Gender` | — |
| D | `Relationship` | `"Partner"` → `"Spouse"`, **substring** (xlPart) |
| E | `DOB` | — |

then deletes the header row.

### Two things the macro does NOT do

- **It does not filter waivers.** The runbook has a human separate enrolling from
  waiving people *before* running it. An unattended port has no human, so the
  caller must split first — `HippoCensusReader.splitByEnrollment`.
- **It does not tidy the Relationship value.** Because the replacement is a
  substring, Hippo's `Domestic Partner` becomes `Domestic Spouse`. That is what
  has been going to Anthem. It is reproduced rather than silently corrected, with
  a `TODO(remap)` to confirm against the template's accepted values.

### The input format

The real Hippo export is an **`.xlsx`** with a single sheet named
**`Enrollment Census`** — the name the macro selects by — whose 35 headers match
`HIPPO_CENSUS_COLUMNS` exactly. Dates arrive as **Excel serials** (`33192`), not
formatted dates. The committed fixtures are `.csv`; `HippoCensusReader` reads
both.

### Still to confirm

The macro says what the five values MEAN. It cannot say what Anthem's
currently-downloadable template asks for — and the portal moved to a new platform
in the meantime. The template's real header row, read at the `Employee Census`
wizard step, is the authority.

## Testing the port

The same way the `SpecificContent` codec is tested: a known input produces a
known output.

`data/input/census-sample.csv` in each automation is the fixture — three
synthetic people, one of them waiving with reason `individual_policy`, which
exercises the enrolling/waiving split and the one documented waiver mapping.

Assert on the produced template's cells, not on "it did not throw".

## Out of scope for the PoC

Dental, vision and life/disability products; real PCP assignment; and the OCE
census stage of the Anthem process, which sits past the PoC boundary.
