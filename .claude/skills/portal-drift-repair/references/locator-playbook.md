# Locator playbook

The `AGENTS.md` gotchas table and the drift log's locator findings, reorganised by
**the symptom you are looking at** rather than by cause. Every row is a measured
fact about this portal, not general Playwright advice.

| You are seeing | It is | Do |
|---|---|---|
| A locator times out on an element plainly on screen | `aria-label` overrides text content entirely | Dump role + accessible name. "Continue" is named `Login`; the checklist's `Submit` is named `documentCheckListSubmit`; an `input[type=submit]` takes its name from `value` |
| `getByRole('button', { name: 'Submit' })` matches **zero** | Same cause, measured live | Use `button()` from `lightning.ts`, which filters on text |
| `getByRole('radio', { name: 'No' })` matches **22** | The Vlocity wizard pre-renders every branch: 11 fieldsets, 22 radios, one visible | Scope to the fieldset whose **direct-child** legend matches (`:scope > legend`) **and** `.filter({ visible: true })`. `hasText` alone matches an outer wrapper and clicks the previous question's answer |
| Clicking a radio or checkbox times out | The `input` is **1×1 px** behind `label.slds-radio__label`; `elementFromPoint` returns the custom element, so actionability never passes | Click the **label** |
| A combobox reads as empty although it is set | The value lives on **`data-value`**, not `value`; `inputValue()` returns `''` | Read the attribute. Some are also `readonly` + `aria-disabled` and pre-filled (`Benefit Period` is already `Calendar Year`) — assert those, never click them |
| `vlocity-radio-0-1-110`, `comboboxId-604`, `input60` | Generated ids carrying a re-render counter | Never use an id or a `name` as a locator |
| A dump shows five controls on a screen with thirty; `page.evaluate` reads a full table as empty | Lightning **shadow DOM** | Walk `el.shadowRoot` recursively. Playwright's own locators DO pierce it, so this bites hand-written traversal — and it bit `readChecklist` in *automation* code, presenting as a screen that had not rendered |
| A gate is always false on a screen you can see | `isVisible()` does not wait | `visible()` from `@rpa/core` |
| A gate times out well before the budget you gave its locator | `step()` caps **every** gate at the step's own `timeoutMs` (default 60s) | Set `timeoutMs` on the **step spec**. `healing-guards.test.ts` now catches this statically |
| A URL check matches a page you are not on | OAuth hosts quote each other in query strings: Okta's authorize URL carries `redirect_uri=https://brokerportal.anthem.com/apps/ptb/_codexch` | **Parse** the URL — `new URL(u).host`, `.pathname`. Never pattern-match the whole string |
| `Create Quote` seems to do nothing | It opens a **new tab on a different host** (`elevancehealthfulcrum.my.site.com`) | Follow the popup. Producer Toolbox is only the launcher now |
| A second run for the same group times out waiting for the application URL | The portal redirected to `/broker/s/inprogressapplication` — "Application Matching Error", only control `Exit`. The text has **no alert role** | `readApplicationMatchingError()` reports it as Business. An end-to-end re-test needs a **different group** |
| "Book of Business" is ambiguous | It appears twice on the dashboard — a nav item and an `h2` | `getByText('Book of Business').first()` with a 45s budget; the dashboard is heavy and does not render inside the default 15s action timeout |
| "Resend Code" has no link role | It is an **anchor with no `href`** | Match by text |

## The ambiguity list is a finding

The recon dump ends with:

```
-- AMBIGUOUS (scope these, do not use .first() and hope) --
```

That section is the answer to "what is this locator colliding with", which is
what you actually need in order to scope it. `count() > 1` only tells you that a
problem exists.

## Verifying a locator without touching the portal

```bash
pnpm tsx tooling/scripts/anthem-verify-locators.ts --role combobox --name "Group County"
```

Reports `count()`, the **visible** count, and each match's resolved role,
accessible name and `data-value`. Read-only by construction — a source-level
test asserts the script contains no mutating call.

**`count() > 1` with `visible: 1` is normal here**, because the wizard
pre-renders every branch. Scope to the visible one rather than reaching for
`.first()`.
