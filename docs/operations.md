# Operations

## Running an automation

```bash
pnpm rpa run <automation-id>                      # local
docker compose run --rm rpa <automation-id>        # as the servers do
docker run --rm --shm-size=1g \
  -e APP_ENV=prod -e AUTOMATION_ID=<id> \
  -v "$PWD/data:/app/data" -v "$PWD/artifacts:/app/artifacts" \
  bentech-rpa:1.0.0
```

## Exit codes — the contract with whatever schedules this

| Code | Meaning | What to do |
|---|---|---|
| `0` | Everything terminal, no system failures. Business failures are a **normal** outcome | Nothing |
| `1` | At least one transaction exhausted its retries | Look at `artifacts/<runId>/`; the queue has `failed` items |
| `2` | Initialize failed. **No transaction was touched** | Credentials, config or the target system. Safe to re-run once fixed |
| `3` | Circuit breaker: too many consecutive system failures | The target system is probably down. Do not re-run until it is back |

The distinction between `2` and `3` matters when you automate the response:
exit `2` means nothing happened, so a retry is free; exit `3` means the run
stopped part-way deliberately.

Exit `1` is **not** an alert on its own. A queue where 5% of transactions fail
business rules and exits `0` is healthy; a queue where one transaction exhausts
its retries and exits `1` needs a look.

## Reading the logs

JSON on stdout, one object per line. Every line carries `runId`,
`automationId`, `domain`, `env`; transaction lines add `transactionId`,
`reference`, `attempt`, `retry`.

The field to filter on is `status`:

| `status` | Meaning |
|---|---|
| `SUCCESS` | Transaction completed |
| `BUSINESS_EXCEPTION` | Rule violated. Terminal, never retried |
| `SYSTEM_EXCEPTION_RETRY` | Failed, session being recovered, will retry |
| `SYSTEM_EXCEPTION` | Failed and out of retries. Terminal |
| `INIT_FAILED` | Initialize failed; no transaction ran |
| `ABORTED_UNSTABLE` | Circuit breaker tripped |
| `END_PROCESS_FAILED` | The automation's own `endProcess()` threw |

```bash
# What failed, and why
pnpm rpa run <id> | jq -c 'select(.status) | {reference, attempt, status, msg}'

# The audit stream on its own
pnpm rpa run <id> | jq -c 'select(.audit) | {type, reference, attempt}'
```

`LOG_PRETTY=true` gives human-readable output for a developer machine.
Production keeps JSON so the log pipeline can parse it.

**Logs are redacted** on password, token, secret, authorization, ssn, dob,
account and routing fields. If you add a sensitive payload field, add its path
to `REDACT_PATHS` in `packages/core/src/logger.ts`.

## Evidence

```
artifacts/<runId>/
├─ run-summary.json                     totals, timings, outcome
├─ SUB-1002-attempt-1/
│  ├─ error.json                        name, message, reason, stack, details
│  └─ screenshot.png                    business failure: screenshot only
└─ SUB-1004-attempt-3/
   ├─ error.json
   ├─ screenshot.png
   └─ trace.zip                         system failure: full Playwright trace
```

```bash
pnpm exec playwright show-trace artifacts/<runId>/<ref>-attempt-N/trace.zip
```

The trace is a complete replay — every action, network request, console message
and a DOM snapshot per step. It is the difference between diagnosing a 03:00
failure and re-running it to watch.

Traces are kept for **system** failures only. A business failure's screenshot
plus `error.json` already answer "why did it decline this one", and a few
megabytes per transaction across 100 automations on a schedule would fill a disk
for no diagnostic gain. Set `keepArtifactsOnSuccess: true` while debugging to
keep successful traces too.

## Stopping a run

`SIGINT` or `SIGTERM` requests a **graceful** stop: the transaction in flight
finishes, then the run exits through EndProcess so the browser closes and the
queue is left in a defensible state. A second signal exits immediately.

```bash
docker compose stop rpa      # sends SIGTERM
```

This is why `init: true` is set in compose. Without an init process, the signal
never reaches the runner and the browser is orphaned mid-transaction.

Give it a grace period longer than one transaction. `terminationGracePeriodSeconds`
on a Kubernetes Job should exceed `transactionTimeoutMs`.

## The queue

```bash
pnpm rpa queue <id>            # counts by status
pnpm rpa queue <id> --reset    # re-seed from data/seed/queue.json
```

State lives in `data/queue.<queue-name>.json`, written atomically. It is
readable and hand-editable, which is deliberate: during a migration that is
worth more than transactional throughput.

### `abandoned` items

