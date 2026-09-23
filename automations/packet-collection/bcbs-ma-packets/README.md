# BCBS MA Packet Collection

Migrated from the UiPath process `BCBS_MA_PacketCollection`. Logs into the BCBS
MA broker portal, finds a group's renewal quote, and downloads the BQR Renewal
Notice PDF - the same packet the original bot pulled, ported to Playwright +
TypeScript as a first migration proof of concept.

| | |
|---|---|
| **Id** | `packet-collection/bcbs-ma-packets` |
| **Domain** | `packet-collection` |
| **Owner** | @Gusto-Dio |
| **Session** | browser (Chromium, two tabs - see below) |
| **Queue** | `BCBS_MA_Packets` (matches the UiPath Orchestrator queue name on purpose - see `automation.json`'s validate warning) |

## Run it

```bash
pnpm rpa run packet-collection/bcbs-ma-packets                 # headless, as the server does
HEADLESS=false pnpm rpa run packet-collection/bcbs-ma-packets  # watch it, on a dev machine
pnpm rpa queue packet-collection/bcbs-ma-packets --reset       # re-seed the synthetic queue
```

## Two tabs, not one

Signing in lands on the broker portal (`ctx.page`). The BlueQuote app - where
Renewals, the group search, and the actual documents live - opens in a
**second tab**, via a Salesforce SSO hand-off (`frontdoor.jsp` with a live
session token in the URL; a hardcoded URL has no token and never resolves).
`initialize()` stores that second page in `ctx.state.get('quotePage')`;
`processTransaction()` reads it from there. `ctx.page` itself is never used
past `initialize()`.

## Validating that an element is actually ready, not just visible

Two live-portal failures this migration hit, and the fix both times:

1. **A visible element that has not finished the check.** After clicking the
   Renewals tab, the search box paints before the list view's controller has
   wired its keyboard handlers. It is fully `isVisible()` and fillable by
   Playwright's own standard - typing into it that early leaves the value on
   screen but never filters the list. Fixed by waiting on a **data signal**,
   not a landmark: `openRenewals()` polls for a real row inside the
   `role="grid"` (not a plain `<table>` - this portal's Lightning grid has no
   table role at all) before returning.
2. **A locator that matches more than one element.** This portal keeps a
   previous screen's DOM mounted-but-hidden instead of removing it, so several
   "single" controls (the search box, the Home landmark, a document link)
   resolve to two matches. `Locator.isVisible()` throws on a multi-match
   locator (strict mode) - a bare `.catch(() => false)` silently turns that
   into "not found", which read a **successful** login as a failed one the
   first time it happened. The fix, `#firstVisible()` in both page objects,
   counts matches and returns the first one that is actually visible, polling
   until a timeout rather than counting once (a `.count()` taken right after a
   click is a snapshot, not an auto-waiting query).

The rule this leaves behind: **wait for evidence that the thing you need is
ready, not for a fixed number of seconds, and not just for `isVisible()` on an
unscoped locator.** A fixed `waitForTimeout` is a guess about how long
something takes; it is either wasted time when the guess is generous, or a
flaky failure when it is not, and either way it teaches you nothing when the
timing changes.

## Preflight - check the chain before running the real thing

`scripts/preflight.ts` walks the same chain read-only, using these same page
objects, and stops at the first step that does not behave as expected -
before any real transaction starts:

```bash
pnpm exec tsx automations/packet-collection/bcbs-ma-packets/scripts/preflight.ts
pnpm exec tsx automations/packet-collection/bcbs-ma-packets/scripts/preflight.ts --group "Some Group Name"
```

Without `--group`, it only checks the part that does not depend on any one
group: sign-in, BlueQuote, and the Renewals grid rendering real rows - useful
as a "is the portal itself still reachable" health check. With `--group`, it
also drives the search, account, and Quotes tab for that group, stopping
before the download (there is no reason to pull a real file just to prove the
chain is reachable). It is not `rpa sentinel`: sentinel compares a DOM
fingerprint against a committed baseline and can file a healing task; this has
no baseline, and only answers "is the chain reachable right now" for this one
automation.

## Credentials

Set the variables named in `config/config.dev.json` (`usernameEnv`,
`passwordEnv`) in your `.env`. The config file holds only the *names*; values
are resolved through `ctx.secrets` at runtime.

## Where things live

- `src/pages/` - every selector, and nowhere else.
- `src/payload.ts` - the queue item shape. Invalid payload -> `BusinessException`.
- `src/config.ts` - this automation's settings schema.
- `data/seed/queue.json` - synthetic transactions. **Never real member or group data.**

## Business vs System

- Rule violated, data rejected, record ineligible -> `throw new BusinessException(...)`. No retry.
- Portal down, timeout, unexpected page -> let it throw, or `throw new SystemException(...)`.
  The framework screenshots, traces, recovers the session and retries.
