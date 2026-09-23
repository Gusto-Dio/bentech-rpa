# Packet Collection

Process-type domain. Every automation whose work is Packet Collection lives in a
folder next to this file.

- **Owner:** @Gusto-Dio
- **Shared code:** [`_shared/`](./_shared) is published to the workspace as
  `@auto/packet-collection-shared`. Page objects and business rules that more than one
  automation in this domain needs belong there - and nowhere else. Automations in
  other domains cannot import it, by design.

## Add an automation here

```bash
pnpm rpa new automation --id packet-collection/<name> --owner @Gusto-Dio --kind browser
pnpm install
pnpm rpa validate
```

Use `--kind api` when the automation has no user interface to drive (file, API
or database work). That skips the browser launch entirely.

## Before the first automation lands

Add this domain to `CODEOWNERS` so reviews route to the right team:

```
/automations/packet-collection/   @Gusto-Dio
```