An item left `inProgress` means a previous run died mid-transaction, so the
target system may be **half-updated**. On the next `init()` those items are
marked `abandoned` and **not replayed**.

That is the same call Orchestrator makes, for the same reason: re-submitting a
group that actually went through is worse than needing a human to check. To
replay one deliberately, edit its `status` back to `"new"` in the queue file —
after confirming it did not land.

## Diagnosing

```bash
pnpm rpa doctor      # node version, browsers, credentials, writable dirs, registry
pnpm rpa validate    # manifests, boundaries, config, loadability
```

| Symptom | Usual cause |
|---|---|
| `Executable doesn't exist` at launch | Browsers not installed. macOS: `pnpm exec playwright install chromium`. Ubuntu: add `--with-deps` |
| Chromium crashes on content-heavy pages | `/dev/shm` too small. `--shm-size=1g`, or `shm_size: 1gb` in compose |
| Works on macOS, fails on Ubuntu with a missing module | Case-sensitivity. `pnpm typecheck` catches it via `forceConsistentCasingInFileNames` |
| `Running as root without --no-sandbox` | Run as non-root (`pwuser`, the image default) rather than setting `CHROMIUM_NO_SANDBOX` |
| Everything is a `SYSTEM_EXCEPTION` after the first item | The automation is inheriting page state between transactions. Navigate explicitly at the top of each one |
| Retries fail differently from the original error | `initialize()` is not idempotent — the retry ran against a signed-out session |
| `Secret "X" is not available` | Missing env var. `rpa doctor` checks for `.env`; the name comes from the automation's config |
| `ERR_CERT_AUTHORITY_INVALID`, container only | A TLS-inspecting proxy whose CA the container does not trust. See below |

### `ERR_CERT_AUTHORITY_INVALID` in the container but not on the Mac

A Zero Trust proxy (Cloudflare WARP, Zscaler, Netskope) is re-signing TLS with
an internal CA that your Mac trusts via its MDM profile and the container does
not.

```bash
./tooling/scripts/export-corporate-ca.sh
docker compose build
```

Three separate trust stores are involved, and this is where the time goes:

```bash
# 1. openssl / curl - the system store
docker run --rm --entrypoint bash bentech-rpa:local -c \
  "echo | openssl s_client -connect <host>:443 -servername <host> 2>/dev/null | grep 'Verify return'"

# 2. Node's HTTPS client - its own bundled list, hence NODE_EXTRA_CA_CERTS
# 3. Chromium - NSS, NOT /etc/ssl/certs
docker run --rm --entrypoint bash bentech-rpa:local -c \
  "certutil -d sql:\$HOME/.pki/nssdb -L"
```

Store 1 passing while store 3 is empty is the trap: `Verify return code: 0`
looks like success, and the browser still fails. All three are configured in the
Dockerfile; if the browser alone fails, check the `certutil -L` output.

## Running a carrier automation in the container

Every automation runs headless, except the ones a carrier will not let run
headless. **Anthem's broker portal serves `Access Denied` to headless Chromium**
and loads normally headed — bot protection, not a bug — so the automation that
most needs to be unattended is the one that cannot be headless.

A container has no display, which used to leave the Ubuntu runtime with no
working path at all. The image now installs **xvfb**, and the entrypoint starts a
virtual display only when a run asks for a headed browser:

```bash
# Everything else - headless, the default
docker compose run --rm rpa group-submission/carrier-portal-submission-demo

# Anthem - headed, on a virtual display the entrypoint supplies
HEADLESS=false docker compose run --rm rpa group-submission/anthem-ca-new-plans
```

Nothing else changes: `HEADLESS=false` with no `DISPLAY` on Linux is what
triggers it. If `DISPLAY` is already set — a real X socket mounted in, or a
remote server — that is respected instead of being shadowed.

> **Two things that catch people out.**
>
> **Compose reads the project `.env` for its own interpolation**, so
> `HEADLESS: ${HEADLESS:-true}` resolves to `false` on any machine whose `.env`
> sets `HEADLESS=false` — which a developer's does. The container is then headed
> without anyone asking. Harmless locally, but on a server pass `HEADLESS`
> explicitly rather than relying on the default.
>
> **Overriding the entrypoint loses the display.** `--entrypoint pnpm` skips the
> script that starts xvfb, so a headed command silently gets the 403 instead.
> Use `--entrypoint tooling/docker/with-display.sh` and put the real command
> after the service name — that is exactly why the display logic is its own
> wrapper rather than living inside `entrypoint.sh`.

### Prove the runtime before trusting it

`rpa doctor` tells you Chromium starts. It cannot tell you the **carrier** will
accept it, and that is the part that breaks:

