# Reading the MFA code from Gmail

Both carrier portals require MFA. The code arrives as email. This is how the
automation gets it, why it is done this way, and what the trade-offs are.

## The constraint

The Gmail account has a password, but its **own** 2FA seed lives in 1Password,
which phase 1 does not integrate with. So the automation cannot log into Gmail
itself.

**That does not rule out the Gmail API**, and this is worth being clear about
because it looks like it should. OAuth consent is a *one-time* interactive
browser login: a human signs in once, using 1Password once, and the result is a
refresh token that works headless forever with no OTP. Seeding a browser profile
costs exactly the same single interactive login.

So the two options cost the same to set up. The real gating factor is whether
you can create a Google Cloud OAuth client, which may need an IT ticket — not
the OTP.

**Decision: build both, behind one interface.** The profile provider unblocks the
PoC today with no IT dependency; the API provider is the production target and a
config line later.

## The interface

`packages/core/src/mfa/MfaCodeProvider.ts`

```ts
waitForCode({ since, timeoutMs, matcher, purpose }): Promise<string>
```

| Provider | Role | Status |
|---|---|---|
| `GmailUiMfaProvider` | PoC: reads the Gmail **web UI** from a dedicated signed-in profile (`gmail-profile`) or an attached browser (`gmail-cdp`) | built — not yet validated against a real mailbox |
| `GmailApiMfaProvider` | Production: Gmail API + refresh token | built — unit-tested against a mocked fetch only |
| `ManualMfaProvider` | Fallback: prompts on stdin, refuses without a TTY | built |
| `StaticMfaProvider` | Tests | built |

### `since` is the whole point

Only a code that arrived **after** `since` is accepted, and callers set it
immediately **before** submitting the password.

Without that watermark a retry cheerfully re-reads the previous attempt's code
and submits it to a portal that already invalidated it — which looks exactly like
a portal fault and is not one. Set it too early and you may accept a stale code;
set it after triggering the login and you race the email. Immediately before.

Implementations must also **consume** the message they read — mark it read, or
move it — so a retry cannot pick up the same code twice.

## Mail access is deliberately narrow

Each carrier gets its **own** label, so one carrier's mail can never satisfy the
other's login:

| Automation | Mailbox | Label | Sender |
|---|---|---|---|
| `group-submission/anthem-ca-new-plans` | **`carrierops@gusto.com`** | `Access Token (Anthem)` | `noreply@broker.anthem.com` |
| `group-submission/uhc-np-new-plans` | `benefitsoperations@gusto.com` | `Access Token (UnitedHealthcare)` | `txt.voice.google.com` (SMS→email), `carrierops@gusto.com` |

### The two carriers use different mailboxes — and one of them we cannot read

Anthem's MFA screen states it plainly: *"We sent a one-time code to your email
at c\*\*\*s@gusto.com"* — that is `carrierops@gusto.com`, not
`benefitsoperations`. Reading benefitsoperations meant reading the far end of a
**forward**, and its latency (measured at ~132s up to over 600s) regularly
exceeded the code's own expiry countdown. A code that arrives expired is no
better than one that never arrives, which is why a longer `mfaTimeoutMs` was the
wrong lever.

**We have no access to `carrierops@gusto.com`**, so reading the source mailbox
is not available. The automation therefore reads the forwarded copy in
`benefitsoperations` and compensates for the latency by resending rather than
waiting:

```json
"mfaResendAfterMs": 150000,
"mfaMaxResends": 2
```

`resendMfaCode` clicks the portal's own "Resend Code" link, and the watermark is
**reset on every send**. That last detail is the whole correctness argument:
keeping the original watermark across a resend would accept the first code —
precisely the one already known to be too old to use.

Anthem's allow-list keeps both `broker.anthem.com` and `carrierops@gusto.com`,
because the forward sometimes preserves Anthem's `From` and sometimes rewrites
it to the forwarder, and we only ever see the far end.

The mechanism is still there for a per-automation mailbox, should access change:
an automation's `config.<env>.json` is layer 4 and merges over the platform
defaults, so it can override the whole `mfa` block, and the CLI reads the same
effective config with `--automation <id>`.

**The clean fix, when someone can authorise it:** change the registered address
on the Anthem account (Producer Toolbox → Licensing → Account Details) to
`benefitsoperations@gusto.com`. That removes the forwarding hop, and with it the
race against the code's expiry. It changes where a human operator's codes go
too, so it needs the Benefits team's agreement rather than a unilateral edit.

Both allow-lists were set from measurement, not assumption — see
`rpa mfa check` below. The previous UHC value (`uhc.com`, `uhcprovider.com`)
matched **nothing**: UHC texts the code and Google Voice forwards it, so no
UHC-domain sender ever appears. `carrierops@gusto.com` is an internal
forwarder; trusting it is a deliberate, recorded decision, and it is a weaker
control than a carrier domain because anything able to send as that address
could inject a code.

