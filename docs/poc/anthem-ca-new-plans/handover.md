# Anthem CA new plans — get it running on your machine

Everything you need to run the automation yourself, plus the things that will
bite you. Read the **Warnings** section before your first run; one of them is
irreversible.

---

## 1. The site

| | |
|---|---|
| **Login** | `https://brokerportal.anthem.com/apps/ptb/login?site=fullsite&brand=ABC` — Anthem's **Producer Toolbox**. Note: `anthem.com/ca/producer` is a marketing page with no username field |
| **Where the work happens** | `https://elevancehealthfulcrum.my.site.com/broker/...` — Anthem's Salesforce/Vlocity "Small Group Quote & Enroll" platform. Producer Toolbox is only the launcher now; `Create Quote` opens a **new tab on this other host** |
| **Sandbox** | **There isn't one.** Everything below runs against production |

## 2. Credentials — not in this document

Five values are needed and **none of them belong in a repo, a Slack message or a
doc**. They are a real licensed producer's identity plus portal credentials:

```
ANTHEM_PORTAL_USERNAME
ANTHEM_PORTAL_PASSWORD
ANTHEM_PRODUCER_FIRST_NAME
ANTHEM_PRODUCER_LAST_NAME
ANTHEM_PAID_AGENCY_CODE      # also the agency's encrypted TIN
```

Get them from the **Benefits runbook / 1Password**, and put them in `.env`
(gitignored). `cp .env.example .env` gives you the shape — config files carry
only the variable *names*, never values. See [../sanitization.md](../sanitization.md).

If someone sends you these over chat or email, that's a problem worth raising
rather than a shortcut worth taking.

## 3. MFA

Anthem emails a one-time code. The automation reads it out of the mailbox label
it lands in, so you need that mailbox reachable. **`mfa.provider` decides how** —
pick one:

**`imap` — easiest, and what to use to get going.** No browser, so it works
headless and on Linux. Put two values in `.env`:

```
MFA_IMAP_USER=
MFA_IMAP_APP_PASSWORD=      # a Google APP password, not the mailbox password
```

Google stopped accepting plain mailbox passwords for IMAP. An app password needs
2-Step Verification on the account, and a Workspace admin can disable app
passwords — so if `connect` fails, that's the first thing to check.

Be aware of what you are handing over: an IMAP credential can select **any**
folder, so its reach is the whole mailbox, not just the label. The provider only
ever opens the configured label and a test pins that, but the credential itself
cannot be scoped. Trade-off written up in [../mfa-gmail.md](../mfa-gmail.md).

**`gmail-profile`** — a persistent browser profile a human signs in to once.
Needs a display, expires, and depends on Gmail's markup:

```bash
pnpm rpa mfa seed-profile --account <email>     # one-time human sign-in
```

**`gmail-api`** — the production target. Needs a Google Cloud project and a
refresh token, and has not been validated against a real mailbox yet.

Whichever you pick:

```bash
pnpm rpa mfa check --label "Access Token (Anthem)" --days 1
```

**Run this before a run, not after it fails.** It reports which senders are in
the label and how many carry a six-digit code, which is how you set
`mfaSenderAllowList` from evidence instead of guessing.

One thing worth knowing: the code is sent to `carrierops@gusto.com` and
**forwarded** to the mailbox we read, which is why that address shows up as a
*sender*. A session is saved to `data/sessions/anthem-ca.json` and reused, so
most runs spend no code at all — look for `signedInVia: "reused"` in the log.

## 4. Test data

All synthetic and already in the repo — nothing to request. Everything lives
under `automations/group-submission/anthem-ca-new-plans/data/`:

