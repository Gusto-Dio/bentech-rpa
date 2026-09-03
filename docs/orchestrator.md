# UiPath Orchestrator integration

How this platform consumes an existing Orchestrator, so processes can migrate
incrementally instead of in one cutover. The same automation runs against the
local JSON queue in dev and against Orchestrator in staging and production, with
no automation code changing.

## 1. Create the External Application

In Orchestrator: **Admin → External Applications → Add Application**, type
**Confidential application**.

Request these scopes (Application scopes, under Orchestrator):

| Scope | Needed for |
|---|---|
| `OR.Queues` | consuming and dispatching queue items |
| `OR.Assets` | reading assets through `OrchestratorAssetsProvider` |
| `OR.Administration` | **writing** to storage buckets. Reads work without it |

Then assign the application a role on the **folder** your queues live in.
Scopes alone are not enough - without a folder assignment every call returns
403.

The client secret is shown **once**. Put it in your secrets manager;
`ORCH_CLIENT_SECRET` in a local `.env` is for development only.

```bash
pnpm rpa orchestrator check --env staging --automation <domain>/<name>
```

Run that immediately. It reports the resolved API root, the scopes Orchestrator
actually granted (which can be narrower than what you asked for), whether the
folder is reachable, whether the queue resolves, and whether a robot identity is
available.

## 2. Choose a mode

`queue.mode` in `config/environments/<env>.json`.

### `robot` - the REFramework path, recommended

| Operation | Endpoint |
|---|---|
| get next | `POST /odata/Queues/UiPathODataSvc.StartTransaction` |
| success | `SetTransactionResult` with `IsSuccessful: true` |
| business failure | `SetTransactionResult` with `ProcessingException.Type: "BusinessException"` |
| system failure | `SetTransactionResult` with `ProcessingException.Type: "ApplicationException"` |

Orchestrator owns locking, `RetryNumber`, and Auto-Retry. This is the mode that
behaves like the UiPath process you are migrating from.

**Requires an unattended robot identity** (`ORCH_ROBOT_KEY`). A plain External
Application does not have one.

### `odata` - fallback for an external app with no robot

Reads `New` items with an OData filter and reports results through the same
`SetTransactionResult` endpoint.

> **Single-worker only.** Orchestrator's public OData surface exposes no way to
> transition an item to `InProgress` - the documented
> `PUT /odata/QueueItems({Id})` body carries `Name`, `Priority`,
> `SpecificContent`, `Reference` and `Progress`, but not `Status`. So there is
> **no atomic claim**, and two workers would pick up the same item.
>
> What the provider does instead: reads a window of `New` items ordered by
> `CreationTime`, ranks them by priority in code, keeps an in-process set of
> claimed ids, and writes a `SetTransactionProgress` note so a human can see the
> item was picked up. Unique `Reference` is the backstop. None of that makes it
> safe for concurrency.

### Who retries

This is the one thing the runner has to know about the backend.

| Mode | `retryOwner` | Behaviour |
|---|---|---|
| `robot` | `orchestrator` | A system failure is reported **once** as an ApplicationException. Orchestrator's Auto-Retry creates the next attempt. The runner does **not** retry |
| `odata` | `runner` | The runner retries in-process, exactly as with the local queue |

Getting this wrong is expensive: three local attempts against three Orchestrator
retries is **nine real executions** of a submission. So it is enforced, not
documented:

- `rpa validate` fails when `mode: "robot"` is combined with `maxRetries > 0`.
- The runner clamps `maxRetries` to 0 whenever the backend owns retries, which
  also closes the hole where a per-automation `automation.json` override would
  not be visible to config validation.
- A unit test asserts one attempt and no requeue in that mode
  (`packages/core/src/runner/retryOwnership.test.ts`).

UiPath's own guidance for REFramework against an Auto-Retry queue is
`MaxRetryNumber = 0`. This is the same rule, made impossible to forget.

## 3. Payloads: `SpecificContent`

Orchestrator's `SpecificContent` is a `Dictionary(Of String, Object)`, and
UiPath recommends storing **only primitives** - Number, Boolean, String,
DateTime. Nested objects and arrays have to be serialised.

So non-primitives are JSON-encoded, and the encoded keys are listed in a
`__jsonFields` companion key:

```
groupId        : "GRP-8842"                        <- primitive, untouched
groupName      : "Northwind Test Bakery"
contact        : "{\"firstName\":\"Ada\", ...}"    <- JSON-encoded
requestedPlans : "[\"Sauce Labs Backpack\", ...]"  <- JSON-encoded
__jsonFields   : "[\"contact\",\"requestedPlans\"]"
```

The round trip is lossless, including deep nesting and mixed arrays. Decoding
tolerates hand-edited items: a broken JSON value is passed through as a string
rather than failing the transaction.

If existing Studio processes need to read fields directly - `SpecificContent("contact_firstName")` -
a `flattened` encoder is the change to make, in
`packages/core/src/orchestrator/specificContent.ts`. It is not built, because it
is lossy for ragged arrays.

### Sensitive payloads

Orchestrator can **encrypt Specific Data and Output at rest with AES-256**, set
per queue at creation time (it cannot be changed afterwards). Turn it on for any
queue whose payload carries member or employee data, and note that encrypted
fields are not filterable or visible in the UI - which is the point.

