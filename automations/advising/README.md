# Advising

Process-type domain: automations that support benefits **advising** workflows.

- **Owner:** @gusto/bentech-rpa-advising
- **Shared code:** [`_shared/`](./_shared) is `@auto/advising-shared`. Only
  automations in this domain may import it.

**This domain has no automations yet.** It was created with
`pnpm rpa new domain` and is left here on purpose, as an example of what a
freshly scaffolded process type looks like before its first automation lands:
a `_shared` package with a real export, a README, and a `CODEOWNERS` entry.

## Add the first one

```bash
pnpm rpa new automation \
  --id advising/<name> \
  --owner @gusto/bentech-rpa-advising \
  --kind browser        # or --kind api if there is no UI to drive

pnpm install && pnpm rpa validate
```
