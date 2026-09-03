# Authoring an automation

## 1. Scaffold it

```bash
pnpm rpa new automation \
  --id group-submission/carrier-eligibility-sync \
  --title "Carrier Eligibility Sync" \
  --owner @gusto/benefits-rpa-group-submission \
  --kind browser        # or --kind api for no browser at all

pnpm install
pnpm rpa validate
```

Never create one by copying a sibling. That is how manifests keep the wrong
`id`, how two automations end up sharing a queue and silently stealing each
other's work, and how a pattern you deprecated last quarter is still being
propagated.

If the domain does not exist yet:

```bash
pnpm rpa new domain --name <domain> --owner @team
# then add it to CODEOWNERS
```

## 2. What you get

```
automations/<domain>/<name>/
├─ automation.json        the manifest - id, owners, criticality, queue, schedule
├─ config/config.dev.json your settings. Secret NAMES only, never values
├─ src/
│  ├─ index.ts            defineAutomation / defineWebAutomation
│  ├─ config.ts           Zod schema for your settings
│  ├─ payload.ts          Zod schema for a queue item. Invalid -> BusinessException
│  ├─ initialize.ts       InitAllSettings + InitAllApplications
│  ├─ processTransaction.ts
│  ├─ endProcess.ts
│  └─ pages/              every selector, and nowhere else
└─ data/seed/queue.json   synthetic transactions
```

## 3. The one rule that matters most

Get the exception type right. Everything else the framework does follows from it.

```ts
// BUSINESS: the data or the rules say no.
// Retrying produces the identical answer.
throw new BusinessException('Plan code MED-PPO-9999 is not in the carrier catalog');
// -> marked failed, NO retry, run continues immediately with the next item

// SYSTEM: the environment misbehaved. A retry might work.
throw new SystemException('Portal did not acknowledge the submission');
// -> screenshot + trace, session torn down and relaunched, initialize() re-run,
//    SAME transaction retried up to maxRetries
```

**Anything you do not catch is treated as a system failure**, including
Playwright's `TimeoutError`. So you only ever need to be explicit about the
business cases; the framework's default is the safe one.

Getting it backwards has real costs:

| Mistake | Cost |
|---|---|
| Business failure thrown as System | Three browser relaunches and three identical failures, per item. On a 5,000-item queue that is hours |
| System failure thrown as Business | Work is silently abandoned. A portal blip becomes "this group was rejected", and nobody retries it |

When in doubt: *would running this again, on a fresh browser, plausibly give a
different answer?* Yes → System. No → Business.

## 4. `initialize()` must be idempotent

It runs once at startup **and again after every session recovery**. A recovered
browser is a brand new browser with no cookies, so a UI automation has to sign
in again.

```ts
export async function initialize(ctx: WebInitContext<AutomationConfig>): Promise<void> {
  const username = await ctx.secrets.require(ctx.config.automation.usernameEnv);
  const password = await ctx.secrets.require(ctx.config.automation.passwordEnv);

  const login = new PortalLoginPage(ctx.page);
  await login.open(ctx.config.automation.portalUrl);
  await login.signIn(username, password);
}
```

If `initialize()` assumes it runs only once, the first retry executes against a
signed-out portal and fails for a completely different reason than the original
error — which is maddening to debug from artifacts the next morning.

Load reference data here too, not in `processTransaction`. With 10,000 items in
the queue that is the difference between one file read and ten thousand. Cache
it in `ctx.state`.

## 5. Every transaction starts from a known state

This one is worth stating plainly because it is the most common bug in
queue-driven automation:

```ts
// Start from a known page, every time. The previous transaction finished on the
// confirmation screen, and a retry may have left a half-built draft behind.
await catalog.open(ctx.config.automation.portalUrl);
await catalog.resetDraftSubmission();
```

An automation that works perfectly for item 1 and fails for item 2 is almost
always inheriting state — a page, a cart, a filter, a modal — from the previous
transaction.

## 6. Selectors

Most resilient first:

1. `getByRole` — survives styling and DOM restructuring
2. `getByLabel` / `getByPlaceholder` — tied to visible text
3. `getByTestId` — only if the app ships stable test attributes
4. CSS — last resort, **and only inside a page object**

**No XPath anywhere.**

All of them live in `src/pages/`. When a vendor redesigns their portal the blast
radius is one directory, which is also exactly where an auto-healing layer would
attach — mark those spots with `// AUTO-HEALING SEAM:` and describe what a
fallback would need to find. Such a fallback runs *after* the deterministic
locator fails, never instead of it.

Matching either of two selectors is a legitimate hedge when a vendor is
mid-migration:

```ts
this.#page.locator('[data-test="inventory-item"], .inventory_item')
```

## 7. Retry one action, not the transaction

```ts
const plans = await withRetry(() => catalog.listAvailablePlans(), {
  attempts: 3,
  label: 'read carrier plan catalog',
  logger: ctx.logger,
  abortSignal: ctx.stop.abortSignal,
});
```

This is REFramework's `RetryScope`. Use it for one genuinely flaky step: it
costs a few seconds, versus a transaction-level retry which tears down and
relaunches the entire browser. `withRetry` never retries a `BusinessException`.

## 8. Data rules — not negotiable

**No real member, group, employee or customer data anywhere in this repository.**
Not in seed files, not in fixtures, not in examples, not in a comment.

- Seed payloads use obviously fake identifiers: `GRP-8842`, `MBR-000123`,
  `Northwind Test Bakery`.
- Carry **references, not records**. The `member-submission` demo payload has
  `memberRef` and nothing else — no name, no date of birth, no SSN, no wage —
  because validating an election against a plan catalog does not need them.
  Where a downstream system needs those fields, it looks them up by reference.
- **No secrets in config.** Config holds the *name* of an environment variable;
  `ctx.secrets.require(name)` resolves the value. That indirection is why no
  config file in this repo is sensitive, and it is the seam a real vault plugs
  into.
- Logs are redacted on the obvious fields (`REDACT_PATHS` in
  `packages/core/src/logger.ts`), but redaction is a safety net, not a licence.
  If you add a payload field that is sensitive, add its path there — and first
  ask whether the automation needs it at all.

## 9. Before you open a PR

```bash
pnpm check          # typecheck + rpa validate
pnpm rpa run <id>   # actually run it
```

`rpa validate` will fail on a manifest that does not match its folder, a
duplicate queue name, a cross-domain import, a deep import into core, a config
that does not satisfy your own schema, or a module that does not export a valid
automation.

Then read the artifacts of your own failure cases in
`artifacts/<runId>/<reference>-attempt-N/`. If the screenshot and `error.json`
would not tell you what went wrong at 03:00, add `details` to the exception:

```ts
throw new BusinessException(`Carrier does not offer: ${missing.join(', ')}`, {
  details: { groupId, missing, availablePlans },   // no PII, no secrets
});
```
