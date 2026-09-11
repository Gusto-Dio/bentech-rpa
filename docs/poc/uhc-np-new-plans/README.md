# UHC New Plans — PoC docs

The second carrier. **Written, not verified:** stages 1–8 exist, typecheck and
have unit tests where they do not need a browser, but **no locator in this
automation has ever met a live screen.**

What the code knows about the portal today:

- The host is `https://www.uhceservices.com/en/prelogin` — confirmed reachable
  and serving a page titled "Pre-login Page" (HTTP 200). It replaced the
  scaffold placeholder `www.uhc.com`. The sign-in form is *not* on that page:
  sign-in crosses to One Healthcare ID at `identity.onehealthcareid.com`, a
  separate origin. Both are recorded in
  [`src/pages/portal-origins.ts`](../../../automations/group-submission/uhc-np-new-plans/src/pages/portal-origins.ts).
- Everything else about the portal's vocabulary — census template values, the
  waiting-period dropdown, the organisation-type list — is **unknown**. Each
  unknown literal is recorded as `null`, and resolving one **throws** a
  `SystemException` rather than guessing: see `requireVocabulary` in
  [`src/vocabulary.ts`](../../../automations/group-submission/uhc-np-new-plans/src/vocabulary.ts).
  A guessed dropdown value either fails loudly or matches a real option meaning
  something else — and then the portal accepts a submission that is quietly
  wrong.

[drift-log.md](drift-log.md) is the record: what the live portal actually does,
against what the code assumed. Add to it during the re-map.

**Boundary:** the PoC ends at the employer application. Stage 8 (attestation) is
guarded by `allowSubmit`, which defaults to `false` — this runs against the
production portal and an attestation is signed on the producer's behalf.

Scope, how to run it, and the Business/System table live with the automation:
[`automations/group-submission/uhc-np-new-plans`](../../../automations/group-submission/uhc-np-new-plans).
