# Business or System?

## The test

> Would running this again, on a fresh browser, plausibly give a different
> answer? **Yes → System. No → Business.**

Getting it backwards either burns three browser relaunches per item on a rule
that will never change its mind, or silently abandons real work.

Anything that is not a `BusinessException` is treated as a system failure,
including Playwright's `TimeoutError`. Only be explicit about the business cases.

## This portal's already-decided cases

| Situation | Classification | Why |
|---|---|---|
| A rejected password (`"Unable to sign in. Please check your credentials."`) | **System** | Verified against this exact wording. A credential can be fixed and retried |
| A locked or throttled account | **Business** | A carrier decision. Retrying wastes minutes and still fails |
| `"That SIC code isn't valid. Please double check it and try again."` | **Business** | The portal looked at the value and refused it |
| An unrecovered `Create Quote` SAML hand-off | **Business** — and this **reverses** an earlier version of the test | By then a real quote exists. A System retry re-drives the transaction, clicks `Create Quote` again, creates a **second** quote for the same group, and then hits "Application Matching Error" anyway. That pathology is behind this PoC's production cleanup list |
| "Application Matching Error" / `inprogressapplication` | **Business** | A retry gets the same answer until a human finishes or cancels the existing application |
| The `allowSubmit` guard firing | **Business**, and it is the **success condition** for a PoC run | |

## The success-toast trap

Anthem's post-signature toast carries `role="alert"` and reads:

> `SuccessYou have successfully signed the document. Please select Continue to
> move to the next step.`

The wording list matched `please select` and turned a **successful signature**
into a `BusinessException` — on a run that had just filed a real application.
Four earlier runs had raced past the toast and never hit it.

Hence `NOT_A_COMPLAINT` is checked **first**, and there is a structural
exclusion for `slds-theme_success|info` on top of it.

## If you touch `isPortalComplaint`

It is a **pure exported function** precisely so real captured strings can be
tested without a browser — the strings arrive on screens that are expensive or
irreversible to reach. **Add the exact captured string to
`portal-errors.test.ts`.** Every string in that file is one the live portal
actually produced.

Err **broad** on complaint wording: a missed complaint costs three browser
relaunches on a flow that creates real quotes, while a false positive is held
back by the deny-list and the theme check. `PROBLEM_WORDING` was widened after
Anthem's real SIC message never matched the original narrow list at all.

## What you may not do

Changing a `SystemException` to a `BusinessException` or back is refused by the
healing policy's diff rules. Rule 1 is the contract everything hinges on, and a
classification change needs a stated reason and a human — propose it in the PR
body rather than applying it.