```bash
docker compose run --rm -e HEADLESS=false \
  --entrypoint tooling/docker/with-display.sh rpa \
  pnpm tsx tooling/scripts/check-portal-access.ts
```

Credential-free and read-only: it loads the login page and reports what came
back. Measured on the host — headless returns **403 Access Denied** with an
Akamai reference, headed returns **200 Producer Toolbox** with the sign-in field
present. Run it after any base-image bump, because this is exactly the kind of
thing a Chromium upgrade changes silently.

`rpa doctor` also now fails, rather than warning, when `HEADLESS=false` is set on
Linux with neither a `DISPLAY` nor `xvfb-run` — that combination cannot start a
browser, and it is worth saying so before a run finds out.

### What the container still needs from outside

| | |
|---|---|
| **Credentials** | Environment variables only, never baked into the image. `docker-compose.yml` reads `.env` if present, so a server that injects real env vars needs no file |
| **MFA** | Use `mfa.provider: "imap"`. The Gmail UI providers drive a browser profile a human signed in to, which does not survive a container. IMAP needs no browser |
| **`./data`** | Mounted, and it matters: `data/sessions/` is how a portal session is reused between runs. Without it every run signs in again and spends an MFA code |
| **`./artifacts`** | Mounted, or the evidence for a failed run disappears with the container |
| **`shm_size`** | 1GB. Chromium crashes on content-heavy pages with Docker's 64MB default |
| **uid** | On a host whose deploy user is not uid 1000, the mounts are unwritable by the image's `pwuser`. Match the host uid rather than running as root — see the commented `user:` line in the compose file |

### Still open

- **Anything past `Create Quote` is unproven in a container.** Sign-in and
  reaching the quoting platform are proven — `check-portal-navigation.ts` does
  both and creates nothing. One container run reusing a host-created session hit
  an Okta SAML password challenge on the `Create Quote` hop; the container is not
  the variable (it does the SAML hand-off fine via the launchpad tile), so the
  route is. Confirming needs a write, which the production freeze forbids.
- **Architecture.** Build explicitly for the servers with
  `docker buildx build --platform linux/amd64`, which cross-builds slowly on
  Apple Silicon. That is the price of not shipping an arm64 image to an x86_64
  host.
- **Headed is heavier.** A headed Chromium on a virtual display costs more CPU
  and memory than headless. Size the host accordingly; this has not been load
  tested with concurrent runs.
- **The queue is single-writer.** Two containers running the same automation
  against the local JSON queue will fight. Parallelism needs the Orchestrator
  backend, which is unit-tested but never validated against a live tenant.

## Scheduling automations (still not built)

`automation.json` declares `schedule.cron` and `schedule.timezone`; nothing
reads them at runtime. Until an orchestrator exists, one Kubernetes `CronJob`
(or one cron line) per automation, using the manifest's schedule as the source
of truth:

```bash
pnpm rpa list --json | jq -r '.automations[] | select(.schedule) | "\(.schedule.cron)  \(.id)"'
```

The sentinel below has its own scheduler and deliberately does **not** use that
block — see AGENTS.md's amended "Deliberately absent" entry. It never runs an
automation, which is the point.

## The portal sentinel

`rpa sentinel` watches a carrier portal for two different things:

- **failure** — a probe could not do what it set out to do;
- **drift** — a probe succeeded, but the screen is not the screen we recorded.

Drift is the half that pays for the arrangement: a field renamed today breaks a
run next week, and catching it while the probe still passes is the difference
between a scheduled fix and an incident.

### The probes, and what each costs

| Probe | Credentials | MFA | Answers |
|---|---|---|---|
| `anthem-ca/portal-access` | none | never | does the carrier serve a login page to this runtime, headed, through the corporate CA? |
| `anthem-ca/portal-session` | cookies only | never | is the stored session still accepted? This is the input to every MFA decision |
| `anthem-ca/portal-navigation` | yes | ≤1/day | does sign-in work, and does the SAML hop reach the quoting platform? |

`portal-navigation` uses the `Small Group Quote & Enroll` launchpad tile, which
performs the same SAML hand-off as `Create Quote` but lands on the platform home
— verified to create no account, no quote and no application. `Create Quote` is
the step that starts writing and is deliberately never touched.

### Running it by hand

```bash
pnpm rpa sentinel --list
pnpm rpa sentinel anthem-ca/portal-access          # dry run is the DEFAULT
pnpm rpa sentinel --set access --file-issues       # actually file
pnpm rpa sentinel anthem-ca/portal-access --bless --note "first baseline, headed, container"
```

