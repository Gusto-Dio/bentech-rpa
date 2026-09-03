# Member Submission

Process-type domain: automations that validate and submit **individual member**
elections and eligibility changes.

- **Owner:** @gusto/benefits-rpa-member-submission
- **Shared code:** [`_shared/`](./_shared) is `@auto/member-submission-shared` -
  a delimited-file parser and the domain's eligibility rules. Only automations in
  this domain may import it.

## A note on data

This domain handles the most sensitive records in the platform. Nothing in this
repository - seed files, fixtures, examples, test data - may contain a real
member. Queue payloads carry an internal reference (`MBR-000123`), never names,
dates of birth, SSNs or wages. See
[docs/authoring-an-automation.md](../../docs/authoring-an-automation.md).

## Automations

| Id | Session | What it does |
|---|---|---|
| [`roster-file-validation-demo`](./roster-file-validation-demo) | none | Validates member elections against the carrier plan catalog. No browser is launched. |

## Add one

```bash
pnpm rpa new automation \
  --id member-submission/<name> \
  --owner @gusto/benefits-rpa-member-submission \
  --kind api
pnpm install && pnpm rpa validate
```