| File | Repo path | What's in it |
|---|---|---|
| **Payload** | [`data/seed/queue.json`](../../../automations/group-submission/anthem-ca-new-plans/data/seed/queue.json) | The queue item: group `The Company LLC 7`, FEIN `881234573`, one owner at 100%, 4 medical plans, contribution and waiting-period rules |
| **Census** | [`data/input/census-sample.csv`](../../../automations/group-submission/anthem-ca-new-plans/data/input/census-sample.csv) | 3 people, 1 waiving medical. SSNs use the `000-` prefix, which is never issued, so they are invalid by construction |
| **Template** | [`data/input/anthem-census-template.xlsx`](../../../automations/group-submission/anthem-ca-new-plans/data/input/anthem-census-template.xlsx) | Anthem's own downloaded workbook. The automation fills **this**, rather than building a file from scratch, because a malformed upload "succeeds" and renders an empty grid |

Direct links, for pasting into a message:

```
https://github.com/Gusto/bentech-rpa/blob/main/automations/group-submission/anthem-ca-new-plans/data/seed/queue.json
https://github.com/Gusto/bentech-rpa/blob/main/automations/group-submission/anthem-ca-new-plans/data/input/census-sample.csv
https://github.com/Gusto/bentech-rpa/blob/main/automations/group-submission/anthem-ca-new-plans/data/input/anthem-census-template.xlsx
```

The census is read once per transaction and split into **enrolling** and
**waiving** people — the template writer wants the enrolling ones, the
eligibility screen wants the waiving ones. Two readers would eventually disagree
about who is enrolling, which is the one thing that must not happen.

**Never add a real group here.** Carry references, not records.

Two payload fields go stale and will fail in ways that look like broken code:

- **Contract codes** (`8VAY 8VAN 8V5C 8V63`) — Anthem rotates these by plan
  year. When stage 5 raises *"contract code not offered"*, re-read the live plan
  list rather than assuming the automation is broken.
- **`companyName` / `fein`** — see the warning about re-runs below.

## 5. Setup

```bash
git clone git@github.com:Gusto/bentech-rpa.git
cd bentech-rpa
pnpm install
pnpm exec playwright install chromium      # macOS; add --with-deps on Linux
cp .env.example .env                       # then fill it from 1Password

pnpm rpa doctor                            # will this machine actually run one
pnpm check                                 # typecheck + validate + 357 tests
```

Node 24, pinned in `.nvmrc` / `mise.toml`.

## 6. Run it

```bash
pnpm rpa mfa check --label "Access Token (Anthem)" --days 1   # first
pnpm rpa queue group-submission/anthem-ca-new-plans --reset
pnpm rpa run group-submission/anthem-ca-new-plans
```

Chromium opens on screen — `.env` sets `HEADLESS=false` because **Anthem serves
`Access Denied` to headless Chromium**. `LOG_PRETTY=true` gives readable logs.

Takes 8–10 minutes. Evidence lands in `artifacts/<runId>/`: the member-rated
quote PDF, the filled census, the signed application, and
`anthem-document-checklist.json`.

### What a good run looks like

With `allowSubmit: false` (the default) it drives ~80 steps and stops on
`Attestation` with a `BusinessException`. **That exception is the success
condition** — it means every editable screen was filled and the automation
parked itself before anything irreversible.

With `allowSubmit: true` it continues through the signature to `Document
Checklist`. Verified run `20260903T215139Z-1d3674`:

```
94 steps · 9m51s
processed: 1   success: 1   business: 0   system: 0   retries: 0
```

---

## Warnings

### ⛔ Production is frozen — login and navigation only (from 2026-09-04)

Mapping this PoC left seven signed applications, orphan quotes and duplicate
accounts on Anthem production. Until the Benefits team confirms those are
cleared, **do not run the automation against production at all** — not even with
`allowSubmit: false`, because that still creates a real account and a real quote
before it stops.

Permitted, and enough to verify a machine works:

```bash
pnpm tsx tooling/scripts/check-portal-access.ts       # can we load the login page
pnpm tsx tooling/scripts/check-portal-navigation.ts   # can we sign in and navigate
```

See [production-cleanup.md](production-cleanup.md) and rule 10a in
[`AGENTS.md`](../../../AGENTS.md). Everything below applies once the freeze lifts.

### ⚠ `allowSubmit: true` signs and files a real application

There is no sandbox. `true` means the automation **locks, signs and files a real
group application** under a real producer's licence, and Anthem may act on it.
The group being synthetic does not make the filing synthetic.

