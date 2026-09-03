# certs/

Internal root CAs to trust inside the container.

Drop PEM-encoded certificates here with a **`.crt`** extension. The Dockerfile
adds them to the system trust store, and points Node at the merged bundle.

## Why this is needed

Corporate Zero Trust proxies (Cloudflare WARP, Zscaler, Netskope) terminate TLS
and re-sign it with an internal CA. A developer's Mac trusts that CA because the
MDM profile installed it. A fresh Ubuntu container does not, so **every** HTTPS
navigation fails:

```
page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://...
```

That failure is a genuine Mac-to-Ubuntu difference, and it applies to real
carrier portals, not just the demo site.

## Getting your CA

```bash
./tooling/scripts/export-corporate-ca.sh     # macOS: reads the System keychain
docker compose build                          # bake it into the image
```

In CI, write the certificate into this directory from your secret store before
building.

## What not to do

Do **not** reach for `ignoreHTTPSErrors`. It disables certificate validation for
every request the automation makes, on automations that sign in to carrier
portals with real credentials. Trusting a specific, known CA is the narrow fix;
switching off verification is not.

## Committing

`certs/*.crt` is gitignored. These are public certificates, not secrets, but an
internal CA still describes internal infrastructure and does not belong in a
repository. Supply it per environment.
