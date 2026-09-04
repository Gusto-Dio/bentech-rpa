# AGENTS.md

Guidance for AI agents working in this repository. Read this before making
changes; it encodes decisions that are easy to violate accidentally and
gotchas that have already cost real debugging time.

## What this repo is

**A proof of concept. It is not intended to go to production.** Nothing here is
approved to carry production workloads, so do not describe it as production-ready
or relax a guard on the grounds that it is "only a PoC" — the carrier portals it
drives are real production portals, which is what rule 10 is about.

An RPA platform for **unattended process automation** on Playwright +
TypeScript, reproducing the resilience contract of UiPath's REFramework. It is
built to hold **hundreds of automations** across process-type domains, sharing
one core.

Two things follow from that, and they drive almost every rule below:

1. **This is not a test framework.** It uses the `playwright` library, never
   `@playwright/test`. No test runner, no fixtures, no assertions as control
   flow. An unattended process owns its own lifecycle.
2. **It is not one automation.** Anything you add must still make sense when
   there are 100 of them owned by five teams.

Two **carrier-portal PoCs** are in progress against production Anthem CA and
UHC portals — see [docs/poc/](docs/poc/). They are the reason `step()` and the
MFA seam exist, and they carry an `allowSubmit` guard that must stay `false`.

It also integrates with an existing **UiPath Orchestrator** (queues, assets,
storage buckets) so processes can migrate incrementally. The queue backend is
chosen by environment config, so the same automation runs against a local JSON
queue in dev and Orchestrator in production without changing. Rules 11-13 below
cover that layer; [docs/orchestrator.md](docs/orchestrator.md) is the reference.

Full context: [README.md](README.md) and [docs/](docs/) (architecture,
authoring, UiPath migration, Orchestrator, operations).

## Commands

```bash
pnpm install
pnpm exec playwright install chromium     # macOS; add --with-deps on Linux

pnpm check                                # typecheck + validate + test  <- run before claiming done
pnpm typecheck                            # tsc --noEmit, strict
pnpm test                                  # node --test via tsx
pnpm rpa validate                          # manifests, import boundaries, config, loadability

pnpm rpa list                              # what automations exist
pnpm rpa doctor                            # will this machine actually run one
pnpm rpa run <domain>/<name>               # run one
pnpm rpa queue <domain>/<name> --reset     # re-seed the synthetic LOCAL queue

# MFA mailbox (carrier PoCs). Run `check` BEFORE a run, not after it fails.
pnpm rpa mfa seed-profile --account <email>    # one-time human sign-in; needs a display
pnpm rpa mfa check --label "<gmail label>" [--automation <id>] [--diagnose]
pnpm rpa mfa probe --label "<l>" --from "a,b"  # read one real code end to end (CONSUMES it)
pnpm rpa mfa chrome                            # how to start Chrome for gmail-cdp
pnpm verify:templates                      # scaffold every template, typecheck, run

# Carrier-portal reconnaissance. Maps screens WITHOUT burning an MFA code, by
# reusing the persisted session. One long-lived browser, many fast commands -
# relaunching per command costs ~60s and loses the portal's place.
pnpm tsx tooling/scripts/anthem-serve.ts &        # once; holds a signed-in browser
pnpm tsx tooling/scripts/anthem-do.ts "c Start Quote"   # attach, act, dump, detach
pnpm tsx tooling/scripts/anthem-verify-checklist.ts "<group>" "<quote>"  # read-only: checks the
                                                  # Document Checklist locators on the live screen
pkill -f anthem-serve                             # release it (orphans hold the profile)

pnpm rpa orchestrator check --env staging --automation <id>   # Orchestrator auth/scopes/folder/queue
pnpm rpa run <id> --provider orchestrator --env staging
pnpm rpa queue <id> --env staging --push-seed                 # dispatch synthetic items

docker compose run --rm rpa <domain>/<name>   # run exactly as the Ubuntu servers do
```

**Node 24, pnpm.** Pinned in `.nvmrc`, `mise.toml` and `engines`. It matches the
Playwright runtime image, so dev and production run the same version.

## Non-negotiable rules

### 1. Business vs System is the contract everything hinges on

