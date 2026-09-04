#!/usr/bin/env bash
#
# Runs any command with a display, when the command needs one.
#
# ── WHY THIS IS ITS OWN SCRIPT ───────────────────────────────────────────────
# Anthem's broker portal serves `Access Denied` to headless Chromium and loads
# normally headed, so the automation that most needs to run unattended is the one
# that cannot run headless. A container has no display; xvfb provides a virtual
# one.
#
# It started out inline in entrypoint.sh, which was wrong in a way that only
# showed up when using it: anything that overrides the entrypoint - the portal
# access check, an ad-hoc `pnpm tsx`, a debugging shell - silently lost the
# display and got the 403 the whole arrangement exists to avoid. Wrapping a
# COMMAND rather than one code path fixes that:
#
#   docker compose run --rm -e HEADLESS=false \
#     --entrypoint tooling/docker/with-display.sh rpa \
#     pnpm tsx tooling/scripts/check-portal-access.ts
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: with-display.sh <command> [args...]" >&2
  exit 2
fi

# Headless is the default and the right choice for everything a carrier does not
# block: faster, lighter, no X server. Only a headed request needs the display.
#
# DISPLAY already set means someone supplied a real one - an X socket mounted in,
# or a remote server - so it is respected rather than shadowed.
if [ "${HEADLESS:-true}" != "false" ] || [ -n "${DISPLAY:-}" ]; then
  exec "$@"
fi

if ! command -v xvfb-run > /dev/null 2>&1; then
  echo "HEADLESS=false needs a display, and xvfb-run is not installed in this image." >&2
  echo "Rebuild from tooling/docker/Dockerfile, which installs xvfb." >&2
  exit 1
fi

echo "HEADLESS=false: starting a headed browser on a virtual display (xvfb)" >&2

# `--auto-servernum` picks a free display number rather than assuming :99, so a
# retry inside the same container - or two containers sharing a host X socket
# path - cannot collide on a stale lockfile. The screen is sized above the
# 1440x900 viewport the automations set, so nothing is clipped by the display.
#
# exec, and xvfb-run forwards signals to the command it wraps, so the runner
# still receives SIGTERM and gets its graceful stop: the current transaction
# finishes and the browser closes.
exec xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24 -nolisten tcp" "$@"
