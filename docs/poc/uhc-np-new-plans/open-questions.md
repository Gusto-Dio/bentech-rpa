# Open questions

Things that must be confirmed against the live portal or with the Benefits team
before this automation can be trusted. Answer them as you go, and move each
answer into the relevant doc.

## Must be answered by re-mapping

- [ ] Does every screen in `process-steps.md` still exist, in that order?
- [ ] What is the **actual** validation-error container? This is the
      highest-value locator in the automation — it is what separates a Business
      failure from a System one on every screen.
- [ ] Which fields auto-populate, and which silently do not? The runbook says
      "should auto-populate" in several places, which is not a guarantee.
- [ ] Is there a stable, signed-in-only landmark to use as the session probe?
- [ ] What does the MFA email actually look like — sender, subject, code format?

## Must be answered by the Benefits team

- [ ] The real values for every `REPLACE_ME` in `config/config.dev.json`
      (see [../sanitization.md](../sanitization.md))
- [ ] Which mailbox and Gmail label receive the MFA codes
- [ ] Is there **any** carrier test group or sandbox? Everything about this PoC
      would be easier if there were
- [ ] Who is allowed to flip `allowSubmit`, and under what circumstances?

## Decisions deferred to phase 2

- [ ] Orchestrator queue name and folder (the integration is built; see
      [../../orchestrator.md](../../orchestrator.md))
- [ ] 1Password or vault adapter behind `SecretProvider`
- [ ] Moving from `GmailProfileMfaProvider` to `GmailApiMfaProvider`
- [ ] Whether artifacts should ship to an Orchestrator storage bucket after each
      run (`BucketClient.uploadFile` already exists)
