import type { BrowserContext, Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import type { SecretResolver } from '../secrets.ts';
import type { StepContext } from '../steps.ts';
import type { KnownCause } from './known-causes.ts';
import type { ProbeEvidence, ProbeVerdict, SessionFacts } from './types.ts';

/**
 * What a probe is, and what the engine promises it.
 *
 * ── A PROBE CREATES NOTHING ─────────────────────────────────────────────────
 * That is not a convention, it is the reason probes exist at all. Anthem
 * production is frozen to signing in and navigating (rule 10a), and a run at
 * `allowSubmit: false` still creates a real account and a real quote - so
 * "monitor the portal" cannot mean "run the automation". A probe is the largest
 * observation that writes nothing.
 *
 * The engine enforces the part it can: it never resolves credentials for a
 * probe that did not ask for them, and it never grants an MFA budget to a probe
 * that did not declare it might spend one. The rest is the probe's own
 * discipline, backed by a source-level test that no probe module imports the
 * runner.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Which cadence a probe belongs to. See `docs/operations.md`. */
export type ProbeSetName = 'access' | 'session' | 'navigation';

export interface MfaBudget {
  /**
   * May this probe spend a one-time code?
   *
   * The engine decides from the stored session's liveness and the daily cap. A
   * probe MUST honour it: a code takes a measured 132-600s to arrive through
   * the forward, expires on a countdown, and is delivered primarily to a
   * mailbox we cannot read. Spending one speculatively is the most expensive
   * thing the schedule can do.
   */
  allowed: boolean;
  /** Why, for the evidence record and the report. */
  reason: 'session-alive' | 'budget-available' | 'budget-spent' | 'not-requested';
}

export interface ProbeContext {
  page: Page;
  context: BrowserContext;
  secrets: SecretResolver;
  logger: Logger;
  paths: {
    repoRoot: string;
    dataDir: string;
    /** Where this probe's evidence goes. Already created. */
    evidenceDir: string;
  };
  /** A `step()` context whose gate failures are recorded into the evidence. */
  steps: StepContext;
  /**
   * Where evidence should be read from, from now on.
   *
   * Mutable for the same reason `AnthemStepContext.followPage` is: `Create
   * Quote` opens a NEW TAB on another host, and the first version of that hook
   * photographed the launcher while the failure was three screens deep
   * elsewhere.
   */
  followPage(page: Page): void;
  /**
   * Reads the current screen, normalizes it, compares it against its baseline,
   * and records the observation.
   *
   * Call it at every screen worth watching - including ones the probe passes
   * through successfully, because a screen that still works but has changed is
   * the early warning this whole design exists for.
   */
  observe(screenId: string, page?: Page): Promise<void>;
  /** Report what the sign-in actually cost. The engine cannot see this itself. */
  recordSession(facts: Partial<SessionFacts>): void;
  mfaBudget: MfaBudget;
}

export interface Probe {
  /** `<carrier>/<name>`, e.g. `anthem-ca/portal-navigation`. */
  id: string;
  carrier: string;
  /** One line, for `--list` and the issue title. */
  title: string;
  sets: readonly ProbeSetName[];
  /**
   * `false` means the engine never resolves a credential for this probe.
   *
   * Enforced rather than documented: the credential-free access probe is the
   * one that answers "does the carrier serve us a page at all", and it should
   * be impossible for it to start depending on a password.
   */
  needsCredentials: boolean;
  /** `false` means the engine never grants an MFA budget, whatever the session state. */
  maySpendMfa: boolean;
  /** Screens it can visit, so a missing baseline is a config error rather than a surprise. */
  screenIds: readonly string[];
  /** Carrier-specific causes, concatenated with `GENERIC_CAUSES` by the engine. */
  knownCauses: readonly KnownCause[];
  /**
   * Locators whose CONTENTS must be painted over before any screenshot is written.
   *
   * Deny-by-default is the intended posture - see the repair half's `masks.ts`.
   * A field the list has never heard of should be masked, not published.
   */
  maskLocators?: (page: Page) => Locator[];
  /**
   * Alerts that are informational rather than complaints.
   *
   * Pass the carrier's own classifier inverted, never a fresh list of strings:
   * this portal carries "We've redesigned your dashboard!" in the same alert
   * region as its validation errors, and re-deriving "is this a complaint?" is
   * how the two answers drift apart.
   */
  isInformationalAlert?: (text: string) => boolean;
  /** The observation. Throws to fail; returning normally is a pass. */
  run(ctx: ProbeContext): Promise<void>;
  /**
   * The human-readable verdict text.
   *
   * This is where the load-bearing wording from the hand-run check scripts
   * lives - the paragraph that names the likely cause and explicitly retracts
   * the container theory. One definition, printed by both the script wrapper
   * and the sentinel, so a diagnostic and a monitor cannot come to disagree.
   */
  explain(evidence: ProbeEvidence): readonly string[];
}

/** The default export of an automation's `src/sentinel/probes.ts`. */
export interface ProbeSet {
  probes: readonly Probe[];
}

/**
 * Asserts a module really is a probe set, at load time.
 *
 * `registry.ts` takes the same posture for automation definitions, and for the
 * same reason: a probe set is loaded by a computed path at 02:00, and a
 * mis-shaped module should fail with a sentence rather than a
 * `TypeError: probes is not iterable` three frames deep.
 */
export function assertProbeSet(value: unknown, source: string): asserts value is ProbeSet {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${source} must default-export a ProbeSet object`);
  }

  const candidate = value as { probes?: unknown };
  if (!Array.isArray(candidate.probes)) {
    throw new Error(`${source} must default-export { probes: Probe[] }`);
  }

  for (const [index, probe] of candidate.probes.entries()) {
    const where = `${source} probes[${index}]`;
    if (probe === null || typeof probe !== 'object') throw new Error(`${where} is not an object`);

    const spec = probe as Partial<Probe>;
    for (const field of ['id', 'carrier', 'title'] as const) {
      if (typeof spec[field] !== 'string' || spec[field] === '') {
        throw new Error(`${where} is missing a non-empty "${field}"`);
      }
    }
    if (typeof spec.run !== 'function') throw new Error(`${where}.run must be a function`);
    if (typeof spec.explain !== 'function') throw new Error(`${where}.explain must be a function`);
    if (!Array.isArray(spec.sets) || spec.sets.length === 0) {
      throw new Error(`${where}.sets must name at least one cadence`);
    }
    if (typeof spec.needsCredentials !== 'boolean') {
      throw new Error(`${where}.needsCredentials must be declared explicitly`);
    }
    if (typeof spec.maySpendMfa !== 'boolean') {
      throw new Error(`${where}.maySpendMfa must be declared explicitly`);
    }
    /**
     * A probe id must not look like an automation id. `rpa sentinel` takes a
     * probe id positionally, and `rpa sentinel group-submission/anthem-ca-new-plans`
     * is one keystroke from the forbidden `rpa run group-submission/anthem-ca-new-plans`.
     * Refusing the shape outright removes the possibility of the confusion.
     */
    if (spec.id?.startsWith('group-submission/') === true || spec.id?.startsWith('member-submission/') === true) {
      throw new Error(
        `${where}.id is "${spec.id}", which reads like an automation id. Probe ids are ` +
          '<carrier>/<probe>, e.g. "anthem-ca/portal-access" - deliberately unlike an automation ' +
          'id, so that a sentinel command can never be confused with `rpa run`.',
      );
    }
  }
}

/** Verdict from a thrown error, for the engine's own bookkeeping. */
export function verdictFor(thrown: unknown): ProbeVerdict {
  return thrown === undefined ? 'pass' : 'fail';
}
