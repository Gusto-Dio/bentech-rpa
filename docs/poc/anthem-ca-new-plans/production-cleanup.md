# Anthem CA — what the PoC left on production, and what to clean up

Mapping and proving this automation was done against Anthem's **production**
portal, because there is no sandbox. That created real records under a real
producer's licence, for groups that do not exist.

**Nothing here is customer data.** Every group is the synthetic `The Company LLC`
family, with invalid-by-construction SSNs (`000-` prefix, never issued) and
made-up FEINs. But the *records* are real, and Anthem may act on them — so they
need cancelling.

All of it was created on **2026-09-03**, between roughly **05:50 and 22:02 UTC**,
by the writing agent and paid agency named in the Benefits runbook.

---

## ⛔ Production is frozen until this is cleared

**Only signing in and navigating are permitted against Anthem production.**
Nothing that creates or changes a record — no quote, no account, no application,
no signature.

`allowSubmit: false` does **not** satisfy this. A run at that setting still
creates a real account and a real quote before it parks on Attestation, which is
exactly what produced most of the list below.

So `pnpm rpa run group-submission/anthem-ca-new-plans` is off limits for now, at
any setting. Use the login/navigation checks instead — see rule 10a in
[`AGENTS.md`](../../../AGENTS.md). The freeze lifts when the Benefits team has
confirmed these records are cleared and told us what the exposure was.

---

## The reliable way to find everything

**Search Accounts, Quotes and Applications for `The Company LLC`.**

That single string catches every record, because every group used it with a
trailing number. It is more dependable than the identifiers below: several runs
died before writing evidence, so the quote list is complete only as far as the
logs go, whereas the name is on everything.

Common attributes, useful as filters:

| | |
|---|---|
| State | CA |
| Effective date | **2026-09-01** |
| Portfolio | ACA, Small Group |
| Employees | 3 eligible, 2 enrolling, 1 waiving |
| Plans quoted | `8VAY` Bronze Select PPO · `8VAN` Bronze PPO · `8V5C` Gold PPO · `8V63` Platinum Select PPO |
| Group contact / signatory | `Jane Doe`, CEO — synthetic |

---

## 1. Signed and filed applications — **seven**, the priority

These are the ones that matter. Each is a **signed, filed employer application**
with a completed DocuSign envelope. They stopped at `Document Checklist` and
were never submitted with documents, but the application itself is filed.

| # | Group | FEIN | Quote | Notes |
|---|---|---|---|---|
| 1 | **The Company LLC** | `881234567` | *(not captured)* | 17:19 UTC. The quote PDF was not saved, so the number is unknown — find it by group name |
| 2 | **The Company LLC** | `881234567` | `02283813` | 17:25 UTC. **A second application for the same group name**, six minutes after the first |
| 3 | **The Company LLC 2** | `881234568` | `02284005` | |
| 4 | **The Company LLC 3** | `881234569` | `02284033` | |
| 5 | **The Company LLC 4** | `881234570` | `02284068` | |
| 6 | **The Company LLC 5** | `881234571` | `02284174` | |
| 7 | **The Company LLC 6** | `881234572` | `02284186` | |

> **Rows 1 and 2 are worth a second look.** Anthem normally refuses a second
> application per group — a re-run redirects to "Application Matching Error". Two
> filed applications for the same *name* six minutes apart suggests Group Setup
> created **two separate Account records** rather than reusing one. So expect
> duplicate accounts named `The Company LLC`, each with its own application.

**Also in DocuSign:** seven completed envelopes under the agency, one per row
above. The only ID captured is
`F48EBEE7-7B7D-8733-8262-52A5404B04CF` (row 2). The rest are findable by the
signer name `Jane Doe` and the 2026-09-03 date.

## 2. Quotes with no filed application — at least five

Created by runs that reached the quote and then stopped or failed before the
signature. Harmless, but they clutter the book of business.

`02283094` · `02283149` · `02283158` · `02283484` · `02284129`

`02284129` is the interesting one: it came from a re-run that built a fresh quote
and *then* hit the Application Matching Error, so it is an orphan attached to a
group that already had an application.

**This list is a floor, not a ceiling.** Roughly twenty runs reached Group Setup
or beyond while the wizard was being mapped, and the ones that died early left no
usable evidence. Assume there are more orphan quotes than are listed here, and
work from the group name.

## 3. Account records — expect duplicates

Every run that got through Group Setup created an Account. Most of those runs
then failed further along, so there are likely **many** accounts named
`The Company LLC` (and one each for `2`–`6`), most with nothing attached.

## 4. What is NOT there

- **No document uploads.** The automation always stopped *at* `Document
  Checklist` and never pressed its `Submit`. The only attachments are the two
  Anthem adds itself: the signed employer application and the quote PDF.
- **No EFT forms sent to anyone.** The `Send EFT Via DocuSign` question was
  answered **No** on every run — verified: `No` is also the portal's default.
- **No member enrollment.** `Member Enrollment Type` was set to
  `Online Census Tool` on the later runs, but no census was ever submitted
  through it.
- **`The Company LLC 7`** (FEIN `881234573`) is in the repo seed but was
  **never run** — there is nothing on the portal for it.
- **Nothing from 2026-09-04.** The one run that day was stopped immediately
  after sign-in, before any quote was created.

---

## What to ask the business team

1. **Cancel or withdraw the seven filed applications** (section 1). This is the
   only part with a real downstream effect — Anthem's new-business team may
   otherwise pick them up as genuine submissions.
2. **Void the seven DocuSign envelopes.**
3. **Delete the orphan quotes** (section 2) and any others found by searching
   the group name.
4. **Delete the duplicate Account records** (section 3), once the applications
   and quotes hanging off them are gone.
5. **Confirm nothing was routed onward** — if any of these reached
   underwriting or a group-number assignment, that needs unwinding too rather
   than just deleting the record.

## Preventing a repeat

`allowSubmit` is `false` in dev, staging and prod, and at that setting a run
drives the whole wizard and stops on `Attestation` with a `BusinessException`
before anything is signed. It was flipped deliberately, seven times, to map and
then prove the steps after the signature — see the `$comment_allowSubmit` note in
`config/config.dev.json` and rule 10 in [`AGENTS.md`](../../../AGENTS.md).

Each full run also needs a **fresh group name**, because Anthem refuses a second
application per group. That is what produced the `2`–`6` suffixes, and it is why
this list is as long as it is. A carrier sandbox would remove the need entirely
— tracked in [open-questions.md](open-questions.md).
