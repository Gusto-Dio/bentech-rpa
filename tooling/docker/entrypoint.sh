#!/usr/bin/env bash
#
# Selects which automation this container runs. The id can come from an argument
# or from AUTOMATION_ID, so the same image works with `docker run ... <id>`, a
# compose `command:`, and a Kubernetes CronJob env var.
set -euo pipefail

AUTOMATION="${1:-${AUTOMATION_ID:-}}"

if [ -z "${AUTOMATION}" ]; then
  {
    echo "No automation specified."
    echo
    echo "  docker run --rm benefits-rpa:local <automation-id>"
    echo "  docker run --rm -e AUTOMATION_ID=<automation-id> benefits-rpa:local"
    echo
    echo "Available:"
  } >&2
  exec pnpm --silent rpa list
fi

# Drop the id if it came in as an argument, so any remaining flags pass through.
if [ "$#" -gt 0 ]; then
  shift
fi

# exec, so the process replaces the shell and receives SIGTERM directly. Without
# it the graceful stop never fires and the orchestrator kills the browser
# mid-transaction.
exec pnpm --silent rpa run "${AUTOMATION}" "$@"
