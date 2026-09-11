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
| 2026-09-10 | `portalUrl` is the SAMx portal | **It is not, and this one IS verified.** `check-portal-access.ts --automation group-submission/uhc-np-new-plans` returns HTTP 200 with the title *"Group health insurance for employers \| Employer \| UnitedHealthcare"* and **no sign-in field** — a consumer marketing page. All three env configs carry `https://www.uhc.com/employer/`, and the real SAMx origin appears nowhere in the repo. `data/sessions/uhc.json` has never existed and no run directory under `artifacts/` mentions UHC — **UHC has never signed in** | The host is now a single constant, `PORTAL_HOST` in `src/pages/portal-origins.ts`, carrying a `TODO(remap)`. `RECON_HOSTS` is a list from the outset because whether sign-in crosses an identity host (as Anthem's does) is unknown |
| 2026-09-10 | Runbook stage numbers in the code | `remaining-screens.page.ts` cited "runbook 2.3–2.7", "3.1–3.13" etc., which the runbook had since renumbered to 3.1–3.4 / 4 / 5 / 6.1–6.7 / 7.1 / 8 | The stubs are gone. Stages 3–8 are five page objects whose doc comments cite the current numbering |
| 2026-09-10 | The exemplar's gates | `case-start.page.ts` used `isVisible()` in every gate, which AGENTS.md rule **9b** forbids — it is Playwright's one non-waiting assertion and it has already cost a live Anthem run. The exemplar predates the rule | Every gate now uses `visible` / `valueIs` / `textVisible` from `@rpa/core`. `readPortalValidationError` keeps `isVisible()` deliberately: it is not a gate, and waiting for an absent error would add the gate timeout to every successful step |
| 2026-09-10 | Producer identity in config | Seven `REPLACE_ME` values for a real licensed producer and agency sat in **tracked** config files. `sanitization.md` records this exact shape leaking once already across seven files; filling a placeholder in place is the whole failure mode | Config carries env-var **names** (`UHC_PRODUCER_FIRST_NAME`, `UHC_GENERAL_AGENT_NAME`, `UHC_PCIS_ID`, …), resolved by `resolveProducerIdentity`. Added to `.env.example` |
| 2026-09-10 | SAMx census template columns | The runbook names the column LETTERS (R, S, Y, Z, AA, AQ) but neither their header text nor the values they accept, and Anthem's equivalent list came from a `Key` sheet inside the real downloaded template | The transform is complete and tested; the vocabulary is recorded as `null` and **resolving one throws**. `SAMX_CENSUS_HEADERS`, `SAMX_COVERAGE_TYPE`, `SAMX_ORGANIZATION_TYPE`, `SAMX_CONTINUATION`, `SAMX_PRIMARY_OPTION`, `SAMX_DEDUCTIBLE_RESET` and `SAMX_WAITING_PERIOD` are the fill-in points |
| 2026-09-10 | Hippo → UHC waiting period | The runbook's field map records all five rows as "(to be discovered)". The SAMx option list it already quotes shows why: *First of the Following Month after Specified Duration* and *Specified Duration* both need a number, so one Hippo value can require **two** SAMx answers — an option *plus* a duration. Read off the paperwork, **not** the portal | Modelled as `WaitingPeriodAnswer { option, durationDays }` rather than a flat string table, because a flat table cannot express the portal's list. Every entry unrecorded |
| 2026-09-11 | (supersedes the 2026-09-10 `portalUrl` entry above) | The marketing-page finding stands, but the host it blocked on has since been found: `PORTAL_HOST` / `PRELOGIN_PATH` in `src/pages/portal-origins.ts` record `https://www.uhceservices.com/en/prelogin` as reachable and serving a page titled *"Pre-login Page"* (HTTP 200), and note that the sign-in form is **not** on it — the `Log In with OneHealthcare ID` link crosses to `identity.onehealthcareid.com`, a separate origin | All three env configs now carry the eServices pre-login URL. The origin fence and `playwright-mcp.config.json` list both hosts. **Still nothing past sign-in:** no UHC session has ever existed, so every locator from stage 1 on remains an unverified hypothesis |

## What is still unmapped

Nothing in stages 2–8 has been verified against the live portal. The entries
above are corrections made **from the documentation and the code**, not from
SAMx — which is exactly the distinction this log's header warns about. The
portal-side re-map has not happened yet, and until it does:

- every locator in `src/pages/` is an unverified hypothesis carrying `TODO(remap)`
- every portal literal is `null` and throws when resolved, so the automation
  **fails closed** rather than submitting a plausible guess
- the host is known and reachable, but sign-in crosses to One Healthcare ID and
  nothing beyond the pre-login page has been read, so
  `pnpm rpa run group-submission/uhc-np-new-plans` stops at the sign-in hop

The harness for doing it is `tooling/scripts/uhc-serve.ts` + `uhc-do.ts`: sign in
by hand once, `uhc-do.ts save`, then walk the screens without spending another
MFA code.