They are configured per automation in `config/config.<env>.json` as `mfaLabel`,
not platform-wide. A label containing spaces is quoted in the search query
(`label:"Access Token (Anthem)"`).

A Gmail filter routes carrier MFA mail into its label:

```
Matches:  from:(anthem.com OR uhc.com) subject:(code OR verification)
Do this:  Apply label "carrier-mfa", Skip Inbox
```

The provider queries **only** that label, checks the sender against an
allow-list, and only ever marks messages read. It never lists the inbox, never
searches the wider mailbox, and never deletes.

That containment is the control that matters: if the browser profile is
compromised, the blast radius is one label of six-digit codes rather than the
whole mailbox. The sender allow-list is the second control — it is what stops a
spoofed "your code is 000000" message sitting in the same label from being used.

## Option A — persistent Chromium profile (PoC)

```
data/profiles/gmail-mfa/     <- created by a one-time human login
```

One-time setup, once per machine:

```bash
pnpm rpa mfa seed-profile          # opens headed Chromium; you sign in by hand
pnpm rpa mfa check --label carrier-mfa
```

`seed-profile` opens Chromium on that profile at the basic HTML view, waits for
you to sign in (1Password here, once), then verifies you are actually signed in
before it exits. It refuses to run without a TTY, because there would be nobody
to sign in. From then on the provider opens Gmail in the same profile and is
already authenticated.

`check` is the one to run **before** a scheduled run, not after it fails. It
goes through the provider's own page object, so a pass means something, and it
reports metadata only: how many messages, the **distinct sender addresses**, and
the newest date. Never a subject, a body or a code.

The sender list is the point. `mfaSenderAllowList` is a security control — it is
what stops a spoofed "your code is 000000" in the same label from being used —
and a wrong value rejects every real code. `check` is how you set it from
evidence instead of guessing:

```bash
pnpm rpa mfa check --label "Access Token (Anthem)" --days 30
```

Its query is deliberately *broader* than the runtime one (no `is:unread`, a
multi-day window) so it can see codes that have already been used. It stays
label-scoped: the containment control is never relaxed, not even for a
diagnostic.

### ⚠ The basic HTML view no longer exists

This section originally specified Gmail's **basic HTML view**
(`https://mail.google.com/mail/u/0/h/`) — plain markup, no JS app — and
explicitly ruled out scraping the modern interface as too brittle.

**Google retired that view in January 2024.** The URL is gone. So the option
this design picked is unavailable, and only two remain: the Gmail API, or
scraping the modern interface after all.

`GmailUiMfaProvider` does the latter, under protest. Two things make it
survivable rather than merely brittle:

- **Attribute hooks over class names** where Gmail offers one. A row's thread id
  and `span[email]` are part of its data model; `div.a3s` is styling and will
  break.
- **Failing closed.** Markup we do not recognise yields *no* messages, so the
  poll times out as a System exception. It never yields a wrong code. Likewise a
  row whose date cannot be read counts as stale, because rejecting a real code
  costs one retry while accepting an undated one submits a code the portal has
  already invalidated.

It also reads the code from the list *snippet* when it can, and only opens a
message when it must — opening is what marks mail read in Gmail, and consuming
something we then reject is how a code goes missing.

### ⚠ And the everyday Chrome profile cannot be attached to

The obvious shortcut — attach over the DevTools protocol to the Chrome a human
is already signed into, storing no credential at all — does not work.
**Chrome 136+ silently ignores `--remote-debugging-port` unless it is paired
with a non-default `--user-data-dir`.** Google added that restriction precisely
to stop software attaching to a real profile and lifting its cookies and
session state.

Copying the profile does not work either: on macOS Chrome encrypts its cookies
against a Keychain entry that Playwright's Chromium cannot read, so a copy
arrives signed out.

Which leaves a **dedicated** profile that a human signs into once — the
`gmail-profile` mode below. `gmail-cdp` still exists for the case where an
operator already keeps such a browser running, but since a human signs in
either way it buys nothing over `gmail-profile`.

### The two facts to be honest about

- **`data/profiles/gmail-mfa/` holds a live Google session.** It is
  credential-equivalent. Anyone with filesystem access to it has the mailbox.
  Gitignored, and acceptable on a developer machine for a PoC — **not**
  acceptable on a shared or headless server.
- **It expires.** Google sessions last weeks, and re-seeding needs a display. So
  this is explicitly a bridge with a shelf life, not something to build a
  production schedule on.

Both `data/profiles/` and `data/sessions/` are credential-equivalent and already
gitignored. Do not commit them, do not copy them off the machine, and do not
print their contents — the storageState files under `data/sessions/` are live
carrier portal cookies, and the code writes them `0600` for that reason.

