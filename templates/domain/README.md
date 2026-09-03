# __DOMAIN_TITLE__

Process-type domain. Every automation whose work is __DOMAIN_TITLE__ lives in a
folder next to this file.

- **Owner:** __OWNER__
- **Shared code:** [`_shared/`](./_shared) is published to the workspace as
  `__DOMAIN_SHARED_PKG__`. Page objects and business rules that more than one
  automation in this domain needs belong there - and nowhere else. Automations in
  other domains cannot import it, by design.

## Add an automation here

```bash
pnpm rpa new automation --id __DOMAIN__/<name> --owner __OWNER__ --kind browser
pnpm install
pnpm rpa validate
```

Use `--kind api` when the automation has no user interface to drive (file, API
or database work). That skips the browser launch entirely.

## Before the first automation lands

Add this domain to `CODEOWNERS` so reviews route to the right team:

```
/automations/__DOMAIN__/   __OWNER__
```
