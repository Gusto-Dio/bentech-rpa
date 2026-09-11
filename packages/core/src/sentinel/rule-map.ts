/**
 * The `AGENTS.md` rules a reader of a sentinel issue must know, by number.
 *
 * ── WHY THE RULES ARE QUOTED INTO THE ISSUE AT ALL ──────────────────────────
 * Whoever picks up a portal-drift issue - a human at 03:00 or an unattended
 * repair session - arrives without the context that makes the finding safe to
 * act on. The single most expensive thing either could do is verify a fix by
 * running the automation, which on this carrier creates a real account and a
 * real quote on a production portal. Rule 10a says so; an issue that does not
 * say so is an invitation.
 *
 * These are short quotations, deliberately. They are a pointer with enough
 * substance to act on, not a copy of the file - the file is the source of truth
 * and it moves.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface RuleReference {
  /** As written in AGENTS.md: '1', '9b', '10a'. */
  id: string;
  title: string;
  /** One or two sentences, enough to act on without opening the file. */
  gist: string;
}

const RULES: readonly RuleReference[] = [
  {
    id: '1',
    title: 'Business vs System is the contract everything hinges on',
    gist:
      'A BusinessException failed immediately and is NEVER retried; anything else is a system ' +
      'failure and the same item is retried on a fresh browser. The test: would running this again, ' +
      'on a fresh browser, plausibly give a different answer? Yes -> System. No -> Business.',
  },
  {
    id: '2',
    title: 'No PII, no real customer data, anywhere',
    gist:
      'Not in seed files, fixtures, examples, tests or comments - and not in a screenshot, a ' +
      'baseline or an issue body either. Carry references, not records.',
  },
  {
    id: '5',
    title: 'Selectors live only in src/pages/',
    gist:
      'Preference order: getByRole -> getByLabel/getByPlaceholder -> getByTestId -> CSS (page ' +
      'objects only). No XPath anywhere.',
  },
  {
    id: '7',
    title: 'initialize() must be idempotent',
    gist:
      'The runner calls it again after EVERY session recovery, and a recovered browser has no ' +
      'cookies. If it assumes it runs once, the first retry executes against a signed-out portal ' +
      'and fails for a different reason than the original error.',
  },
  {
    id: '9',
    title: 'Portal work goes through step(), always',
    gist:
      'Precondition -> action -> postcondition, including "just clicking Next". The postcondition ' +
      'is checked BEFORE the action too, so an already-satisfied step is skipped - which means a ' +
      'postcondition must reference a payload value, or the skip-ahead sails past real work.',
  },
  {
    id: '9b',
    title: 'Gates must WAIT. Never isVisible() in a gate',
    gist:
      'isVisible() is Playwright\'s one non-waiting assertion: it snapshots the DOM now and returns ' +
      'false if the element has not rendered yet. Use visible / hidden / valueIs / textVisible from ' +
      '@rpa/core. Note also that step() caps EVERY gate at the step\'s own timeoutMs, so a gate ' +
      'budget above the step budget is silently truncated.',
  },
  {
    id: '10',
    title: 'Carrier PoCs: allowSubmit stays false',
    gist:
      'Both carrier automations run against production portals with no sandbox, and signing ' +
      '(Anthem) and attestation (UHC) are irreversible. Do not flip it to verify something - ask.',
  },
  {
    id: '10a',
    title: 'ANTHEM PRODUCTION IS FROZEN (from 2026-09-04)',
    gist:
      'The ONLY things permitted against Anthem production are SIGNING IN and NAVIGATING. Nothing ' +
      'that creates or changes a record, regardless of allowSubmit - a run at allowSubmit: false ' +
      'still creates a real account and a real quote. `pnpm rpa run ' +
      'group-submission/anthem-ca-new-plans` is NOT allowed at any setting. Permitted: ' +
      'tooling/scripts/check-portal-access.ts, tooling/scripts/check-portal-navigation.ts, and the ' +
      'read-only recon harness.',
  },
];

const BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

/** Resolves rule numbers to quotable references, preserving the given order. */
export function resolveRules(ids: readonly string[]): readonly RuleReference[] {
  return ids.map((id) => BY_ID.get(id)).filter((rule): rule is RuleReference => rule !== undefined);
}

/**
 * Gotchas worth attaching to a specific shape of finding.
 *
 * A gate that failed after burning exactly its step's budget is almost never a
 * broken locator, and a reader who does not know that will go looking for one.
 */
export const GOTCHA_HINTS: Readonly<Record<string, string>> = {
  'gate-failed-screen-matched':
    'The screen matches its baseline, so before suspecting the portal check three things this repo ' +
    'has already paid for: (a) step() caps every gate at the step\'s own timeoutMs, so ' +
    'visible(x, 300_000) inside a step with no timeoutMs really waits 60s; (b) isVisible() in a ' +
    'gate does not wait, and has already failed a precondition on a dashboard that was still ' +
    'painting; (c) a locator may be ambiguous rather than wrong - check the recon dump\'s ' +
    'AMBIGUOUS section rather than reaching for .first().',
  'gate-failed-screen-drifted':
    'Both halves agree, so start from the delta below rather than from the locator. Re-map the ' +
    'screen with the recon dump and read the ACCESSIBLE NAME, not the visible text - on this ' +
    'portal a button reading "Continue" is named "Login", and the checklist\'s "Submit" is named ' +
    '"documentCheckListSubmit".',
  'pass-unknown-screen':
    'An unmapped screen is either genuinely new or one we know that changed beyond recognition. ' +
    'Record it before changing anything: describeCurrentScreen exists for exactly this, and the ' +
    'reading is more useful than a screenshot because the portal\'s own wording is in it.',
  'pass-drift':
    'Nothing is broken yet, which makes this the cheapest possible moment to act. Decide which it ' +
    'is: the automation needs updating, or the portal genuinely changed and the baseline should be ' +
    're-blessed with a note. Both are legitimate outcomes.',
};
