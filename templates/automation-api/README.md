# __AUTOMATION_NAME__

__DESCRIPTION__

| | |
|---|---|
| **Id** | `__AUTOMATION_ID__` |
| **Domain** | `__DOMAIN__` |
| **Owner** | __OWNER__ |
| **Session** | none (no browser is launched) |
| **Queue** | `__QUEUE_NAME__` |

## Run it

```bash
pnpm rpa run __AUTOMATION_ID__
pnpm rpa queue __AUTOMATION_ID__ --reset   # re-seed the synthetic queue
```

## Where things live

- `src/payload.ts` - the queue item shape. Invalid payload -> `BusinessException`.
- `src/config.ts` - this automation's settings schema.
- `data/seed/queue.json` - synthetic transactions. **Never real member or group data.**

## Business vs System

- Rule violated, record ineligible, amount out of range -> `throw new BusinessException(...)`. No retry.
- Source system unreachable, file locked, timeout -> let it throw. The framework
  retries with backoff. `recover()` is a no-op for this session kind, because the
  retry itself is the recovery.
