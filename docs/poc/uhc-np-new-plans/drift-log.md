# Drift log

What the **live portal** does differently from the runbook.

**An empty drift log after re-mapping a week-old runbook against a live portal
means the re-mapping did not happen.** Portals change; record it.

## Entries

| Date | Documented step | What actually happens | What the automation does now |
|---|---|---|---|
| 2026-09-02 | MFA arrives as email from `uhc.com` / `uhcprovider.com` | **No UHC-domain sender exists in the label at all.** The `Access Token (UnitedHealthcare)` label contains mail from `carrierops@gusto.com` (12 in 30 days) and from `...@txt.voice.google.com` (2) — UHC **texts** the code, and Google Voice forwards the SMS as email | `mfaSenderAllowList` is `["txt.voice.google.com", "carrierops@gusto.com"]`. The previous value matched nothing, so every code would have been rejected |
| 2026-09-02 | (not documented) Delivery channel | SMS-to-email via Google Voice, not carrier email. The sender's local part encodes phone numbers and a rotating thread token, so the address is not stable enough to allow-list in full | Allow-listed on the `txt.voice.google.com` domain. Tightening to the specific number is possible but would break if UHC changes it |
| 2026-09-02 | (not documented) Login selectors | Not yet re-mapped against the live SAMx portal | `UhcLoginPage` locators remain unverified hypotheses |