```ts
throw new BusinessException('Plan code MED-PPO-9999 is not in the catalog');
// -> failed immediately, NEVER retried, run continues with the next item

throw new SystemException('Portal did not acknowledge the submission');
// -> screenshot + trace, browser relaunched, initialize() re-run, SAME item retried
```

Anything not a `BusinessException` is treated as a system failure, including
Playwright's `TimeoutError`. Only be explicit about the business cases.

The test: *would running this again, on a fresh browser, plausibly give a
different answer?* Yes → System. No → Business. Getting it backwards either
burns three browser relaunches per item on a rule that will never change its
mind, or silently abandons real work.

### 2. No PII, no real customer data, anywhere

Not in seed files, fixtures, examples, tests or comments. Use obviously fake
identifiers (`GRP-8842`, `MBR-000123`, `Northwind Test Bakery`).

Carry **references, not records**. The `member-submission` demo payload has
`memberRef` and nothing else — no name, DOB, SSN or wage — because validating an
election against a catalog does not need them. Follow that pattern.

### 3. No secrets in config or code

Config stores the **name** of an environment variable
(`"passwordEnv": "SAUCE_PASSWORD"`); the value comes from
`await ctx.secrets.require(name)`. That indirection is why no config file here
is sensitive, and it is the seam a real vault plugs into. `.env` is gitignored;
`.env.example` lists names only.

### 4. Import boundaries — enforced by `rpa validate`, so it will fail CI

An automation may import **only** `@rpa/core`, its **own**
`@auto/<its-domain>-shared`, `node:*`, `zod`, `playwright`, and
`@rpa/testkit` (test files only). Also: no deep imports into `@rpa/core/src/...`,
no relative import escaping the automation's own folder, and `packages/` never
imports `automations/`.

### 5. Selectors live only in `src/pages/`

Preference order: `getByRole` → `getByLabel`/`getByPlaceholder` →
`getByTestId` → CSS (page objects only). **No XPath anywhere.**

### 6. kebab-case folder names, always

`group-submission`, never `GroupSubmission`. macOS is case-insensitive and
Ubuntu is not, so a mis-cased import compiles on a laptop and fails on the
server. Human-readable names go in the manifest's `name` field.

### 7. `initialize()` must be idempotent

The runner calls it again after **every** session recovery. A recovered browser
is a new browser with no cookies, so a UI automation must sign in again. If
`initialize()` assumes it runs once, the first retry executes against a
signed-out portal and fails for a different reason than the original error.

### 8. Every transaction starts from a known state

```ts
await catalog.open(ctx.config.automation.portalUrl);   // do not inherit the previous page
await catalog.resetDraftSubmission();
```

An automation that works for item 1 and fails for item 2 is almost always
inheriting a page, cart, filter or modal from the previous transaction. This is
a real bug that already happened here — see the comment in
`carrier-portal-submission-demo/src/processTransaction.ts`.

### 9. Portal work goes through `step()`, always

`packages/core/src/steps.ts`. Every portal interaction is
precondition → action → postcondition, including "just clicking Next".

- **precondition** fails → we are not on the expected screen → `SystemException`,
  the runner recovers the session.
- **`businessCheck`** returns the portal's own validation message →
  `BusinessException` carrying that wording.
- **postcondition** fails → the action did not land → one `repair()` attempt,
  then `SystemException`.

The postcondition is checked **before** the action too, so an already-satisfied
step is skipped. That is what makes a resumed submission safe — and the UHC
runbook explicitly documents resuming, so it is a real requirement.

**The trap:** a postcondition must reference a payload value. `"a quote exists"`
is satisfied by the *previous* group's quote and the skip-ahead sails past
creating this one. Use `page.getByText(payload.fein)`, not
`page.getByText('Quote created')`. Where genuinely impossible, set
`alwaysRun: true` and say why.

### 9b. Gates must WAIT. Never `isVisible()` in a gate

`step()` calls a gate a "question", and the obvious way to ask "is this on
screen?" is `locator.isVisible()`. That is a trap. `isVisible()` is Playwright's
one **non-waiting** assertion: it snapshots the DOM now and returns `false` if
the element has not rendered yet.

