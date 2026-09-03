#!/usr/bin/env bash
#
# Exports the corporate TLS-inspection root CA from the macOS System keychain
# into certs/, so the container trusts the same chain your Mac already does.
#
# Run this once (and again if IT rotates the CA), then rebuild the image.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${REPO_ROOT}/certs/corporate-root-ca.crt"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script reads the macOS keychain. On Linux the CA is usually already" >&2
  echo "in /usr/local/share/ca-certificates - copy it into certs/ instead." >&2
  exit 1
fi

# Known corporate TLS-inspection CAs. Add yours if it is not listed.
PATTERNS=("Gateway CA - Cloudflare" "Zscaler" "Netskope")

for pattern in "${PATTERNS[@]}"; do
  if security find-certificate -a -c "${pattern}" -p /Library/Keychains/System.keychain > "${OUT}.tmp" 2>/dev/null \
     && [[ -s "${OUT}.tmp" ]]; then
    mv "${OUT}.tmp" "${OUT}"
    echo "Exported \"${pattern}\" to certs/$(basename "${OUT}")"
    openssl x509 -in "${OUT}" -noout -subject 2>/dev/null || true
    echo
    echo "Next: docker compose build"
    exit 0
  fi
done

rm -f "${OUT}.tmp"
echo "No known corporate CA found in the System keychain." >&2
echo "If your network does not inspect TLS, you do not need one." >&2
exit 1
