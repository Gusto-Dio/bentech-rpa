# Anthem CA New Plans — PoC docs

| Document | What it is for |
|---|---|
| [PROMPT.md](PROMPT.md) | **The development prompt.** Paste into a fresh session |
| [process-steps.md](process-steps.md) | The sanitized runbook, stage-numbered to match the code |
| [field-map.md](field-map.md) | Payload field → portal field, per screen |
| [documents.md](documents.md) | The 8 upload slots and where each document comes from |
| [open-questions.md](open-questions.md) | What must still be confirmed |
| [drift-log.md](drift-log.md) | What the live portal does differently |

The automation itself is at
[`automations/group-submission/anthem-ca-new-plans`](../../../automations/group-submission/anthem-ca-new-plans)
— its README covers scope, how to run it, and the Business/System table.

**Boundary:** the PoC ends at the employer application. Stage 8 (e-signature) is
guarded by `allowSubmit`, which defaults to `false` because this runs against the
production portal and signing is irreversible.
