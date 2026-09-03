# UHC — field map

Payload/config field → portal field, per screen.

> ⚠ **Every row is UNVERIFIED.** Derived from a runbook, not from the portal.
> Confirm each during the re-map, correct this file, and mark corrections.

Legend: `payload.x` = queue item · `{x}` = config · **derived** = computed, not copied

## Stage 2.3 — Owner assignment

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| First name | `{producerFirstName}` | | ☐ |
| Last name | `{producerLastName}` | | ☐ |

## Stage 3.1–3.2 — Employer information and locations

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Company name | `payload.companyName` | | ☐ |
| Effective date | `payload.coverageEffectiveDate` | | ☐ |
| Franchise code | *left blank at this stage* | | ☐ |
| Zip | `payload.zip` → **must generate** `payload.county` | | ☐ |
| Total applying (active + COBRA) | **derived** — enrolling in a UHC plan | | ☐ |
| Total eligible | `payload.eligibleEEs` | | ☐ |
| FTE count | `payload.fteCount` | | ☐ |

## Stage 3.3 — Primary contact

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Name | `payload.benefitsAdmin.firstName/.lastName` | | ☐ |
| Email | `payload.benefitsAdmin.email` | | ☐ |
| Phone | `digitsOnly(payload.companyPhoneNumber)` — **no dashes or parens** | | ☐ |
| Phone type | *Business* | | ☐ |
| Role | *Benefit Administrator* | | ☐ |
| Preferred contact | *Email* | | ☐ |

## Stage 3.4 — Products to quote

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Products | `payload.policies[]` | | ☐ |
| SIC code | `payload.sicCode` (type before the dropdown matches) | | ☐ |
| Cannabis industry? | *No* | | ☐ |

## Stage 5 — Plan selection

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Rating method | `payload.ratingStructure` — **check before AND after** | | ☐ |
| Plan filter | `payload.policies[].planName` | | ☐ |
| Rider — domestic partner | **required on every plan** | | ☐ |
| Rider — aged 29 | **must NEVER be selected** | | ☐ |
| Employee contribution % | `payload.policies[].eeContribution` | | ☐ |
| Dependent contribution % | `payload.policies[].dependentContribution` | | ☐ |
| TIN | `payload.fein` | | ☐ |

### Contribution overrides — **derived, must be computed**

| Condition | Value entered |
|---|---|
| California group, 100% contribution, not everyone enrolling | **99%** + note it |
| Flat-dollar contribution | **50%** |

## Stage 6.1 — General information

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Group name for ID card | `payload.companyName` | | ☐ |
| Street address | `payload.streetAddress1` | | ☐ |
| Years in business | **derived** from `payload.dateEstablished` | | ☐ |
| Organization type | `payload.entityType` | | ☐ |
| Employees besides self/spouse? | *Yes* | | ☐ |
| Medical benefit plan option | `payload.medicalDeductibleReset` | | ☐ |
| Domestic partner coverage | *Yes* | | ☐ |
| Workers comp | `payload.workersComp` | | ☐ |

## Stage 6.2 — Eligibility — **derived thresholds**

| Portal field | Rule | Locator | ✓ |
|---|---|---|---|
| Subject to ERISA? | *Yes* | | ☐ |
| Coverage during leave? | *Yes* | | ☐ |
| Which continuation? | `fteCount < 20` → **State**, `>= 20` → **COBRA** | | ☐ |
| Which primary option? | `eligibleEEs < 20` → **Medicare**, `>= 20` → **Plan Primary** | | ☐ |

## Stage 6.3 — Waiting period — **mapping unknown**

Hippo and UHC use different vocabularies. Read UHC's dropdown during the re-map.

| Hippo value | UHC portal value | ✓ |
|---|---|---|
| No waiting period | _(to be discovered)_ | ☐ |
| 1st of month after hire | _(to be discovered)_ | ☐ |
| 1st of month after 30 days | _(to be discovered)_ | ☐ |
| 1st of month after 60 days | _(to be discovered)_ | ☐ |
| 1st of month after 90 days | _(to be discovered)_ | ☐ |

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Termination lag | `payload.policies[].terminationPolicy` | | ☐ |
| Waived for initial enrollees? | `payload.waivedWP` | | ☐ |
| Waived for rehires? | *No* | | ☐ |

## Stage 7.1 — Producer

| Portal field | Source | Locator | ✓ |
|---|---|---|---|
| Producer 1 | `{producerFirstName} {producerLastName}` | | ☐ |
| Commission % | `{commissionPercentage}` | | ☐ |
| Commission payable to | *General Agent* | | ☐ |
| General agent | `{generalAgentName}` | | ☐ |
| Franchise code | `{generalAgentFranchiseCode}` | | ☐ |
| Email | `{generalAgentEmail}` | | ☐ |
| PCIS ID | `{pcisId}` | | ☐ |

## SAMx bulk census columns — **documented, verify anyway**

| Column | Contents | Hippo source | ✓ |
|---|---|---|---|
| R | Medical Coverage Type | **derived** from relationship + enrollment | ☐ |
| S, AA | Medical Waiver Reason | `Waiver Reason - Medical`, mapped | ☐ |
| Y | Waive All Products | **derived** — waiver reason populated | ☐ |
| Z | Medical Plan Code | `Current Medical Policy` | ☐ |
| AQ | SSN (employees and dependents) | `EE SSN` | ☐ |

### Waiver reason mapping — only one is documented

| Hippo value | UHC portal value | ✓ |
|---|---|---|
| `individual_policy` | **Individual Exchange** | ☐ |
| _(others)_ | _read off the portal dropdown — **do not guess**_ | ☐ |
