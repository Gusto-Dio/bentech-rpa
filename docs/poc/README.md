# Group-submission PoCs: Anthem CA and UHC

Two real benefits processes, automated against live carrier portals.

| | Anthem CA New Plans | UHC New Plans |
|---|---|---|
| Portal | Anthem Producer | UHC SAMx |
| Automation | [`group-submission/anthem-ca-new-plans`](../../automations/group-submission/anthem-ca-new-plans) | [`group-submission/uhc-np-new-plans`](../../automations/group-submission/uhc-np-new-plans) |
| Dev prompt | [PROMPT.md](anthem-ca-new-plans/PROMPT.md) | [PROMPT.md](uhc-np-new-plans/PROMPT.md) |
| Boundary | end of the employer application | end of the employer application |

**[PROMPT-00-shared-foundations.md](PROMPT-00-shared-foundations.md) is DONE.**
The MFA providers, `step()` and session reuse all exist and are proven against
the live Anthem portal: a real code read from a Gmail label, login completed,
`data/sessions/anthem-ca.json` persisted, and a recovered session consuming no
code. Read [mfa-gmail.md](mfa-gmail.md) and CLAUDE.md rule 10b before touching
that layer - several "safety" guards added there discarded valid codes.
Both PoCs depend on the same MFA module, `step()` helper and session reuse.
Building them twice would produce two divergent versions.

## Phase 1 vs phase 2

Phase 1 — what these PoCs are:

- Queue items come from a **local JSON seed** (`data/seed/queue.json`)
- Credentials come from **`.env`**
- MFA codes are read from a **Gmail label**
- **No Orchestrator, no 1Password, no vault**

Phase 2, once the browser automation is proven:

- Swap `queue.provider` to `orchestrator` — one config line, the integration is
  already built and unit-tested. See [../orchestrator.md](../orchestrator.md).
- Swap the secret provider for 1Password or a vault — one class behind
  `SecretProvider`.
- Swap `GmailProfileMfaProvider` for `GmailApiMfaProvider` — one config line.

None of that requires touching the automations, which is the whole point of the
seams.

## The three things that make these harder than the demo

1. **MFA on every login.** Codes arrive by email and are rate-limited, so
   sessions are persisted and reused. See [mfa-gmail.md](mfa-gmail.md).
2. **Excel macros in the middle of the process.** Two VBA macros transform the
   Hippo census into each carrier's template. They are being ported to
   TypeScript. See [excel-macros.md](excel-macros.md).
3. **Production portals, no sandbox.** Filing an application is irreversible, so
   both automations stop before signing, behind an `allowSubmit` guard that
   defaults to `false`.

## The material these were built from

The source runbooks, censuses and macro workbook live in Gdrive, **not in this
repo**: they carry PII-shaped census rows and real producer identifiers.
`docs/poc/**` ignores those file types. Only sanitized derivatives are committed
— see [sanitization.md](sanitization.md) for exactly what was replaced.

## The instructions are older than the portals

The runbooks were written roughly a week before this work. Carrier portals
change without notice. **Every selector in both automations is an unverified
hypothesis**, and re-mapping against the live portal is the first task in each
prompt — not an optional polish step. Divergences get recorded in each PoC's
`drift-log.md`.