The positional argument is a **probe id, never an automation id** —
`rpa sentinel group-submission/anthem-ca-new-plans` does not resolve, and says
why. That is one keystroke from the forbidden `rpa run …`.

### Exit codes

Its own taxonomy, and a scheduler should not treat every non-zero the same:

| Code | Means |
|---|---|
| `0` | every probe passed and every screen matched its baseline |
| `1` | a probe failed, and triage says our code is the likely cause |
| `2` | a probe failed for a reason healing cannot fix — infra, or a person is needed |
| `3` | everything passed, but a screen moved. Nothing is broken yet |
| `4` | **the sentinel could not look** — the lock was held, the MFA budget was spent, config was invalid. NOT a portal verdict |
| `5` | the kill switch is on |

`4` is distinct from `1` deliberately: "we could not look" reported as "the
portal is broken" is how a monitor loses its audience. `5` is distinct from `4`
because a monitor must let you tell *off* from *wedged*.

### On the internal host

```bash
tooling/sentinel-cron.sh access       # every ~15 min
tooling/sentinel-cron.sh session      # hourly
tooling/sentinel-cron.sh navigation   # 07:10, 12:10, 17:10
```

macOS: the three plists in `tooling/sentinel/`. Linux:
`tooling/sentinel/crontab.example`. Two traps, both of which produce a silent
failure:

- **launchd's `PATH` is minimal and excludes Docker's binaries.** The job dies
  with a bare exit 127. Both the plists and the crontab set `PATH` explicitly.
- **Overriding the container entrypoint without naming `with-display.sh` loses
  the virtual display**, and the probe then reports the exact bot-block it
  exists to rule out.

`flock` is deliberately unused even on Linux: macOS has neither `flock` nor
`setsid`, and a lock present on only one of the two plausible hosts is worse
than one present on both. The portable lock is `data/sentinel/portal.lock`.

### MFA economics

A one-time code takes a measured **132–600s** to arrive through the forward,
expires on a countdown, and is delivered primarily to a mailbox we cannot read.
So the sentinel spends one only on a **proven** lapse, at most
`sentinel.maxMfaPerDay` per day.

A SAML re-challenge costs the **password only** — Okta does not ask for a
factor, because the device is trusted — so it is tracked separately and does not
count against the budget. The navigation probe's own `saveSession` keeps the
portal session warm, which means running the sentinel *reduces* net MFA spend
rather than adding to it.

### Calibrating it

Every threshold in `config/platform.json` under `sentinel` is judgement rather
than measurement. Run the first fortnight with `fileIssues: false` and read the
printed findings, then set `minConsecutiveFailures`, the cooldown and the daily
cap to what this portal actually does.

`RPA_SENTINEL_ENABLED=false` is the kill switch and overrides config without a
deploy.

### Log rotation

launchd does not rotate `StandardOutPath`. Add
`artifacts/sentinel/launchd-*.log` and `artifacts/sentinel/cron.log` to whatever
rotates logs on the host, or truncate them on a schedule — the access cadence
writes 96 entries a day.

## Autohealing

When the sentinel files a `sentinel:healable` issue, an unattended repair
session can pick it up. The full procedure is
`.claude/skills/portal-drift-repair/SKILL.md`; the operational surface is:

```bash
pnpm heal:selftest        # proves the guard rails, and runs in milliseconds
```

Run that **before trusting a heal on this host**, and after any change to
`tooling/healing/policy.ts`. It answers "is the policy correct?". The supervisor
separately answers "is the policy in the path?" by watching a throwaway session
actually get denied — a correct policy that is never consulted is the dangerous
state, and it looks exactly like a working one.

Operational notes:

- **One heal at a time, in one dedicated clone.** Not a git worktree: `.env`,
  `data/sessions/`, the Chromium profile and CDP 9222 are repo-root singletons.
- The repair session runs on the **host**, not in the container — it needs
  `git`, `gh`, the agent binary and the recon browser.
- It opens **draft** pull requests and never merges. `main` must be protected
  with a required CODEOWNERS review; until it is, "never merges" rests on the
  policy alone.
- **There is no automated test gate on a pull request.** GitHub Actions is
  disabled on this repository by the organization, so
  `.github/workflows/check.yml` is registered but has never executed, and there
  is no Buildkite pipeline. The checks that appear on a pull request are
  org-level security scanners; none of them runs `pnpm check`. A repair session's
  own `pnpm check` output in the pull-request body is therefore the *author's*
  claim, and the reviewer has to re-run it. Two owner actions would fix this:
  enable Actions for the repository, or port `check.yml` to Buildkite.
- Its transcript is at `artifacts/heal/<issue>/transcript.jsonl`, gitignored and
  never uploaded.