## Option B — Gmail API (production target)

Scopes: `gmail.readonly` and `gmail.modify` (modify is needed only to drop the
`UNREAD` label so a code cannot be reused).

```
q = label:carrier-mfa is:unread newer_than:1h from:anthem.com
-> users.messages.list -> get -> extract -> messages.modify (remove UNREAD)
```

`.env`: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`,
`GMAIL_MFA_LABEL`.

No OTP at runtime, no session expiry, headless-safe, and every access is
auditable in Cloud logging. This is where both PoCs should end up.

Implemented with bare `fetch`, not `googleapis`: that package is very large for
three endpoints, and a transitive native dependency is exactly the
arm64 -> amd64 hazard this repo avoids. Token handling mirrors
`OrchestratorClient` - single-flight acquisition so N concurrent callers make
one token request, expiry skew baked in at store time, and an injected `fetch`
and clock for tests.

## Choosing a provider

One line of environment config, never a code change:

```json
{ "mfa": { "provider": "gmail-api" } }
```

`manual` is the default, deliberately: it needs a TTY, so a misconfigured
unattended run stops and asks rather than silently reaching into a mailbox. The
block lives in `config/platform.json` and is typed by `mfaConfigSchema`; an
environment overrides it in `config/environments/<env>.json`. It holds env-var
*names* only — `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` —
and the values come from `ctx.secrets.require`.

## What is not verified yet

The Gmail API shapes are covered by unit tests against a mocked `fetch`;
nothing in the suite touches the network or a real mailbox. The parts that
depend on what Google actually serves are marked `TODO(gmail):` in
`packages/core/src/mfa/`, and `grep -rn "TODO(gmail)" packages/` is the punch
list:

| Marker | What to confirm |
|---|---|
| `GmailApiMfaProvider.buildQuery` | How a label containing spaces must be written — `label:"carrier mfa"` (used here) versus Gmail's hyphenated form |
| `GmailApiMfaProvider.extractBodyText` | The part layout carriers really send. text/plain is preferred, tag-stripped text/html is the fallback, `snippet` is the last resort |
| `PlaywrightGmailUiPage.listSearch` | Every row selector: thread id, `span[email]`, subject, the `title` date and the snippet |
| `PlaywrightGmailUiPage.readBody` | `div.a3s` as the message body container — class-based, so the most fragile of them |
| `PlaywrightGmailUiPage.markRead` | That opening a thread really does clear `UNREAD` |

`pnpm rpa mfa check --label <name>` settles the profile-provider markers against
a real mailbox. Until someone has run it, say "unit-tested, not yet validated
against a real mailbox".

## What was rejected, and why

| Approach | Why not |
|---|---|
| Automate the Gmail **login** with Playwright | Needs the mailbox password *and* the very OTP that is unavailable |
| Scrape the modern Gmail JS UI | Brittle by construction; fights Google's own bot detection |
| IMAP with an app password | **Reversed on 2026-09-04 — see below.** The objection stands (long-lived credential, whole-mailbox reach, weaker audit trail) but the alternatives were blocking the PoCs |

## Failure modes and their classification

| Failure | Class | Why |
|---|---|---|
| No code within `mfaTimeoutMs` | **System** | Mail was late. A retry with a fresh login trigger can work |
| Code arrived but the portal rejected it | **System** | Usually a stale code — check the `since` watermark first |
| Gmail profile session expired | **System** | Needs a human to re-seed; fails loudly rather than hanging |
| Gmail changed its markup | **System** | No rows parsed, so the poll times out. Fails closed — it never returns a wrong code |
| Portal says "too many attempts" / account locked | **Business** | Retrying makes it worse. A human must intervene |
| Refresh token revoked or expired (`invalid_grant`) | **System** | Our mailbox credentials rotted. Failing the queue item would blame the group for it |
| Message found but its date could not be parsed | **System** | Treated as stale and rejected. Failing closed costs a retry; accepting an undated code risks submitting one the portal already invalidated |
| Code requested but slow to arrive | **System** | Measured on Anthem: ~132s, then >180s, then >300s across consecutive requests, and **every code did arrive**. Latency escalates when codes are requested repeatedly — carrier throttling. A tight timeout discards a code already in flight and then asks for another, which makes it worse. `mfaTimeoutMs` is 600000 for Anthem, paid once per session |

## Why session reuse is the whole game

The measured throttling above is the argument for it. `session.recover()` re-runs
`initialize()`, which probes the stored `storageState` — and when the probe
passes, **no code is consumed**. Recovery is therefore free, where a design that
re-authenticated per transaction would request a code per group, get throttled,
and then time out. Note the runner wraps only `processTransaction` in
`transactionTimeoutMs`; recovery and `initialize()` sit outside it, so a long
MFA wait during recovery cannot trip a transaction timeout.

Codes are never logged — not the value, not its length.

## Proving it works: `rpa mfa probe`

```bash
pnpm rpa mfa probe --label "Access Token (Anthem)" --from "broker.anthem.com,carrierops@gusto.com"
```

Runs the real provider against the real mailbox and reports only *whether* a
code could be read, plus whether its shape matches `codePattern`. Never the
code. It **consumes** a message on success, deliberately, because the
marked-read path is half of what needs proving.

### Historical mail cannot be probed

The runtime query is `is:unread`, which is exactly what stops a retry reusing a
code. Both labels' existing mail has already been read by a human, so a probe
against history finds nothing — correctly. `probe` says so explicitly rather
than leaving "no code arrived":

```
  Why there was nothing to read
    messages in the window : 21
    of those, unread       : 0
