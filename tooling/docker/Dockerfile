# syntax=docker/dockerfile:1
#
# One image, every automation. This mirrors UiPath's model - a single robot
# runtime, N processes selected at start - so ops intuition transfers, and a
# Chromium or Node CVE is one rebuild instead of a hundred.
#
#   docker build  -f tooling/docker/Dockerfile -t bentech-rpa:local .
#   docker run --rm --shm-size=1g bentech-rpa:local <automation-id>
#
# Carrier portals that refuse headless Chromium need a headed browser on a
# virtual display. The entrypoint arranges that; the caller only asks for it:
#
#   docker run --rm --shm-size=1g -e HEADLESS=false bentech-rpa:local <id>
#
# For the Ubuntu servers, build explicitly for their architecture. On Apple
# Silicon this cross-builds (slowly), which is the price of not shipping an
# arm64 image to an x86_64 host:
#
#   docker buildx build --platform linux/amd64 -f tooling/docker/Dockerfile -t bentech-rpa:1.0.0 .
#
# The tag is multi-arch, so the same line works on both platforms.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

# This base image ships Chromium, Firefox, WebKit AND every system library they
# need - fonts, libnss3, libatk and the rest. That is the whole reason to use it
# instead of a plain node image: on a bare Ubuntu server those missing libraries
# are the number one cause of "works on my Mac".
#
# It also ships Node 24, which is exactly what .nvmrc pins. Dev and runtime run
# the same major version because they run the same version, not because two
# separate places were kept in step by hand.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PNPM_HOME=/home/pwuser/.local/share/pnpm \
    PATH=/home/pwuser/.local/share/pnpm:$PATH \
    APP_ENV=dev \
    HEADLESS=true \
    LOG_PRETTY=false \
    # Non-interactive build: corepack must fetch pnpm without asking.
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# corepack pins pnpm to the version in package.json's "packageManager" field.
RUN corepack enable

# ── Corporate TLS interception ───────────────────────────────────────────────
# Any .crt in certs/ is added to the system trust store. This is required
# wherever a Zero Trust proxy (Cloudflare WARP, Zscaler, Netskope) terminates
# TLS: the developer's Mac trusts the proxy CA via its MDM profile, but a fresh
# container does not, and every https:// navigation fails with
# ERR_CERT_AUTHORITY_INVALID. It applies to real carrier portals, not just demos.
#
# The narrow fix is to trust a specific known CA. Turning off verification with
# ignoreHTTPSErrors is not the same thing and is not done here.
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates

# Node uses its own bundled CA list rather than the system store, so it needs
# pointing at the merged bundle separately.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# And Chromium needs a third thing. On Linux it trusts NSS, not
# /etc/ssl/certs - so update-ca-certificates above fixes curl, openssl and Node
# while the browser still fails with ERR_CERT_AUTHORITY_INVALID. The CA has to be
# imported into the NSS database of the user that runs the browser.
#
# This is the least obvious part of the whole setup, and it is the difference
# between "TLS works in the container" and "TLS works in the container's browser".
# xvfb is here for a carrier, not for convenience.
#
# Anthem's broker portal serves `Access Denied` to HEADLESS Chromium and loads
# normally headed - bot protection, not a bug. So the one automation that has to
# run unattended is also the one that cannot run headless, and a container has
# no display. xvfb gives it a virtual one, which is what makes the Ubuntu
# runtime possible at all. See tooling/docker/with-display.sh, which starts it
# only when a run actually asks for a headed browser - entrypoint.sh just
# delegates to that wrapper, so overriding the entrypoint keeps the display.
#
# libnss3-tools is for the certutil call below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libnss3-tools xvfb \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/pwuser/.pki/nssdb \
 && certutil -d "sql:/home/pwuser/.pki/nssdb" -N --empty-password \
 && for crt in /usr/local/share/ca-certificates/*.crt; do \
      [ -e "$crt" ] || continue; \
      certutil -d "sql:/home/pwuser/.pki/nssdb" -A -t "C,," \
        -n "$(basename "$crt" .crt)" -i "$crt"; \
      echo "Trusted $(basename "$crt") in the browser NSS store"; \
    done \
 && chown -R pwuser:pwuser /home/pwuser/.pki

WORKDIR /app
RUN chown -R pwuser:pwuser /app

# Non-root, so Chromium keeps its sandbox. This is why CHROMIUM_NO_SANDBOX
# exists as an escape hatch but stays off: disabling the sandbox hands a
# compromised page the container's privileges.
USER pwuser

# One COPY of the whole workspace. Copying manifests first would cache the
# install layer better, but with 100+ automations the list of manifest paths is
# a moving target that would silently drift out of date - a slower build is
# cheaper than a build that quietly installs the wrong tree.
COPY --chown=pwuser:pwuser . .

# --frozen-lockfile makes the image reproducible: it fails rather than silently
# resolving a different dependency graph than the one that was reviewed.
RUN pnpm install --frozen-lockfile --prod=false

# Playwright MCP is a DEVELOPMENT tool: it lets an agent drive a browser while
# an automation is being written. It has no part in the runtime, and this image
# holds carrier credentials - so a browser-driving server that nothing invokes
# is attack surface with no upside.
#
# It has to be removed explicitly rather than skipped at install, because the
# install above deliberately keeps devDependencies for pino-pretty. Without this
# step the image ships it, which is what made the README's "MCP never appears in
# the container" false for a while.
RUN rm -rf node_modules/@playwright/mcp node_modules/.bin/playwright-mcp \
  && ! test -e node_modules/.bin/playwright-mcp

# Set after install so pnpm does not skip devDependencies. pino-pretty is kept
# available deliberately: being able to set LOG_PRETTY=true while debugging a
# production container is worth a few megabytes.
ENV NODE_ENV=production

RUN mkdir -p /app/data /app/artifacts

ENTRYPOINT ["/app/tooling/docker/entrypoint.sh"]
