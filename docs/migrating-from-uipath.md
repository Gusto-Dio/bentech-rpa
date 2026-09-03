# Migrating a REFramework process

A mechanical mapping, in the order you should do it.

## 0. Before anything

The resilience contract you are relying on already exists here — state machine,
queue, business/system split, retry with recovery, per-transaction logging. You
are porting *your process*, not rebuilding the framework. If you find yourself
writing retry logic, stop: it is already in the runner.

## 1. Scaffold the target

```bash
pnpm rpa new automation --id <domain>/<name> --owner @team --kind browser
```

Pick `--kind api` if the UiPath process had no UI automation in it (Excel, mail,
database, API work). Skipping the browser is a real saving, not a shortcut.

## 2. Port `Config.xlsx`

| Config sheet | Goes to |
|---|---|
| **Settings** — anything environment-specific | `config/config.<env>.json` under the `automation` key, with a Zod schema in `src/config.ts` |
| **Constants** — anything invariant | Same place, or a `const` in the automation if it never varies |
| **Assets** — credentials | The *name* of an env var in config; the value via `ctx.secrets.require(name)` |

Platform-wide knobs — `MaxRetryNumber`, timeouts, log level — are already in
`config/platform.json`. Do not re-declare them per automation. Override
`maxRetries` for a single automation in its manifest's `queue.maxRetries`.

There is no untyped `Settings("SomeKey")` bag here on purpose: declare the
schema, and a missing setting fails at Initialize with the key named, rather
than surfacing as `undefined` in transaction 40.

## 3. Port the queue

| UiPath | Here |
|---|---|
| Orchestrator queue | `queue.name` in `automation.json` |
| `SpecificContent` | `payload`, with a Zod schema in `src/payload.ts` |
| `Reference` | `reference` — used in logs and artifact paths, so make it meaningful |
| `Priority` | `priority`: `high` \| `normal` \| `low` |
| `RetryNo` | `retryCount`, managed by the runner |

Write synthetic seed items in `data/seed/queue.json` covering your real outcome
cases. **Do not export production queue items into this repo** — they contain
real member and group data. Invent equivalents.

## 4. Port `InitAllApplications`

Into `initialize()`. Sign-in goes here, not in the session class.

It **must be idempotent**: the runner re-invokes it after every session
recovery, exactly as REFramework re-invokes `InitAllApplications`. That is not a
new constraint — it is the same one, made explicit.

`CloseAllApplications` and `KillAllProcesses` have no equivalent to write:
`session.close()` and `session.recover()` are the framework's job.

## 5. Port `Process.xaml`

Into `processTransaction()`. The mapping is direct, with three things to watch:

1. **Every `Throw` of a `BusinessRuleException` becomes
   `throw new BusinessException(...)`.** Everything else can simply throw.
2. **Selectors become page objects.** A UiPath selector
   (`<html app='chrome' /><webctrl id='login-button' />`) becomes
   `getByRole('button', { name: 'Login' })` in `src/pages/`. Resist a
   one-to-one translation into CSS: role- and text-based locators are what make
   this more robust than what you had.
3. **Start from a known page.** UiPath processes often relied on the browser
   being wherever the last transaction left it. Navigate explicitly at the top
   of every transaction.

`RetryScope` around a flaky activity becomes `withRetry()`. Do not convert it
into transaction-level retries — those relaunch the whole browser.

## 6. Port `EndProcess`

Into `endProcess()`. The framework already closes the browser, writes
`run-summary.json` and logs the totals, so this is only for your own finishing
work: a notification, an outbound report, a required sign-out.

## 7. Things that have no equivalent, and why

| UiPath | Status here |
|---|---|
| `Invoke Workflow File` | Just call a function. The `.xaml` indirection was a UI limitation |
| Arguments in/out (`in_`, `out_`, `io_`) | Function parameters and return values |
| `Log Message` | `ctx.logger.info({ structured: 'fields' }, 'message')` — always structured, never string concatenation |
| `Delay` | Almost always wrong. Playwright auto-waits; use `waitFor` on the thing you actually need |
| `Element Exists` + `If` | `await locator.isVisible().catch(() => false)` |
| Screenshot on error | Automatic. Do not write it |
| Orchestrator retry item | The runner retries in place; `queue.requeue()` records the attempt |
| Attended/unattended distinction | Everything here is unattended |

## 8. Verify the port

Run it and compare against the UiPath process's behaviour on the same synthetic
cases:

```bash
pnpm check
HEADLESS=false LOG_PRETTY=true pnpm rpa run <domain>/<name>
```

You should be able to state, for each seeded transaction, why it ended
`SUCCESS`, `BUSINESS_EXCEPTION` or `SYSTEM_EXCEPTION`. If a transaction you
expected to be a business failure came back as a system failure, you have found
a real classification bug — that is the most valuable thing this exercise
produces.
