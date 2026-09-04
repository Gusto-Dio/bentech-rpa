# Group Submission

Process-type domain: automations that assemble and submit a **group's** benefits
elections to a carrier portal.

- **Owner:** @gusto/bentech-rpa-group-submission
- **Shared code:** [`_shared/`](./_shared) is `@auto/group-submission-shared` -
  the carrier portal sign-in page object and the domain's business rules. Only
  automations in this domain may import it.

## Automations

| Id | Session | What it does |
|---|---|---|
| [`carrier-portal-submission-demo`](./carrier-portal-submission-demo) | browser | Reference implementation. Signs in, assembles a submission, reviews, submits, captures a confirmation. |

## Add one

```bash
pnpm rpa new automation \
  --id group-submission/<name> \
  --owner @gusto/bentech-rpa-group-submission \
  --kind browser
pnpm install && pnpm rpa validate
```
