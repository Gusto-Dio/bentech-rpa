# Architecture

## The problem this shape solves

The interesting constraint is not "reproduce REFramework once". It is:

> What structure lets 100+ automations, owned by different teams, share one
> resilient core without drifting into 100 forks of it?

Everything below follows from that question.

## Three layers, hard boundaries

```
packages/      CORE         platform team    one version, no forks
automations/   PROCESSES    domain teams     consume core's public API only
templates/     SCAFFOLDS    platform team    how automation #101 gets created
```

The boundaries are enforced by `rpa validate`, not by convention:

- An automation may import `@rpa/core`, its **own** `@auto/<domain>-shared`,
  `node:*`, `zod`, `playwright`. Nothing else.
- No deep imports into core internals.
- No relative import escaping the automation's own folder.
- `packages/` never imports `automations/`.

Without mechanical enforcement, the failure mode is predictable: at roughly
thirty automations someone imports a helper from a neighbour, that neighbour
gets rewritten, and two teams are now coupled through a file neither of them
considers public API.

## Grouping by process type, not by org chart

Automations live under `automations/<domain>/<name>/`, where domain is a process
type — `group-submission`, `member-submission`, `advising`.

The bet: automations cluster by the *workflow* they perform and the *systems*
they touch, which is what actually drives shared page objects and shared
business rules. Org charts reorganise; the fact that twelve automations sign in
to the same carrier portal does not.

The org-chart dimension is carried separately, in the manifest's `owners` field
and in `CODEOWNERS`. So a team reorganisation edits ownership metadata, not the
folder tree.

**If this bet is wrong** — if a domain's automations turn out to hit five
unrelated systems with nothing in common — its `_shared` package earns its keep
less and the grouping is mostly cosmetic. Re-slicing is cheap: the manifest `id`
is the only thing that encodes the path.

## `_shared` per domain, not one global `shared/`

Twelve `group-submission` automations hitting the same portal share one page
object in `automations/group-submission/_shared`. `member-submission` cannot
import it, by design.

A single global `shared/` becomes a dumping ground owned by nobody, and every
change to it risks every automation in the repo.

## One core version

Automations depend on `"@rpa/core": "workspace:*"`. There is exactly one core at
any commit.

- **Upside:** a resilience bug is fixed once, for all automations. There is no
  such thing as an automation running last year's retry logic.
- **Cost:** a breaking core change must touch every automation in one PR.

That cost is accepted deliberately, and paid with a codemod plus a deprecation
window. The alternative — publish `@rpa/core` and let each automation pin a
version — produces dozens of live core versions within a year, which is the
exact drift this structure exists to prevent.

`instanceof BusinessException` is sound *because* of this invariant: there is
one class identity in the process. If core is ever published and pinned per
automation, that check needs a `Symbol.for()` brand instead.

## The manifest is the keystone

`automation.json` is what makes a large tree governable rather than merely
large. One file, read by:

| Reader | Fields |
|---|---|
| `rpa list` / `rpa run` | `id`, `name`, `entry`, `sessionKind`, `queue` |
| CI validation | all of them, plus location cross-checks |
| Alert routing (future) | `owners`, `criticality` |
| Scheduler (future) | `schedule.cron`, `schedule.timezone` |
| Generated docs (future) | `description`, `tags`, `domain` |

Adding a field is how the platform grows a capability across every automation at
once, instead of through 100 copy-paste edits.

Discovery is a filesystem walk over these manifests — deliberately not a
generated, committed registry file, which at this scale would be a permanent
merge-conflict magnet because every new automation would touch the same lines.

## No build step

Workspace packages export their TypeScript sources directly
(`"exports": { ".": "./src/index.ts" }`) and everything runs through `tsx`.
`tsc` is used only for typechecking (`noEmit`).

This trades a small startup cost for the removal of an entire class of
"works on my Mac" problems: there is no compiled artifact that could have been
built on the wrong platform, no `dist/` that could be stale, and no dual
resolution between source and build output. Adding a compile step later is
contained: point `exports` at `dist`, add a build, and change nothing else —
relative imports already carry explicit extensions.

## Config: five layers

```
1. DEFAULT_PLATFORM_CONFIG            (code)
2. config/platform.json               (platform-wide)
3. config/environments/<APP_ENV>.json (per environment)
4. <automation>/config/config.<env>.json
5. environment variables              (per run / per container)
```

Layer 5 is what makes the one-image promise hold: the same artifact runs in
every environment, differing only by environment variables.

Two details worth knowing:

- **Schemas are strict.** A misspelled setting is a startup error, not a
  silently ignored line. `$comment` keys are stripped during load so the JSON
  layers can still document themselves.
- **Defaults are a plain typed constant, not Zod `.default()`.** Zod 3 and Zod 4
  disagree about whether `.default()` takes the input or the output type, and a
  config loader that breaks on a dependency bump would break all 100+
  automations simultaneously. For the same reason, validation errors are
  formatted from `error.issues` by hand rather than through version-specific
  helpers.

## Sessions are a capability

`sessionKind: "browser" | "none"`. A file or API automation launches no browser
at all.

Evidence capture is a separate, optional interface (`EvidenceCapableSession`):
the artifact store asks whether a session can screenshot rather than assuming
it can.

The two context flavours — `InitContext`/`TxContext` and
`WebInitContext`/`WebTxContext` — exist so that a UI automation never writes
`ctx.page!` and a file automation cannot reach for a page that was never
launched. The single unsound cast this requires lives in `runner.ts`, once, and
`page` is exposed there as a *getter* because after `session.recover()` the Page
object is a different instance.

## Deployment: one image, N automations

`rpa run <id>` selects the process at start. This mirrors UiPath — one robot
runtime, many processes — so ops intuition transfers, and patching a Chromium
CVE is one rebuild instead of a hundred.

The trade-off is that all automations share one dependency set and roll forward
together. A manifest escape hatch (`"image": "custom"`) is the documented answer
for an automation with genuinely exotic dependencies; it is not built yet.

## What is deliberately absent

- **No orchestration.** `schedule` is declared, not executed.
- **No real queue backend.** `QueueProvider` is the seam.
- **No vault.** `SecretProvider` is the seam.
- **No audit store.** `AuditSink` is the seam, and already emits everything.
- **No multi-worker parallelism.** The local queue is single-writer on purpose.

Each is one class plus one line of wiring, because the interfaces exist and the
runner talks only to them.
