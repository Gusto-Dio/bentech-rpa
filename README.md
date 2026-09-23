# bentech-rpa

> **This is a capability demonstration, not a deployed system.** It exists to
> prove that carrier-portal work can run unattended with the resilience
> contract we relied on in UiPath's REFramework — and that we can build the
> platform around it in-house. Running any of it as a production service needs
> a hardening and security review first; see the three phases below for what is
> proven, what is being built, and what is still exploration.
>
> One distinction matters throughout, because it is easy to misread: **the
> repository is not production, but the carrier portals it drives are real
> production portals with no sandbox.** That is exactly why `allowSubmit` stays
> `false`.

An RPA platform for **unattended process automation** on Playwright + TypeScript,
built to carry over the resilience contract we relied on in UiPath's REFramework:
a state machine, a work queue, a hard split between business and system
failures, retry with session recovery, and structured per-transaction logging.

This is **not a test framework.** There is no test runner, no fixtures, and no
assertions used as control flow. It uses the `playwright` library directly, not
`@playwright/test`, because an unattended process owns its own lifecycle.

It is also **not one automation.** It is the repo that will hold hundreds of
them, across several process-type domains, plus the templates used to create new
ones. Most of the design decisions here follow from that: one shared core, hard
import boundaries, and a manifest per automation so the tree stays governable as
it grows.

---

## Status

Working and verified end to end:

| | |
|---|---|
| Resilient core | State machine, queue abstraction, session recovery, retry policy, circuit breaker, artifacts, structured logging, graceful stop |
| `rpa` CLI | `run`, `list`, `validate`, `queue`, `new`, `doctor` |
| Two reference automations | One browser (`group-submission`), one with no browser at all (`member-submission`) |
| Three templates | Browser automation, API automation, new domain — each verified by `pnpm verify:templates` |
| Portability | Identical outcomes on macOS arm64, the arm64 container, and the `linux/amd64` image the servers run |
| **Orchestrator integration** | External-Application auth, queue provider in two modes, assets-backed secrets, storage buckets, `rpa orchestrator check` |
| **MFA from a mailbox** | `GmailUiMfaProvider` (browser) and `GmailApiMfaProvider` (REST) behind one seam, with a watermark, a sender allow-list and single-label scoping. **Proven end to end against the live Anthem portal** — real code read, login completed, session persisted |
| **Session reuse** | `createCarrierPortalSession` probes a stored `storageState` with a signed-in-only page. A recovered session consumes **no** MFA code — verified in a real run |
| **Carrier PoCs** | Anthem CA: **working end to end** — an unattended run drives quote creation, the census round-trip, plan selection, quote generation and all nine editable screens of the employer application, then stops on the `allowSubmit` guard at the last editable screen (82 steps, 0 system failures, no MFA code spent). Note the flow moved to Anthem's **Salesforce/Vlocity** platform, so the original runbook's stages 2.2–8 no longer exist as written. The signature is deliberately unmapped. UHC: stages 1–8 written and the portal-independent half tested — census transform, derived values, evidence hook, session seam and the `allowSubmit` guard — but **no locator has ever met a live screen**: the eServices pre-login page is reachable but sign-in crosses to One Healthcare ID and nothing past it has been read, so every portal literal is recorded as `null` and throws rather than guessing. A recon harness (`uhc-serve` / `uhc-do`) is there to do the re-map on one MFA code |
| Checks | `pnpm check` — strict typecheck, boundary + manifest validation, and the full test suite |