It defaults to `false` in all three environments and flipping it is a deliberate
act — get sign-off, and **revert it afterwards**. Six applications were filed
this way on 2026-09-03 while mapping the last steps (`The Company LLC` through
`The Company LLC 6`); they may still need clearing on Anthem's side.

### ⚠ A full run can only be done once per group

Anthem refuses a second application for a group that already has one in
progress — it redirects to an "Application Matching Error" page whose only
control is `Exit`. The automation reports this as a `BusinessException` naming
the existing application.

So **before each `allowSubmit: true` run, bump `companyName` and `fein`** in the
seed (`The Company LLC 8`, `881234574`, …). At the default `false` nothing is
filed, so you can re-run the same group as often as you like.

### ⚠ Orphaned browsers break the *next* run

A run that aborts can leave Chromium holding the persistent profile, and every
later run then fails for that reason instead of its real one — 20 accumulated at
one point. Clear them:

```bash
ps -Ao pid=,command= | grep "user-data-dir=.*data/profiles" | grep -v grep \
  | awk '{print $1}' | xargs -r kill
```

### ⚠ `data/sessions/` and `data/profiles/` are credential-equivalent

A saved session is a signed-in identity. Never print, copy, commit or share
them. Both are gitignored.

### ⚠ The recording is internal-only

`anthem-ca-end-to-end.mp4` shows the production portal, the agency identity, an
encrypted TIN and a signed legal document. **Approved internal Slack workspace
only** — not Slack Connect, not an external channel, not a personal drive. It is
gitignored and deliberately not committed.

### ⚠ Headless is not an option for Anthem

Anthem serves `Access Denied` to headless Chromium — a 403 with an Akamai
reference — and loads normally headed. `.env` sets `HEADLESS=false` for that
reason, and on a laptop that just works.

**In the container it also works now:** the image installs `xvfb` and the
entrypoint starts a virtual display when `HEADLESS=false` and no `DISPLAY` is
set, so this runs on a server with no screen:

```bash
HEADLESS=false docker compose run --rm rpa group-submission/anthem-ca-new-plans
```

Before trusting a new runtime, prove the carrier accepts it — `rpa doctor` only
proves Chromium starts:

```bash
docker compose run --rm -e HEADLESS=false \
  --entrypoint tooling/docker/with-display.sh rpa \
  pnpm tsx tooling/scripts/check-portal-access.ts
```

Note that headed costs more CPU and memory than headless, and this has not been
load tested with concurrent runs.

---

## When it breaks

It will, and the design assumes it. A failed gate writes **both** a screenshot
and a DOM dump carrying the portal's own validation message:

```bash
cat artifacts/$(ls -t artifacts | head -1)/*-postcondition.json
```

That file is the fastest route to the cause — it names the step, the gate, the
portal's wording and which wizard step the rail thinks it is on. Two of the six
runs failed there, and both times this identified the cause in under a minute.

**Business vs System is the contract to understand first.** A `BusinessException`
is bad data: reported, never retried. Anything else is treated as environmental:
screenshot, trace, browser relaunch, same item retried. If you add code, the
test is *"would running this again on a fresh browser plausibly give a different
answer?"* Yes → System. No → Business.

## Where to read next

| Doc | What it covers |
|---|---|
| [`AGENTS.md`](../../../AGENTS.md) | The rules that matter, and a gotchas table that will save you hours |
| [`drift-log.md`](drift-log.md) | Every way the live portal differs from the runbook — ~90 entries. Read this before believing any runbook |
| [`process-steps.md`](process-steps.md) | The real 14-step wizard, screen by screen |
| [`documents.md`](documents.md) | The `Document Checklist` step and its 23 slots |
| [`open-questions.md`](open-questions.md) | What is still unanswered |
| [automation README](../../../automations/group-submission/anthem-ca-new-plans/README.md) | Per-stage status and the measured runs |

If a locator fails, **check `drift-log.md` before debugging.** The portal moved
platform mid-PoC and most surprises are already written down there.