```

So the last mile — reading a genuinely fresh code — can only be proven by
triggering a real carrier login. Everything before it is verified against the
live mailbox: label search, sender extraction, date parsing, mailbox identity
and query construction.

## The `imap` provider (added 2026-09-04, interim)

This page rejected IMAP, and the reasoning was sound. It is implemented anyway,
deliberately, as an **interim unblock** — and this section exists so the
trade-off is recorded rather than reversed quietly.

### Why it was added

The two providers that worked without a Cloud project both drive Gmail's own JS
UI, and that cost this project a string of failures — all written up in
[`anthem-ca-new-plans/drift-log.md`](anthem-ca-new-plans/drift-log.md):

- a `goto()` differing only in its `#fragment` is a same-document navigation, so
  106 polls re-read a cached list and a code that arrived in 26s went unseen;
- row dates read `6:38 PM` with no seconds, so a code arriving in the same
  minute it was requested was rejected as stale;
- rows carry no stable id — the `id` attribute is reassigned on every re-render;
- Gmail's basic HTML view, which the original design specified, was retired in
  January 2024.

They also need a display, so they cannot run on the Linux runtime at all.
`gmail-api` remains the production answer and is still unvalidated against a
real mailbox. IMAP is neither of those things: no browser, no markup, works
headless, and stands up in an afternoon.

### What the trade-off actually is

| | `gmail-api` | `imap` |
|---|---|---|
| Credential reach | scoped token: `gmail.readonly` + `gmail.modify` | **the whole mailbox** — IMAP can `SELECT` any folder |
| Revocation | revoke the refresh token | rotate the app password |
| Audit trail | per-request, in the Cloud project | mailbox-level only |
| Setup | a Google Cloud project and OAuth consent | an app password |
| Runs headless | yes | yes |

The reach is the real cost, and it is worse for a **shared** Benefits Operations
mailbox — which carries customer correspondence — than for a dedicated one. The
credential cannot be scoped to a label, so the **code** is what keeps the
containment control the design intends:

`ImapMfaProvider` opens exactly one mailbox, `request.matcher.label`. It never
selects `INBOX`, never `[Gmail]/All Mail`, and never issues a mailbox-wide
search. A test pins that, because it is the only thing standing where a scoped
token would otherwise be.

### Two things that can block it outright

- **Google removed plain-password IMAP.** `MFA_IMAP_APP_PASSWORD` must be an
  **app password**, which requires 2-Step Verification on the account — and a
  Workspace admin can disable app passwords for the whole org. Use
  `MFA_IMAP_ACCESS_TOKEN` for XOAUTH2 instead; set exactly one, enforced at
  startup by the config schema.
- **IMAP can be turned off org-wide** in Google Admin. Confirm before debugging
  a connection failure — the provider's error message names all three causes.

### What it improves on the Gmail UI providers

In Gmail a **label is the mailbox path**, so `SELECT "Access Token (Anthem)"`
preserves label scoping exactly. And `receivedAt` comes from **INTERNALDATE**,
the time the server received the mail — real second precision, which *fixes* the
minute-precision problem rather than working around it, and which a sender
cannot influence the way it can the `Date:` header.

Note that IMAP's `SEARCH SINCE` takes a **date**, not a timestamp — there is no
way to say "since 14:32:05" in the protocol. So it is only a coarse server-side
floor, and the authoritative freshness check stays exactly where it was:
`selectCode` comparing `receivedAt` against `request.since`.

### Configuration

```jsonc
"mfa": {
  "provider": "imap",
  "imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "secure": true,
    "userEnv": "MFA_IMAP_USER",
    "passwordEnv": "MFA_IMAP_APP_PASSWORD"
  }
}
```

`rpa mfa check --label "<label>" --days 1` works for this provider too, and runs
the provider's own `search()` so it cannot drift from what a run sees. It reports
counts, senders and the newest date — never a subject, a body or a code.

### When to remove it

When `gmail-api` has been validated against the real mailbox. This is a bridge,
and the row in the rejection table above is still the long-term view.
