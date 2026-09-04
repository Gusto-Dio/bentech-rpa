# PROMPT 00 — Shared foundations (do this before either PoC)

Paste this into a fresh Claude Code session with this repo open.

---

You are a **senior RPA developer**. You are building the shared foundations that
two carrier-portal automations depend on. Both PoCs are blocked until this is
done, and if it were built twice it would be built two different ways — which is
why it is one task.

Read first, in this order:

1. `AGENTS.md` — the repo's rules. They are not optional.
2. `docs/poc/README.md` — what the two PoCs are.
3. `docs/poc/mfa-gmail.md` — the MFA design and its trade-offs.
4. `packages/core/src/steps.ts` — already built; read it, you will rely on it.

## What already exists

| Built | Where |
|---|---|
| `step()` — precondition → action → postcondition | `packages/core/src/steps.ts` |
| `MfaCodeProvider` interface, `MfaMatcher`, `extractMfaCode`, `isAllowedSender` | `packages/core/src/mfa/MfaCodeProvider.ts` |
| `ManualMfaProvider` (stdin, TTY-guarded), `StaticMfaProvider` (tests) | `packages/core/src/mfa/` |
| `CarrierPortalSession` contract | `automations/group-submission/_shared/src/carrier-portal-session.ts` |

Do not redesign these. Read the contracts and implement against them.

## Your three deliverables

### 1. `GmailProfileMfaProvider`

`packages/core/src/mfa/GmailProfileMfaProvider.ts`

Reads the MFA code from a persistent Chromium profile in which a human has
already signed into Gmail once.

- `chromium.launchPersistentContext(userDataDir)`, a **separate** profile from
  any carrier session.
- Read from Gmail's **basic HTML view** (`https://mail.google.com/mail/u/0/h/`).
  Do not scrape the modern JS interface — it is brittle and it fights Google's
  bot detection.
- Query **only** the configured label. Never list the inbox, never search the
  wider mailbox, never delete.
- Check the sender against `matcher.fromAllowList` before accepting a code.
  A message in the right label from the wrong sender is not a code.
- Only accept messages newer than `request.since`.
- **Mark the message read** once the code is extracted, so a retry cannot reuse it.
- Poll until `timeoutMs`, then throw a `SystemException` saying the code never
  arrived. Mail being late is a System failure, not a Business one.
- If the profile turns out not to be signed in, throw a `SystemException` that
  says exactly that and names the one-time setup step. Do not attempt to log in.

Also write a small CLI or documented command for the **one-time profile seeding**,
so the next person does not have to work out how to create it.

### 2. `GmailApiMfaProvider`

`packages/core/src/mfa/GmailApiMfaProvider.ts`

Same contract, via the Gmail REST API with a refresh token from `.env`
(`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`).

- Use `fetch`. Do **not** add `googleapis` — it is a very large dependency for
  three endpoints, and this repo keeps its dependency surface small on purpose.
- Exchange the refresh token for an access token; cache it and re-request on
  expiry. `OrchestratorClient` already solves exactly this problem
  (single-flight token acquisition, expiry skew) — read it and follow the same
  shape rather than inventing a second one.
- `users.messages.list` with `q=label:<label> is:unread newer_than:1h from:<sender>`,
  then `get`, then `modify` to remove `UNREAD`.
- Same watermark, allow-list and consumption rules as above.

### 3. `createCarrierPortalSession`

`automations/group-submission/_shared/src/carrier-portal-session.ts` — the
contract is written, the implementation throws. Implement it.

```
1. If a stored storageState exists, load it and PROBE whether it still works.
2. If the probe passes: done. No login, no MFA, no code consumed.
3. Otherwise: sign in, satisfy MFA, persist the new storageState.
```

Four things that are easy to get wrong, all of which matter:

- **Set the MFA watermark immediately before submitting the password.** Not
  after (you race the email), not at the start of the function (you may accept a
  stale code).
- **Probe with a signed-in-only page, not by checking for cookies.** Carrier
  sessions expire server-side while the cookie is still present, so "cookies
  exist" is not "we are signed in". This is the single most common way session
  reuse silently breaks.
- **Never log** the code, the password, or the storageState contents.
- **Classify correctly:** a missing code and a rejected password are both
  **System** (the environment is wrong). "Too many attempts" or account lockout
  is **Business** — retrying makes it worse and a human must intervene.

## How to know you are done

- `pnpm check` clean — typecheck, `rpa validate`, and the full test suite.
- Unit tests for both providers with an injected fetch/page double. Nothing in
  the suite may touch the network or a real mailbox.
- Tests that specifically prove: a stale code (older than `since`) is **rejected**;
  a code from a sender outside the allow-list is **rejected**; a read message is
  **not** returned twice.
- A test proving session reuse consumes **no** MFA code when the probe passes.
- `pnpm rpa run group-submission/anthem-ca-new-plans` gets past Initialize.
  That is the signal both PoCs are unblocked.

## Rules that are not negotiable

- **No secrets in config or code.** Config holds env-var *names*;
  `ctx.secrets.require(name)` resolves values.
- **Never log a code, password, token or session blob** — not even its length.
- `data/profiles/` and `data/sessions/` are **credential-equivalent**. They are
  already gitignored. Do not copy them anywhere, do not print their contents,
  and say so in any doc you write.
- Follow the Business/System split in `AGENTS.md`. Getting it backwards here is
  expensive: a Business failure thrown as System burns three logins and three
  MFA codes per group.

## What not to do

- Do not automate the Gmail login. The OTP for it is unavailable by design.
- Do not add `googleapis`, `nodemailer`, or an IMAP client.
  **Superseded 2026-09-04 for the IMAP half only:** `imapflow` was added to
  `packages/core` as an interim unblock for the PoCs, because both
  browser-based Gmail providers need a display and cannot run on the Linux
  runtime. `googleapis` and `nodemailer` are still out - `gmail-api` uses bare
  `fetch`. The trade-off is written up in [mfa-gmail.md](mfa-gmail.md).
- Do not weaken the label scoping to "search the whole mailbox" because it is
  easier. The narrow scope is a security control.
- Do not change `step()`, the `MfaCodeProvider` interface, or the
  `CarrierPortalSession` contract without saying why. They are shared by both
  PoCs and were designed together.