It has already cost a live run. The Anthem automation signed in, reached the
Producer Toolbox, and failed the very first precondition of stage 2 - because the
dashboard was still painting "Loading, please wait ..." at the instant the gate
asked. The locator was correct. The question was asked wrong.

Use the waiting gates from `@rpa/core` (`packages/core/src/gates.ts`):

```ts
precondition:  async () => visible(page.getByLabel(/zip code/i)),
postcondition: async () => valueIs(page.getByLabel(/zip code/i), payload.zip),
```

`visible` · `hidden` · `valueIs` · `textVisible`. All return `false` on timeout
rather than throwing, which is the contract `evaluateGate` already applies - the
difference is that they wait first. `isVisible()` is still fine OUTSIDE a gate,
where you genuinely want "right now" (`readPortalValidationError` uses it).

### 10. Carrier PoCs: `allowSubmit` stays false

Both carrier automations run against **production** portals with no sandbox.
Signing (Anthem) and attestation (UHC) are irreversible. `allowSubmit` defaults
to `false` and every method fronting a submit control must check it and throw a
`BusinessException` naming the guard. Do not flip it to verify something — ask.

### 10b. Reading MFA mail: what is a security control and what is bookkeeping

Both carrier PoCs read a one-time code out of a Gmail label. Two of those
checks are load-bearing and two are not, and conflating them cost a whole
session's worth of debugging.

**Fail closed — these are security controls:**

- the **watermark** (`request.since`). It is the ONLY thing preventing a retry
  from replaying an already-invalidated code. Enforced authoritatively in
  `selectCode`.
- the **sender allow-list**. It is what stops a spoofed "your code is 000000"
  sitting in the same label from being accepted.
- **label scoping**. The provider reads one label, via Gmail's label VIEW
  (`#label/Access+Token+(Anthem)`), never a search and never the inbox.

**Fail open — these are bookkeeping, and throwing here throws away a good code:**

- **marking the message read.** It used to be the consume-once mechanism via
  `is:unread`. It cannot be: this mailbox's filter marks mail read on arrival,
  so `is:unread` matched **0** of 21 labelled messages and hid every code.
  Reading a body also navigates off the list, so re-locating the row to mark it
  fails - and opening a message is itself what clears UNREAD. `consume()` is
  deliberately best-effort.
- **a row that cannot be opened.** Skip it and try the next candidate. The code
  arrives twice (the carrier's original, whose snippet holds it, and a forward
  whose snippet is preamble); aborting on the forward never reaches the original.

Every guard added "for safety" in this layer that was not one of the first three
turned a recoverable situation into a lost code. If you tighten something here,
be sure which list it belongs on.

### 11. Orchestrator: never let two layers retry the same transaction

`robot` mode reports a system failure once as an `ApplicationException` and
Orchestrator's Auto-Retry creates the next attempt. If the runner also retried,
three local attempts against three Orchestrator retries would be **nine real
submissions to a carrier**.

The provider declares `retryOwner`; the runner honours it. This is enforced in
three places and all three must keep working:

- `platformConfigSchema.superRefine` rejects `mode: "robot"` with `maxRetries > 0`
- the runner clamps `maxRetries` to 0 when the backend owns retries (closing the
  hole where a per-automation `automation.json` override bypasses config validation)
- `packages/core/src/runner/retryOwnership.test.ts` asserts one attempt and no
  requeue

If you touch the retry loop or the factory, run that test.

### 12. Orchestrator: credentials, tokens and secrets

- **Never log a token, client secret, or credential password** — not even their
  length. `OrchestratorClient` logs method, path, status, duration, attempt and
  Orchestrator's `traceId`, and nothing else. Two tests assert this.
- Config holds the **names** of `ORCH_CLIENT_ID` / `ORCH_CLIENT_SECRET`, never
  the values.
- `secrets.requireCredential(name)` needs `ORCH_ROBOT_KEY`. The generic
  `/odata/Assets` endpoint returns `CredentialPassword: null` by design —
  Orchestrator only releases it under robot context. Without a robot identity
  the provider throws a `SystemException` saying so; **do not "fix" that by
  returning the username alone or an empty password.**
- Exception `details` objects are deliberately **not** sent to Orchestrator in
  `ProcessingException` — they can carry payload fields. Only message, name and
  stack.

