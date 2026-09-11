#!/usr/bin/env bash
#
# Runs one sentinel cadence, exactly as the internal host runs it.
#
# Called by launchd (macOS) or cron (Linux). Every flag below earns its place;
# see the notes against each one, because three of them are the difference
# between a working probe and one that reports the exact failure it exists to
# rule out.
#
#   tooling/sentinel-cron.sh access       # every ~15 min, no credentials, no MFA
#   tooling/sentinel-cron.sh session      # hourly, cookies only
#   tooling/sentinel-cron.sh navigation   # a few times a day, may spend one code
#
# Exit codes are the sentinel's own taxonomy, and the scheduler should NOT treat
# all non-zero the same:
#   0 ok   1 healable   2 needs a human   3 drift only   4 inconclusive   5 off
#
# 4 in particular means "we could not look" - a held lock, a spent MFA budget -
# and is not a portal verdict.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SET="${1:?usage: sentinel-cron.sh access|session|navigation}"

case "$SET" in
  access|session|navigation) ;;
  *)
    echo "[sentinel-cron] unknown cadence '$SET' - expected access, session or navigation" >&2
    exit 64
    ;;
esac

exec docker compose run --rm -T \
  --name "bentech-rpa-sentinel-${SET}" \
  -e HEADLESS=false \
  -e APP_ENV="${APP_ENV:-dev}" \
  -e LOG_PRETTY="${LOG_PRETTY:-false}" \
  --entrypoint tooling/docker/with-display.sh \
  rpa pnpm --silent rpa sentinel --set "${SET}" --file-issues

# ── WHY EACH FLAG ───────────────────────────────────────────────────────────
#
# --entrypoint tooling/docker/with-display.sh
#   Anthem serves `Access Denied` to headless Chromium, so the probe must run
#   headed on a virtual display. Overriding the entrypoint OUTRIGHT (without
#   naming with-display.sh) silently loses that display - and the probe then
#   reports the very bot-block it exists to rule out. This is the single most
#   important line in the file.
#
# -e HEADLESS=false, explicitly
#   docker-compose.yml interpolates `${HEADLESS:-true}` from the project .env,
#   so relying on the default makes the behaviour depend on whichever .env the
#   host happens to have. Stating it here makes the scheduled run reproducible.
#
# -T
#   There is no TTY under launchd or cron. Without it, compose can fail or hang.
#
# --name
#   Docker refuses a second container with the same name, which is a free second
#   overlap guard on top of the repo's own portal lock. Two probe runs at once
#   fight over the persistent browser profile, and the loser reports "the
#   profile is already in use" rather than anything about the portal.
#
# --rm
#   The access cadence runs 96 times a day. Without this, 96 dead containers a
#   day accumulate.
#
# The ./data and ./artifacts bind mounts are already in docker-compose.yml.
# ./data is what makes session reuse - and therefore MFA thrift - possible at
# all: without it every navigation run would start from no session and spend a
# one-time code.
