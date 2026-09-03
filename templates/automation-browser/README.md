# __AUTOMATION_NAME__

__DESCRIPTION__

| | |
|---|---|
| **Id** | `__AUTOMATION_ID__` |
| **Domain** | `__DOMAIN__` |
| **Owner** | __OWNER__ |
| **Session** | browser (Chromium, headless by default) |
| **Queue** | `__QUEUE_NAME__` |

## Run it

```bash
pnpm rpa run __AUTOMATION_ID__                 # headless, as the server does
HEADLESS=false pnpm rpa run __AUTOMATION_ID__  # watch it, on a dev machine
pnpm rpa queue __AUTOMATION_ID__ --reset       # re-seed the synthetic queue
```

## Credentials

Set the variables named in `config/config.dev.json` (`usernameEnv`,
`passwordEnv`) in your `.env`. The config file holds only the *names*; values
are resolved through `ctx.secrets` at runtime.

## Where things live

- `src/pages/` - every selector, and nowhere else.
- `src/payload.ts` - the queue item shape. Invalid payload -> `BusinessException`.
- `src/config.ts` - this automation's settings schema.
- `data/seed/queue.json` - synthetic transactions. **Never real member or group data.**

## Business vs System

- Rule violated, data rejected, record ineligible -> `throw new BusinessException(...)`. No retry.
- Portal down, timeout, unexpected page -> let it throw, or `throw new SystemException(...)`.
  The framework screenshots, traces, recovers the session and retries.