### 13. Mark version-dependent Orchestrator behaviour

Anything whose exact shape depends on the Orchestrator release gets a
`// TODO(orchestrator):` comment saying what to confirm. `grep -rn
"TODO(orchestrator)" packages/` is the punch list for a sandbox, and
`docs/orchestrator.md` tabulates them. Do not silently guess and move on — and
do not remove a marker without having actually verified it against a tenant.

## Where code goes

| Adding | Put it in |
|---|---|
| A new automation | `pnpm rpa new automation --id <domain>/<name> --owner @team --kind browser\|api` — **never** copy a sibling |
| A new process-type domain | `pnpm rpa new domain --name <domain> --owner @team`, then add to `CODEOWNERS` |
| Something two automations in one domain share | `automations/<domain>/_shared/` |
| Something every automation needs | `packages/core/`, exported from `src/index.ts` |
| A selector | `automations/<domain>/<name>/src/pages/` |
| A platform-wide default | `config/platform.json` (+ the schema in `packages/core/src/config/schema.ts`) |
| A new queue backend | one class implementing `QueueProvider`, plus a branch in `packages/core/src/queue/factory.ts`. The runner does not change |
| An Orchestrator endpoint call | `packages/core/src/orchestrator/` — `OrchestratorClient` owns auth/retry/error mapping; callers only describe the request |
| An automation's own setting | its `config/config.<env>.json` under the `automation` key, typed in its `src/config.ts` |

Creating an automation by hand is how manifests keep the wrong `id`, how two
automations silently share a queue, and how deprecated patterns propagate. Use
the generator.

## Code conventions specific to this repo

- **No build step.** Workspace packages export TypeScript sources directly
  (`"exports": { ".": "./src/index.ts" }`) and everything runs through `tsx`.
  `tsc` is typecheck-only (`noEmit`).
- **Relative imports carry an explicit `.ts` extension** — `./errors.ts`, not
  `./errors`. Enabled by `allowImportingTsExtensions`.
- **`verbatimModuleSyntax` is on**, so type-only imports must say
  `import type { Foo }` or `import { type Foo }`.
- **`noUnusedLocals` and `noUnusedParameters` are on.** Prefix a deliberately
  unused parameter with `_`.
- **Zod: use only APIs that behave identically in v3 and v4.** Specifically:
  - Do **not** call `.default({})` on an object schema. Zod 4 changed
    `.default()` to take the *output* type, so it is a type error there. Nested
    defaults live in `DEFAULT_PLATFORM_CONFIG` as a plain typed constant.
  - Format validation errors by hand from `error.issues`; do not use
    `prettifyError`/`treeifyError`/`.format()`.
  - Prefer `z.strictObject(...)` so a misspelled config key is a loud startup
    error rather than a silently ignored line.
- **Structured logging only.** `ctx.logger.info({ groupId, planCount }, 'msg')`,
  never string concatenation. Add sensitive field paths to `REDACT_PATHS` in
  `packages/core/src/logger.ts` — and first ask whether the field is needed.
- **No ESLint.** `typescript-eslint@8` caps at `typescript <6.1` and this repo
  runs TypeScript 7. The boundary rules ESLint would have enforced live in
  `packages/cli/src/boundaries.ts`, run by `rpa validate`. If you add a new
  allowed dependency for automations, update `ALWAYS_ALLOWED` there.

## Gotchas that have already cost time