The framework helps but does not substitute for that: exception `details`
objects are deliberately **not** sent to Orchestrator, because they can carry
payload fields. Only the message, name and stack go into
`ProcessingException.Details`.

## 4. Secrets, and the credential-password caveat

`ctx.secrets` resolves through a `SecretProvider` chain: environment variables
first, then Orchestrator assets. A developer's `.env` therefore overrides the
tenant, while a deployed run with no `.env` falls through to Orchestrator.

Reading a plain asset works with `OR.Assets`:

```ts
const batchSize = await ctx.secrets.require('BatchSize');   // Text/Integer/Bool asset
```

**Credential assets are different.** The generic `GET /odata/Assets` endpoint
returns `CredentialPassword: null` by design - Orchestrator only releases a
credential password under **robot context**. So:

- `secrets.requireCredential(name)` uses the robot-scoped endpoint and requires
  `ORCH_ROBOT_KEY`.
- Without a robot identity it throws a `SystemException` that says exactly that,
  rather than handing back an empty password that fails later inside a portal
  login.
- Calling plain `get()` on a Credential asset also throws, instead of silently
  returning just the username.

**Recommendation: do not depend on Credential assets for sensitive secrets.** Use
an external secrets manager behind the same `SecretProvider` interface - it is
one class and one line of wiring, and it removes the robot-context constraint
entirely. The interface exists for exactly this swap.

## 5. Storage buckets

Two steps in both directions, because Orchestrator does not proxy the bytes:

1. `GET /odata/Buckets({id})/UiPath.Server.Configuration.OData.GetWriteUri?path=…&contentType=…`
   returns a short-lived signed `Uri` plus the `Verb` to use.
2. The transfer goes **directly** to that URI - with no Orchestrator
   `Authorization` header, since the URI is already signed and an extra auth
   header invalidates the signature on some storage backends.

`GetReadUri` is symmetric. Writes need `OR.Administration`.

```ts
const buckets = new BucketClient({ client, logger });
await buckets.uploadFile('evidence', `runs/${runId}/screenshot.png`, localPath);
```

A natural follow-on, not built: shipping the artifacts of a failed run to a
bucket automatically, which is one `uploadFile` call in the runner's failure path.

## 6. Environment variables

| Variable | Purpose |
|---|---|
| `ORCH_CLIENT_ID` | External Application client id |
| `ORCH_CLIENT_SECRET` | External Application client secret |
| `ORCH_ROBOT_KEY` | Unattended robot key. Required for `robot` mode and for credential assets |
| `QUEUE_PROVIDER` | `local` \| `orchestrator`, overriding environment config |
| `QUEUE_MODE` | `robot` \| `odata` |

Only the **names** live in config; the values come from the environment or a
secrets manager. Smoke-test variables (`ORCH_SMOKE`, `ORCH_BASE_URL`,
`ORCH_ORGANIZATION`, `ORCH_TENANT`, `ORCH_FOLDER_ID`, `ORCH_QUEUE_NAME`,
`ORCH_BUCKET_NAME`) are documented in `.env.example`.

## 7. Running it

```bash
pnpm rpa orchestrator check --env staging --automation <id>   # do this first
pnpm rpa queue <id> --env staging                             # counts from Orchestrator
pnpm rpa queue <id> --env staging --push-seed                 # dispatch synthetic items
pnpm rpa run <id> --provider orchestrator --env staging
```

`--reset` is deliberately **refused** for an Orchestrator queue. Re-seeding a
shared queue is not something a CLI flag should do; `--push-seed` is additive
and safe.

## 8. Sandbox smoke test

```bash
ORCH_SMOKE=1 ORCH_BASE_URL=https://cloud.uipath.com \
ORCH_ORGANIZATION=… ORCH_TENANT=… ORCH_FOLDER_ID=… \
ORCH_CLIENT_ID=… ORCH_CLIENT_SECRET=… ORCH_QUEUE_NAME=… \
[ORCH_ROBOT_KEY=…] [ORCH_BUCKET_NAME=…] \
pnpm test
```

Authenticates, dispatches a synthetic item, claims it, completes it, and
round-trips a file through a bucket. Everything it writes is marked
`SMOKE-<timestamp>` and safe to delete. Without `ORCH_SMOKE=1` it skips and the
rest of the suite is unaffected; with it set but variables missing, it fails with
one message naming exactly what is absent.

## 9. Version-dependent behaviour

```bash
grep -rn "TODO(orchestrator)" packages/
```

Each marker is a behaviour that has moved between Orchestrator releases. They
are the punch list to walk through against your sandbox:

| Marker | What to confirm |
|---|---|
| `StartTransaction` empty response | 204, 200-with-empty-body, or 200 with no `Id`. All three are handled as "no work" |
| `RobotIdentifier` in `transactionData` | whether an External Application may supply it, or a real robot identity is required |
| duplicate-reference `errorCode` | `1002` is assumed; the 409 status mapping already covers it either way |
| folder header | `X-UIPATH-OrganizationUnitId` vs `X-UIPATH-FolderPath-Encoded`, and the exact path encoding |
| `GetRobotAssetByNameForRobotKey` | the robot-scoped asset operation name |
| bucket `Headers` shape | plain object vs parallel `{ Keys, Values }` arrays. Both handled |
| queue-item status transition | if your version exposes one, `odata` mode becomes concurrency-safe |
| `$apply`/`groupby` on QueueItems | would collapse six `$count` calls in `stats()` into one |