Deliberately seams only, not implementations — see [Roadmap](#roadmap-the-layers-this-is-built-to-accept):
orchestration/scheduling, a secrets manager, an audit store.

## Watching the portals

The carrier portals change underneath these automations — the Anthem quote flow
moved to a different host mid-PoC, and `docs/poc/*/drift-log.md` records about a
hundred and thirty divergences between what a runbook said and what the portal
actually does.

`rpa sentinel` watches for two distinct things:

```bash
pnpm rpa sentinel --list                 # what probes exist, and what each costs to run
pnpm rpa sentinel --set access           # a dry run. Filing is opt-in
```

- **failure** — a probe could not do what it set out to do
- **drift** — a probe succeeded, but the screen is not the screen we recorded

Drift is the half worth having: a field renamed today breaks a run next week.
Probes create nothing, because rule 10a permits only signing in and navigating.

When the sentinel files a healable finding, an unattended repair session can
propose a fix as a **draft** pull request, with a masked before/after pair and a
verification ladder. It never merges. See
[docs/operations.md](docs/operations.md) for the operational surface and
`.claude/skills/portal-drift-repair/SKILL.md` for the procedure.

```bash
pnpm heal:selftest                       # prove the guard rails before trusting a heal
```

## Quickstart

```bash
# Node 24 (pinned in .nvmrc and package.json engines)
mise install            # or: nvm use   /   fnm use

pnpm install
pnpm exec playwright install chromium

cp .env.example .env    # then fill in the values

pnpm rpa doctor         # will this machine actually run an automation?
pnpm check              # typecheck + validate + tests
pnpm rpa list           # what automations exist
pnpm rpa run group-submission/carrier-portal-submission-demo
```

The reference automation runs against the public `saucedemo.com` demo site, so
it works out of the box. Its four synthetic transactions deliberately produce
one of each outcome:

```
processed : 4
success   : 2
business  : 1     <- rule violated, failed immediately, never retried
system    : 1     <- retried twice with a full session recovery, then failed
retries   : 3
```

Exit code is `0` when nothing failed at the system level, `1` when something
did, `2` if Initialize failed, `3` if the circuit breaker tripped.

---

## Dev on macOS, runtime on Ubuntu

Portability is a first-class requirement, not a detail. The same code runs in
both places; only the environment differs.

| | **macOS (development)** | **Ubuntu server (runtime)** |
|---|---|---|
| Node | `mise install` (reads `.nvmrc` → 24) | Baked into the runtime image (also 24) |
| Browsers | `pnpm exec playwright install chromium` | `pnpm exec playwright install --with-deps chromium`, or use the image, which already has them |
| Headless | `HEADLESS=false` to watch it | Always `true` — there is no display |
| Run | `pnpm rpa run <id>` | `docker compose run --rm rpa <id>` |

```bash
# macOS: watch a run happen
HEADLESS=false LOG_PRETTY=true pnpm rpa run group-submission/carrier-portal-submission-demo

# Ubuntu, from bare metal rather than the image
pnpm exec playwright install --with-deps chromium   # <- --with-deps is the important part
pnpm rpa run group-submission/carrier-portal-submission-demo
```

`--with-deps` installs the system libraries a headless server is missing —
fonts, `libnss3`, `libatk` and friends. Their absence is the single most common
cause of "it worked on my Mac". No `xvfb` is needed: Playwright's Chromium runs
natively headless.

### What keeps the two in step

- **`.nvmrc` + `engines` + `mise.toml`** pin Node 24 — the same major the
  runtime image ships, so the versions match because they *are* the same
  version, not because two places were kept in sync by hand.
- **`.gitattributes`** forces LF. A CRLF shell script fails on Ubuntu only.
- **`forceConsistentCasingInFileNames`** plus kebab-case folders everywhere.
  macOS is case-insensitive and Ubuntu is not, so `GroupSubmission` imported as
  `groupsubmission` compiles on a laptop and fails on the server.
- **No absolute paths, no `open`, no assumed Homebrew binaries.** Everything
  resolves from the repo root, found by walking up to `pnpm-workspace.yaml`.
- **`HEADLESS` is never hardcoded and never inferred from `process.platform`.**
  The default is `true` everywhere; headed mode is an explicit local opt-in.

### Corporate TLS interception — read this before the first container run

If your network runs a Zero Trust proxy that terminates TLS (Cloudflare WARP,
Zscaler, Netskope), **every HTTPS navigation inside the container fails**:

```
page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://...
```

Your Mac trusts the proxy's CA because the MDM profile installed it. A fresh
container does not. This affects real carrier portals, not just the demo site.

```bash
./tooling/scripts/export-corporate-ca.sh   # macOS: pulls the CA from the System keychain
docker compose build                        # bakes it into the image
```

The fix needs **three** stores, which is the non-obvious part:

| Consumer | Trust store | Handled by |
|---|---|---|
| `curl`, `openssl` | `/etc/ssl/certs` | `update-ca-certificates` |
| Node's HTTPS client | its own bundled list | `NODE_EXTRA_CA_CERTS` |
| **Chromium** | **NSS**, at `~/.pki/nssdb` | **`certutil`** |

Getting only the first two working is a convincing trap: `openssl s_client`
reports `Verify return code: 0`, and the browser still fails. All three are in
the Dockerfile.

`certs/*.crt` is gitignored — these are public certificates, but an internal CA
describes internal infrastructure and is supplied per environment. See
[certs/README.md](certs/README.md).

**Not** `ignoreHTTPSErrors`. That disables certificate validation for every
request an automation makes, on automations that sign in to carrier portals with
real credentials. Trusting one known CA is the narrow fix; switching off
verification is not, and this repo does not offer it as an option.

### Container

```bash
# Same command on either platform
docker compose run --rm rpa group-submission/carrier-portal-submission-demo

# Build for the server explicitly. On Apple Silicon this cross-builds (slowly),
# which is the price of not shipping an arm64 image to an x86_64 host.
docker buildx build --platform linux/amd64 -f tooling/docker/Dockerfile -t bentech-rpa:1.0.0 .
```

The image is `mcr.microsoft.com/playwright:v1.62.1-jammy` — Ubuntu 22.04 with
browsers and their system libraries already installed. It runs as the non-root
`pwuser`, so **Chromium keeps its sandbox**. `CHROMIUM_NO_SANDBOX=true` exists
as an escape hatch for when you are forced to run as root, and disabling the
sandbox means a compromised page inherits the container's privileges — prefer
fixing the user.

**One image, every automation.** `rpa run <id>` (or `AUTOMATION_ID`) selects the
process at start. This is UiPath's model — one robot runtime, N processes — so a
Chromium CVE is one rebuild rather than a hundred.

---

## Repository layout

```
packages/            THE CORE - platform team owns. One version, no forks.
  core/              @rpa/core: runner, queue, session, errors, config, artifacts
    orchestrator/    Orchestrator HTTP client, buckets, SpecificContent codec
    mfa/             MFA code providers (seam) - carrier portals need MFA
    steps.ts         precondition -> action -> postcondition helper
    queue/           LocalQueueProvider, OrchestratorQueueProvider, factory
    secrets/         Orchestrator assets + provider chaining (secrets-manager seam)
  cli/               @rpa/cli: the `rpa` command
  testkit/           @rpa/testkit: fakes and fixtures for testing automations
automations/         THE PROCESSES - grouped by process type, each domain owns its own
  group-submission/
    _shared/         @auto/group-submission-shared - payload schema, portal session, census
    anthem-ca-new-plans/            PoC: Anthem CA producer portal (MFA)
    uhc-np-new-plans/               PoC: UHC SAMx portal (MFA)
    carrier-portal-submission-demo/ reference implementation (saucedemo)
  member-submission/
templates/           THE SCAFFOLDS - `rpa new`, never copy-paste
tooling/             tsconfig bases, Dockerfile, scripts
config/              platform.json + environments/{dev,staging,prod}.json
docs/                architecture, authoring, UiPath migration, Orchestrator, operations
```

### Adding an automation

```bash
pnpm rpa new automation \
  --id group-submission/carrier-eligibility-sync \
  --owner @gusto/bentech-rpa-group-submission \
  --kind browser          # or: --kind api  (no browser at all)

pnpm install && pnpm rpa validate
```

Use `rpa new domain --name <domain> --owner @team` for a new process type. Both
are generators on purpose: copying a sibling automation is how manifests end up
with the wrong id, how two automations quietly share a queue, and how a
deprecated pattern outlives its deprecation.

### Boundaries, enforced

`pnpm rpa validate` fails the build on any of these:

| Rule | Why |
|---|---|
| An automation imports only `@rpa/core`, its **own** `@auto/<domain>-shared`, `node:*`, `zod`, `playwright` | Without it, at ~30 automations the dependency graph is a ball of mud and two teams are coupled through a file neither considers public |
| No deep imports (`@rpa/core/src/...`) | Lets the platform team restructure internals without a 100-automation migration |
| No relative import escaping its own automation folder | Same reason, via the back door |
| `packages/` never imports `automations/` | The engine cannot depend on its consumers |
| Manifest `id`/`domain` must match the folder they live in | Catches the copy-paste mistake directly |
| No duplicate `id` or `queue.name` | Two automations sharing a queue would silently steal each other's work |

It also loads every automation module and resolves every automation's config, so
"it imports cleanly and its settings are complete" is proven before merge rather
than discovered at 03:00 by the scheduler. `pnpm check` runs it — and since
Actions is disabled org-wide here, running it is the reviewer's job, not a
robot's.

---

## REFramework → this repo

| REFramework (UiPath) | Here |
|---|---|
| `Main` state machine | [`packages/core/src/runner/runner.ts`](packages/core/src/runner/runner.ts) |
| `Config.xlsx` — Settings / Constants | 5 config layers: schema defaults → `config/platform.json` → `config/environments/<APP_ENV>.json` → the automation's `config/config.<env>.json` → env vars |
| `Config.xlsx` — Assets | Config stores the **name** of a credential; `ctx.secrets` resolves the value |
| Orchestrator Queue | [`QueueProvider`](packages/core/src/contracts/QueueProvider.ts) + `LocalQueueProvider` (JSON file) |
| `QueueItem`, `GetTransactionItem` | `QueueItem<T>` + `queue.getNext()` |
| `SetTransactionStatus` | `queue.complete()` / `queue.fail(item, 'business' \| 'system')` |
| `MaxRetryNumber` | `maxRetries`, applied to **system** exceptions only |
| `RetryScope` | [`withRetry()`](packages/core/src/retry.ts) — retries one *action*, not the transaction |
| `InitAllApplications` | `session.init()` + the automation's `initialize()` |
| `CloseAllApplications` / `KillAllProcesses` | `session.close()` / `session.recover()` |
| `TakeScreenshot` on error | [`ArtifactStore.captureFailure()`](packages/core/src/artifacts.ts) — screenshot, and a Playwright trace for system failures |
| `Business Rule Exception` | `BusinessException` |
| `System Exception` | `SystemException` (and anything else that throws) |
| `Log Message` with fields | `pino`, with `{ runId, automationId, transactionId, reference, attempt, retry, status }` |
| `ShouldStop` | `SIGINT`/`SIGTERM` → finish the current transaction, then exit cleanly |
| Orchestrator process list | `automation.json` per automation, discovered by `rpa list` |

### Business vs System — the contract everything hinges on

```ts
// The rule says no. Retrying produces the identical answer.
throw new BusinessException('Carrier does not offer: Sauce Labs Hoverboard');
//  -> failed immediately, no retry, run continues with the next item

// The environment misbehaved. A retry might work.
throw new SystemException('Portal did not acknowledge the submission');
//  -> screenshot + trace, browser relaunched and re-authenticated,
//     SAME transaction retried, up to maxRetries
```

**Anything that is not a `BusinessException` is treated as a system failure** —
including Playwright's `TimeoutError`. That default is deliberate: an
unrecognised failure is far more likely to be a broken environment than a
business rule, and retrying a business rule merely wastes time whereas failing a
recoverable transaction loses work.

### Deliberate divergences from REFramework

1. **Transaction retry happens in-process.** In UiPath, a system exception marks
   the item `Failed/System` and *Orchestrator* mints a new retry item carrying
   `RetryNo`. Here the runner retries the same item and `queue.requeue()`
   records the attempt. That method is the seam a real backend uses to adopt
   Orchestrator's semantics instead.
2. **Two retry levels, not one.** The runner retries the transaction
   (`MaxRetryNumber`); `withRetry()` retries a single flaky action
   (`RetryScope`) without burning a transaction attempt — which would also tear
   down and relaunch the whole browser.
3. **A circuit breaker.** After `maxConsecutiveSystemExceptions` back-to-back
   system failures the run aborts, instead of converting the rest of the queue
   into failures a human then has to sort out one at a time.
4. **No untyped `Settings("SomeKey")` bags.** Platform knobs are a strict
   schema, and each automation declares a Zod schema for its own settings, so a
   missing or misspelled setting fails at Initialize with a precise message.
5. **`sessionKind: "none"` is a first-class option.** Not every automation
   drives a UI. Forcing Chromium onto file and API work costs seconds of startup
   and hundreds of megabytes per run for nothing.

---

## The `rpa` command

```
rpa run <id> [--provider local|orchestrator] [--env dev] [--max-items N]
                                           Run one automation (production entrypoint)
rpa list [--domain d] [--json]             What exists, from the manifests
rpa validate [--env dev]                   Manifests, boundaries, config, loadability
rpa queue <id> [--reset | --push-seed]     Inspect, re-seed locally, or dispatch to Orchestrator
rpa new automation --id d/n --owner @team  Scaffold from a template
rpa new domain --name d --owner @team      Scaffold a new process type
rpa doctor                                 Can this machine actually run one?
rpa orchestrator check [--automation <id>] Orchestrator auth, scopes, folder, queue
```

`--reset` is local-only by design; `--push-seed` is the additive, safe operation
against a shared Orchestrator queue.

| Variable | Effect |
|---|---|
| `APP_ENV` | Selects `config/environments/<APP_ENV>.json`. `dev` \| `staging` \| `prod` |
| `HEADLESS` | `false` shows the browser. Developer machines only |
| `LOG_PRETTY` | `true` for human-readable logs; production keeps JSON |
| `LOG_LEVEL` | `trace` … `fatal`, or `silent` |
| `CHROMIUM_NO_SANDBOX` | Escape hatch for running as root. Read the trade-off first |
| `QUEUE_PROVIDER` | `local` \| `orchestrator`, overriding environment config |
| `QUEUE_MODE` | `robot` \| `odata` |
| `ORCH_CLIENT_ID` / `ORCH_CLIENT_SECRET` | External Application credentials |
| `ORCH_ROBOT_KEY` | Unattended robot key — `robot` mode and credential assets |

All variables are documented in [`.env.example`](.env.example), which lists
**names only** — no values, ever.

---

## Testing

The framework is not a test framework, but the platform has tests. They use
Node's built-in runner, so there is no test dependency to install.

```bash
pnpm test        # node --test via tsx
pnpm check       # typecheck + validate + test
```

Nothing in the suite touches a network. The Orchestrator layer is tested against
an injected `fetch` double, with injected clocks so token expiry is
deterministic. The one test that does talk to a real tenant is opt-in and skips
cleanly:

```bash
ORCH_SMOKE=1 ORCH_BASE_URL=... ORCH_CLIENT_ID=... pnpm test
```

`@rpa/testkit` is what makes an automation testable without a browser, a queue
or a filesystem:

```ts
import { createTestTxContext } from '@rpa/testkit';

const ctx = createTestTxContext<Payload, AutomationConfig>({
  payload: { memberRef: 'MBR-000123', planCode: 'MED-PPO-9999', /* ... */ },
  automationConfig: { planCatalogFile: '...', maxMonthsAhead: 12 },
  attempt: 1,
});

await assert.rejects(processTransaction(ctx), BusinessException);
```

Business rules are the part most worth testing and the part that needs none of
the machinery around them. Tests like that run in milliseconds, which is what
makes it practical to cover every rule instead of only the happy path.
`InMemoryQueueProvider` and `FakeSession` cover the cases that need a queue or a
session — `FakeSession` counts `recoverCount`, so you can assert that a recovery
happened without waiting for four real browser launches.

## Playwright MCP — development only

[`playwright-mcp.config.json`](playwright-mcp.config.json) configures Playwright
MCP so an agent can drive a real browser while you are *writing* an automation:
explore the portal, read the accessibility tree, and generate resilient
locators.

```bash
pnpm mcp     # or let your editor pick up .mcp.json automatically
```

**It is not the production runtime.** Automations run through `rpa run`, which
uses the `playwright` library directly. MCP never appears in the container and
is a `devDependency`.

Two settings in that config are worth knowing about:

- `network.allowedOrigins` restricts the MCP browser to the portals you are
  actually working on, so an agent driving it cannot wander onto other sites.
  Add hosts as you need them, deliberately.
- `testIdAttribute: "data-test"` makes generated locators use the demo site's
  own attributes rather than brittle CSS.

### Selector policy

Most resilient first: `getByRole` → `getByLabel` / `getByPlaceholder` →
`getByTestId` → CSS, and CSS only inside a page object. **No XPath anywhere.**

Every selector lives in `src/pages/`, so a vendor redesign has a blast radius of
one directory. Those files also carry `// AUTO-HEALING SEAM:` comments marking
the steps where an LLM-assisted locator (Stagehand or similar) would slot in —
always as a *fallback after* the deterministic locator fails, never instead of
it.

---

## UiPath Orchestrator integration

The framework can consume your existing Orchestrator, so processes migrate
incrementally. The **queue name** stays in `automation.json`; the **backend**
lives in environment config — so the same automation runs against the local JSON
queue in dev and Orchestrator in staging and production without a line of
automation code changing.

```bash
pnpm rpa orchestrator check --env staging --automation <id>   # do this first
pnpm rpa run <id> --provider orchestrator --env staging
```

The essentials:

### (a) The External Application and its scopes

Orchestrator → **Admin → External Applications → Add Application**, type
*Confidential application*. Request:

| Scope | Needed for |
|---|---|
| `OR.Queues` | consuming and dispatching queue items |
| `OR.Assets` | reading assets as secrets |
| `OR.Administration` | **writing** to storage buckets (reads work without it) |

Then assign the application a role on the **folder** holding your queues.
Scopes alone are not enough — without a folder assignment every call returns 403.

`rpa orchestrator check` reports the scopes Orchestrator actually *granted*,
which can be narrower than what you requested.

### (b) `robot` mode vs `odata` mode

| | `robot` (recommended) | `odata` (fallback) |
|---|---|---|
| How it claims work | `StartTransaction` | OData filter on `Status eq 'New'` |
| Locking | Orchestrator | **none available** |
| Retries owned by | Orchestrator's Auto-Retry | the runner |
| Needs a robot identity | yes (`ORCH_ROBOT_KEY`) | no |
| Concurrency | safe | **single worker only** |

Use `robot` wherever a robot identity exists — it is the path that behaves like
the UiPath process you are migrating from.

`odata` exists for a plain External Application with no robot. Its limitation is
structural, not an oversight: Orchestrator's OData surface has no way to move an
item to `InProgress` (the documented `PUT /odata/QueueItems({Id})` body carries
`Name`, `Priority`, `SpecificContent`, `Reference`, `Progress` — not `Status`),
so there is no atomic claim.

**Retry ownership is enforced, not just documented.** In `robot` mode a system
failure is reported once as an `ApplicationException` and Orchestrator creates
the retry; the runner does not also retry. Three local attempts against three
Orchestrator retries would be **nine real submissions**, so `rpa validate` fails
when `mode: "robot"` meets `maxRetries > 0`, and the runner clamps it regardless.

### (c) Credential assets return a null password

The generic `GET /odata/Assets` endpoint returns `CredentialPassword: null` by
design — Orchestrator only releases a credential password under **robot
context**. So `secrets.requireCredential(name)` needs `ORCH_ROBOT_KEY`, and
without it throws a `SystemException` saying exactly that instead of handing back
an empty password that fails later inside a portal login.

**Recommendation: do not depend on Credential assets for sensitive secrets.** Put
them in an external secrets manager behind the same `SecretProvider` interface —
one class, one line of wiring, and the robot-context constraint disappears. Plain
Text/Integer/Bool assets are fine for non-sensitive configuration.

For sensitive payloads, turn on Orchestrator's **AES-256 encryption of Specific
Data and Output** at queue creation (it cannot be enabled later).

### (d) New environment variables

| Variable | Purpose |
|---|---|
| `ORCH_CLIENT_ID` / `ORCH_CLIENT_SECRET` | External Application credentials |
| `ORCH_ROBOT_KEY` | Unattended robot key — `robot` mode and credential assets |
| `QUEUE_PROVIDER` | `local` \| `orchestrator`, overriding environment config |
| `QUEUE_MODE` | `robot` \| `odata` |

Config stores only the **names**. Smoke-test variables (`ORCH_SMOKE`,
`ORCH_BASE_URL`, `ORCH_ORGANIZATION`, `ORCH_TENANT`, `ORCH_FOLDER_ID`,
`ORCH_QUEUE_NAME`, `ORCH_BUCKET_NAME`) are listed in
[.env.example](.env.example).

### Version-dependent behaviour

```bash
grep -rn "TODO(orchestrator)" packages/
```

Each marker is something that has moved between Orchestrator releases — the
`StartTransaction` empty-queue response, the duplicate-reference error code, the
robot-scoped asset operation name. They are the punch list for your sandbox, and
`rpa orchestrator check` plus `ORCH_SMOKE=1 pnpm test` settle most of them in one
pass.

## Roadmap: the layers this is built to accept

Each of these is a seam that already exists in the code, not a rewrite.

### (a) A real queue backend — **done for Orchestrator**

`QueueProvider` was the seam, and
[`OrchestratorQueueProvider`](packages/core/src/queue/OrchestratorQueueProvider.ts)
is the proof it worked: the runner, the exceptions and the session lifecycle did
not change, beyond honouring `retryOwner`. Another backend — Postgres, Redis,
SQS — is the same shape: one class, plus a branch in
[`queue/factory.ts`](packages/core/src/queue/factory.ts).

The local adapter remains a JSON file with atomic writes, chosen over SQLite on
purpose: `better-sqlite3` is a native module that compiles per platform, which
is exactly the arm64 → amd64 hazard this repo exists to avoid. `leaseUntil` is
already on `QueueItem` for the backend that wants multi-worker leasing.

### (b) Orchestration and scheduling

`automation.json` already carries `schedule.cron` and `schedule.timezone`;
nothing reads them at runtime yet. A scheduler reads the manifests, and since
exit codes are a stable contract (`0` ok, `1` system failures, `2` init failed,
`3` unstable) it can act on outcomes without parsing logs. Start with a
Kubernetes `CronJob` per manifest; graduate to a real orchestrator when
cross-automation dependencies appear.

### (c) A managed secret store

`ctx.secrets` is a `SecretProvider`. The env-backed implementation is 15 lines;
an AWS Secrets Manager one replaces it without touching an automation,
because config files already store credential *names* rather than values. The
manifest is where an automation would declare which secret paths it is entitled
to.

### (d) Governance and audit

`AuditSink` already receives every state change an auditor would ask about —
run started/finished/aborted, each transaction's outcome, every session
recovery. Today `LoggerAuditSink` writes them as log lines tagged
`audit: true`; pointing the same stream at an append-only store makes "which
automation touched this group, when, and what did it decide" a query instead of
an archaeology project. `owners` and `criticality` in the manifest are what
alert routing will read.

---

## Security posture

- **No secrets in config, ever.** Config stores the *name* of an environment
  variable; `ctx.secrets` resolves it. `.env` is gitignored; `.env.example`
  carries names only.
- **No PII in the repo.** Every seed file and fixture is obviously synthetic.
  The `member-submission` payload deliberately carries `memberRef` and nothing
  else — no names, no dates of birth, no SSNs, no wages. See
  [docs/authoring-an-automation.md](docs/authoring-an-automation.md).
- **Logs are redacted** on password, token, secret, authorization, ssn, dob,
  account and routing fields (`REDACT_PATHS` in `packages/core/src/logger.ts`).
- **Orchestrator secrets never reach a log.** The client logs method, path,
  status, duration, attempt and Orchestrator's `traceId` — never the access
  token, the client secret, or a credential password. Two tests assert it, and a
  secret echoed back in a token-error body is scrubbed before it reaches the
  exception message.
- **Exception `details` are not sent to Orchestrator.** `ProcessingException`
  carries only the message, name and stack, because a `details` object can hold
  payload fields. For payloads that genuinely need protecting, enable
  Orchestrator's **AES-256 encryption of Specific Data and Output** at queue
  creation — it cannot be turned on later.
- **Chromium keeps its sandbox**, because the container runs non-root.

---

## Known gaps

Honest list, so nobody discovers these the hard way.

- **No ESLint.** `typescript-eslint@8` caps at `typescript < 6.1`, and this repo
  runs TypeScript 7. The import-boundary rules that ESLint would have enforced
  live in `rpa validate` instead, which also validates manifests and config —
  so the enforcement exists, just not in your editor's margin. Revisit when
  typescript-eslint supports TS 7.
- **Test coverage is uneven.** The Orchestrator and MFA layers are covered
  thoroughly (auth, retry, error mapping, both queue modes, buckets, the
  SpecificContent round trip, retry ownership against the real runner) and the
  MFA readers are tested against injected fetch/page doubles that never touch a
  network or a mailbox, while the
  browser side is verified by running the two reference automations rather than by
  unit tests. `InMemoryQueueProvider` and `FakeSession` exist in `@rpa/testkit`
  to close that gap when someone wants to.
- **The transaction timeout does not cancel work.** Playwright has no
  cancellation token, so a timeout is a *system* exception whose recovery tears
  the browser down — which is what actually unblocks a stuck call.
- **`sessionKind: "custom"` is not implemented.** Two kinds exist: `browser` and
  `none`. Adding a third means implementing `Session` and extending the enum.
- **Single worker.** The local queue is deliberately single-writer, and
  Orchestrator `odata` mode is too — for the structural reason above.
  Orchestrator `robot` mode has real locking, so it is the one path where
  parallel workers are safe.
- **The Orchestrator layer is untested against a live tenant.** 93 unit tests
  cover it with a mocked `fetch`, and every version-dependent behaviour is
  marked `TODO(orchestrator):`. Nothing has run against a real Orchestrator yet
  — `rpa orchestrator check` and `ORCH_SMOKE=1 pnpm test` are how you find out,
  and they are built for exactly that.

---

## Documentation

- [AGENTS.md](AGENTS.md) — working agreement for AI agents in this repo: the
  non-negotiable rules, repo-specific conventions, and the gotchas that have
  already cost debugging time. Useful for humans onboarding too.
- [docs/architecture.md](docs/architecture.md) — why the repo is shaped this way,
  and which decisions are bets rather than facts
- [docs/authoring-an-automation.md](docs/authoring-an-automation.md) — the guide
  for automation authors
- [docs/migrating-from-uipath.md](docs/migrating-from-uipath.md) — porting a
  REFramework process, step by step
- [docs/claude-play-route.md](docs/claude-play-route.md) — **read this before
  reaching for a live AI agent instead of a deterministic script.** Why the
  Claude + Playwright agentic route was not approved for BenOps/benefits (PHI,
  no safe retry, non-deterministic behavior on an irreversible submit), and
  the two questions that decide whether it is fine elsewhere
- [docs/poc/mfa-gmail.md](docs/poc/mfa-gmail.md) — how a code is read from a
  Gmail label, and the things about Gmail that made it hard: the basic HTML view
  was retired in 2024, `is:unread` cannot be used because the filter marks mail
  read on arrival, and a hash-only navigation never refreshes the SPA.
- [docs/poc/anthem-ca-new-plans/drift-log.md](docs/poc/anthem-ca-new-plans/drift-log.md)
  — **read this before the Anthem runbook.** What the live portal actually does,
  including the 2026-09-03 move to a different platform
- [docs/poc/](docs/poc/) — the two carrier-portal PoCs (Anthem CA, UHC) and
  their sanitized process references
- [docs/operations.md](docs/operations.md) — running, diagnosing and stopping
  automations; exit codes, logs, evidence
- [certs/README.md](certs/README.md) — trusting an internal CA inside the
  container

## First steps for a new clone

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env                                        # then fill it in
pnpm check
pnpm rpa run group-submission/carrier-portal-submission-demo
```

Two things to know about this working copy:

- **`.env` contains saucedemo's public demo credentials** so the reference
  automation runs out of the box. It is gitignored. Real credentials never
  belong in the repo.
- **`certs/corporate-root-ca.crt` is present locally** (gitignored) because this
  network inspects TLS. Regenerate it with
  `./tooling/scripts/export-corporate-ca.sh`, or supply it from your secret
  store in CI.

Then, to point it at your Orchestrator:

```bash
# Fill in organization / tenant / folderId in config/environments/staging.json,
# and set ORCH_CLIENT_ID / ORCH_CLIENT_SECRET / ORCH_ROBOT_KEY in .env
pnpm rpa orchestrator check --env staging --automation group-submission/carrier-portal-submission-demo
```

That command is the honest starting point: `staging.json` and `prod.json` ship
with **placeholder** `organization`, `tenant` and `folderId`, and it will tell
you precisely what is missing rather than failing somewhere less obvious later.