| Symptom | Cause and fix |
|---|---|
| `Property 'stdSerializers' does not exist on type 'typeof pino'` | pino v10 attaches only `stdTimeFunctions` to the callable export. Import it separately: `import { pino, stdSerializers } from 'pino'` |
| `ERR_CERT_AUTHORITY_INVALID` in the container but not on macOS | Cloudflare Zero Trust inspects TLS. Run `./tooling/scripts/export-corporate-ca.sh` then `docker compose build`. **Three** trust stores are involved: system (`update-ca-certificates`), Node (`NODE_EXTRA_CA_CERTS`), and **Chromium, which uses NSS at `~/.pki/nssdb` via `certutil`** — not `/etc/ssl/certs`. `openssl s_client` reporting `Verify return code: 0` while the browser still fails is the trap. **Never** "fix" this with `ignoreHTTPSErrors`; it disables cert validation for automations that sign in to carrier portals with real credentials |
| Transaction 1 passes, everything after fails | Inheriting page state. See rule 8 |
| A retry fails differently than the original error | `initialize()` is not idempotent. See rule 7 |
| `pnpm exec tsc \| head` looks like it passed | The pipe masks tsc's exit code. Use `if pnpm exec tsc -p tsconfig.json; then ...` |
| Re-running an automation processes nothing | All items are terminal. `pnpm rpa queue <id> --reset` |
| Items show as `abandoned` | A previous run died mid-transaction. They are **deliberately not replayed** — the target system may be half-updated. Same call Orchestrator makes |
| `setsid: command not found` | macOS has no `setsid`. Use a plain background job |
| Playwright MCP: `Browser "chromium" is not installed; expected ... chromium-<N>` | The MCP server bundles its own `playwright-core`, usually newer than the repo's `playwright`, so it wants a **different** chromium build than `pnpm exec playwright install chromium` provides. Fix: `npx -y @playwright/mcp@latest install-browser chromium`. Both builds coexist in `~/Library/Caches/ms-playwright/`; this does not affect the automations, which use the repo's version |
| Playwright MCP: `net::ERR_BLOCKED_BY_CLIENT` | Working as intended. `playwright-mcp.config.json` has `network.allowedOrigins`, and anything not on it is blocked. Add the host deliberately - that allow-list is what stops an agent-driven browser wandering off the portal it is supposed to be mapping |
| `Cannot find package '@rpa/core'` from `tooling/scripts/` | Those scripts resolve through the **root** `package.json`; core is a root devDependency for that reason |
| A new workspace package is not resolvable | Run `pnpm install` after `rpa new` |
| Orchestrator 403 on every call | Scopes are not enough — the External Application also needs a **role on the folder** |
| `rpa validate` fails only for `--env staging`/`prod` | Those environments use `provider: "orchestrator"`; each automation also needs a `config/config.<env>.json` |
| OData `$filter` rejected by the server | Query strings encode spaces as `%20` here, not `+`. `buildUrl` in `OrchestratorClient` does that on purpose |
| `rpa queue --reset` refuses to run | Deliberate: it is local-only. Re-seeding a shared Orchestrator queue is not something a CLI flag should do. `--push-seed` is the additive, safe operation |
| `launchPersistentContext: Opening in existing browser session` / `the profile is already in use` | An orphaned browser still holds the persistent profile - almost always one left behind by a run that aborted. 20 had accumulated at one point, and every later run failed for this reason instead of the real one. Whoever creates a provider must close it in a `finally`. To clear: `ps -Ao pid=,command= \| grep "user-data-dir=.../data/profiles" \| awk '{print $1}' \| xargs kill` |
| Gmail: `#label/...` URL works by hand but the poll loop never sees new mail | `goto()` to a URL differing only in its `#fragment` is a **same-document** navigation, so the SPA is never re-entered and every poll re-reads a cached list. A code that arrived in 26s went unseen through 106 polls. Add a changing query parameter (`?rpa=<ts>`) so it is a real navigation |
| Gmail search returns far more rows than the label holds | A search-based poll can land on the **inbox** - one returned 51 rows where the label had one thread, and it was parsing them. Use the label VIEW and refuse to parse rows unless the fragment starts with `label/` |
| Gmail: a code arrives but is rejected as stale | A row's date reads "6:38 PM" with no seconds, so it is minute-precision. Report the **last instant** of that minute (`lastInstantOfMinute`) or a code arriving in the same minute it was requested is rejected - exactly what a fast delivery looks like |
| Gmail: a row reference is invalid a moment later | Rows carry **no stable thread id**; the `id` attribute (`:44`) is reassigned on every SPA re-render. Identify a row by content (sender + date title) and never by DOM id, and never fabricate a `#all/<id>` URL from one |
| Gmail's basic HTML view (`/mail/u/0/h/`) 404s or redirects | Google **retired it in January 2024**. `docs/poc/mfa-gmail.md` originally specified it; `GmailUiMfaProvider` reads the modern UI instead, under protest. `GmailApiMfaProvider` is the only option that does not depend on Gmail's markup |
| `--remote-debugging-port` is silently ignored by Chrome | Chrome **136+** refuses to debug the DEFAULT profile, specifically to stop software attaching to a real profile and reading its cookies. It needs a non-default `--user-data-dir`, which means a fresh sign-in - so an everyday Chrome session cannot be attached to. Copying the profile does not help either: macOS encrypts its cookies against a Keychain entry Playwright's Chromium cannot read |
| `Access Denied` from `brokerportal.anthem.com` | Anthem blocks **headless** Chromium and loads normally headed - a 403 with an Akamai reference. `.env` sets `HEADLESS=false` for that reason. **The container handles it**: the image installs `xvfb` and the entrypoint starts a virtual display when `HEADLESS=false` and no `DISPLAY` is set, so `HEADLESS=false docker compose run --rm rpa <id>` works on a server with no screen. Prove any new runtime with `tooling/scripts/check-portal-access.ts` before trusting it - `rpa doctor` proves Chromium starts, not that the carrier accepts it |
| A URL check matches a page you are not on | OAuth flows quote each other's URLs in query parameters. Okta's authorize URL carries `redirect_uri=https://brokerportal.anthem.com/apps/ptb/_codexch`, so `waitForURL(/brokerportal\.anthem\.com\/apps\/ptb/)` succeeds while the browser sits on the LOGIN screen. This made the MFA step decide no code was needed and skip it. **Parse the URL** (`new URL(u).host`, `.pathname`) instead of pattern-matching the whole string |
| A gate times out well before the budget you gave its locator | `step()` caps EVERY gate at the step's own `timeoutMs` (default 60s), so `visible(x, 300_000)` inside a step with no `timeoutMs` really waits 60s. Set `timeoutMs` on the step spec too. This cut Anthem's quote-documents page off mid-render and made the runner retry a transaction that had already created a real quote |
| A gate is always false on a screen you can see | `isVisible()` does not wait. See rule 9b. Use `visible()` from `@rpa/core` |
| Anthem: `Create Quote` seems to do nothing | It opens a **new tab on a different host** - `elevancehealthfulcrum.my.site.com`, the Salesforce/Vlocity "Small Group Quote & Enroll" platform that replaced the old Producer Toolbox flow. Follow the popup; Producer Toolbox is only the launcher now |
| Salesforce/Vlocity: `getByRole('radio', { name: 'No' })` matches 22 elements | The Vlocity wizard **pre-renders every branch**, so ~11 fieldsets sit hidden in the DOM. Legend text repeats across branches too. Scope to the fieldset whose **direct-child** legend matches (`:scope > legend`) and filter to the visible one. `hasText` alone matches an outer wrapper fieldset and clicks the PREVIOUS question's answer |
| Salesforce/Vlocity: clicking a radio or checkbox times out | The `input` is **1x1 px behind `label.slds-radio__label`**; `elementFromPoint` returns the custom element, so actionability never passes. Click the **label** |
| Salesforce/Vlocity: a combobox reads as empty although it is set | The value lives on **`data-value`**, not `value`. `inputValue()` returns `''`. Some are also `readonly` + `aria-disabled` and pre-filled (Anthem's `Benefit Period` is already `Calendar Year`) - clicking those times out; assert them instead |
| Salesforce/Vlocity: generated ids | `vlocity-radio-0-1-110`, `comboboxId-604` - they carry a re-render counter and change. Never use an id or `name` as a locator |
| A dump shows five controls on a screen with thirty, or a `page.evaluate` reads a full table as empty | Lightning uses **shadow DOM**. `document.querySelector(All)` does not pierce it; walk `el.shadowRoot` recursively. Playwright's own locators DO pierce it, so this only bites hand-written DOM traversal — but it bites it in automation code too, not just in dumps: `readChecklist` threw "the table read as empty" against a screen showing all 23 rows, which reads like a screen that had not rendered |
| The `Anthem_NewPlans` VBA "is compiled" | **It is not.** The `.xlsm` stores it under standard MS-OVBA compression and the module decompresses intact. The Quoting transform is known exactly - see `docs/poc/excel-macros.md` |
| A Playwright locator times out on an element that is plainly visible | Check the accessible name and role rather than the visible text. Real examples from Anthem: a button reading "Continue" whose accessible name is `Login` (from `aria-label`); an `input[type=submit]` whose name comes from `value="Next"`; a "Resend Code" **anchor with no `href`**, which therefore has no link role at all; and "Book of Business" appearing five times, once as a `span[role="button"]` menu toggle |
| `getByRole('button', { name: <visible text> })` matches **zero** elements | An `aria-label` overrides the text content entirely. The Document Checklist's `Submit` carries `aria-label="documentCheckListSubmit"`, so a role lookup for "Submit" finds nothing at all — measured. Use `button()` from `lightning.ts`, which filters on text |
| Anthem: a second run for the same group times out waiting for the application URL | The portal **redirects** to `/broker/s/inprogressapplication` — "Application Matching Error", only control `Exit` — because that group already has an application in progress. The text has no alert role, so `readPortalValidationError` misses it. `readApplicationMatchingError()` reports it as a Business failure; an end-to-end re-test needs a **different group** |

## Verifying before you claim something works

```bash
pnpm check                                      # typecheck + validate + the full suite
pnpm rpa run group-submission/carrier-portal-submission-demo
```

Do not quote a test count from this file - it goes stale on every change. Read
the number `pnpm check` prints.

The reference automation must produce exactly:

```
processed : 4        success : 2        business : 1        system : 1        retries : 3
```

with `SUB-1003` recovering on attempt 2 and `SUB-1004` exhausting its retries.
If the numbers differ, something in the runner or the automation is wrong — do
not adjust the expectation. Both automations, plus the container and the
`linux/amd64` image, have been verified to produce these results.

For changes touching the Orchestrator layer, the unit tests use a mocked
`fetch` (`packages/core/src/orchestrator/testFetch.ts` — test-only, not exported
from `index.ts`). Nothing in the suite touches a network. To check against a real
tenant:

```bash
pnpm rpa orchestrator check --env staging --automation <id>
ORCH_SMOKE=1 ORCH_BASE_URL=... ORCH_CLIENT_ID=... pnpm test
```

**Do not describe the Orchestrator integration as verified end to end.** As of
this writing it has never run against a live tenant: the tests prove the logic
against a mocked `fetch`, not the endpoint shapes. Every behaviour that could
differ by version is marked `TODO(orchestrator):`. Say "unit-tested, not yet
validated against a tenant" until someone has actually run the two commands
above.

For changes touching the browser, session recovery or the container, also run:

```bash
docker compose run --rm rpa group-submission/carrier-portal-submission-demo
```

Read the evidence of your own failure cases in
`artifacts/<runId>/<reference>-attempt-N/`. If `error.json` and the screenshot
would not tell you what went wrong at 03:00, add `details` to the exception (no
PII, no secrets).

## Deliberately absent — do not add without asking

- **Orchestration/scheduling.** `automation.json` declares `schedule`; nothing
  executes it yet.
- **More queue backends.** Orchestrator is implemented; Postgres/Redis/SQS are
  not. The local adapter is a JSON file **on purpose** — `better-sqlite3` is a
  native module that compiles per platform, which is exactly the arm64 → amd64
  hazard this repo avoids.
- **Orchestrator jobs, Action Center tasks, Data Service.** Only queues, assets
  and buckets are integrated.
- **A vault.** `SecretProvider` is the seam.
- **An audit store.** `AuditSink` already emits every event; only the sink is
  missing.
- **Multi-worker parallelism.** The local queue is single-writer.
- **`ignoreHTTPSErrors`.** See the gotchas table. Not offered as an option.
- **Browsers other than Chromium.**
- **`@playwright/test`.** Playwright MCP (`.mcp.json`,
  `playwright-mcp.config.json`) is a **development-time** tool for exploring
  portals and generating locators. It is a devDependency, is never in the
  container, and is not the runtime.

## Style

Match the surrounding code. Comments here explain **why** a non-obvious choice
was made — the trade-off, the failure it prevents — not what the line does.
Several exist specifically to stop a future reader from "simplifying" away a
deliberate decision. Keep that standard; do not add narration.
