import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import { serializeError } from '../errors.ts';
import type { SecretResolver } from '../secrets.ts';
import type { StepContext } from '../steps.ts';
import { BaselineStore, EvidenceStore } from './evidence.ts';
import { GENERIC_CAUSES, type KnownCause } from './known-causes.ts';
import type { MfaBudget, Probe, ProbeContext } from './probe.ts';
import type { Redactor } from './redact.ts';
import { buildSignature, type RawScreenInput } from './signature.ts';
import { diffSignatures } from './delta.ts';
import type {
  BaselineStatus,
  ProbeEvidence,
  ProbeVerdict,
  RuntimeFacts,
  ScreenObservation,
  SessionFacts,
  StepTrace,
} from './types.ts';
import { SIGNATURE_VERSION } from './signature.ts';

/**
 * Runs one probe and assembles its evidence record.
 *
 * The engine owns everything that must be true regardless of carrier: the
 * runtime facts, the MFA budget, the baseline comparison, the evidence layout,
 * and closing the browser context in a `finally`. A probe owns only the
 * observation.
 *
 * ── ONE BROWSER, ONE CONTEXT PER PROBE ──────────────────────────────────────
 * A fresh context per probe, because rule 8's reasoning applies here too: a
 * probe that inherits cookies from the previous one is not measuring what it
 * thinks it is. One browser across the set, because launching Chromium costs
 * about a minute and the access probe runs every fifteen.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface RunProbeOptions {
  probe: Probe;
  browser: Browser;
  runId: string;
  secrets: SecretResolver;
  logger: Logger;
  redactor: Redactor;
  evidence: EvidenceStore;
  baselines: BaselineStore;
  paths: { repoRoot: string; dataDir: string };
  runtime: RuntimeFacts;
  mfaBudget: MfaBudget;
  /** Reads the current screen. Supplied by the caller so core stays carrier-free. */
  readScreen: (page: Page) => Promise<RawScreenInput | undefined>;
  /** Screenshot capture, masked. Omitted when the caller does not want images. */
  capture?: (page: Page, file: string, masks: readonly Locator[]) => Promise<void>;
}

export interface ProbeRun {
  evidence: ProbeEvidence;
  /** The redacted raw readings, for the evidence writer. */
  readings: readonly { screenId: string; redactedReading: unknown }[];
}

export async function runProbe(options: RunProbeOptions): Promise<ProbeRun> {
  const { probe, logger } = options;
  const startedAt = new Date();

  const steps: StepTrace[] = [];
  const screens: ScreenObservation[] = [];
  const readings: { screenId: string; redactedReading: unknown }[] = [];

  let failedStep: string | undefined;
  let failedGate: 'precondition' | 'postcondition' | undefined;
  let thrown: unknown;
  let httpStatus: number | undefined;

  const session: SessionFacts = {
    storedSessionPresent: false,
    storedSessionAgeMs: undefined,
    liveness: 'not-probed',
    signedInVia: 'not-attempted',
    samlReauthenticated: false,
    mfaCodeSpent: false,
  };

  const context = await options.browser.newContext({ viewport: { width: 1440, height: 900 } });

  try {
    const page = await context.newPage();
    let active: Page = page;

    /**
     * The main navigation's status, captured once.
     *
     * Only the first document response is meaningful: a status read partway
     * through a signed-in single-page app describes an XHR rather than the
     * screen, which is why `httpStatus` is a probe-level fact and not a
     * per-screen one.
     */
    page.once('response', (response) => {
      if (httpStatus === undefined && response.request().isNavigationRequest()) {
        httpStatus = response.status();
      }
    });

    /**
     * The gate-failure hook. `step()` swallows whatever this throws - by design,
     * so evidence capture can never replace the failure that triggered it - so
     * the recording here is best-effort on purpose.
     */
    const stepContext: StepContext = {
      logger,
      onGateFailure: async ({ step, gate }) => {
        failedStep = step;
        failedGate = gate;
        steps.push({ step, gate, outcome: 'failed', durationMs: 0 });
        logger.warn({ step, gate }, 'A probe gate failed');
      },
    };

    const observe = async (screenId: string, target?: Page): Promise<void> => {
      const from = target ?? active;
      const raw = await options.readScreen(from);

      if (raw === undefined) {
        logger.warn({ screenId }, 'Could not read the screen; recording no observation for it');
        return;
      }

      const signature = buildSignature(raw, {
        screenId,
        redactor: options.redactor,
        ...(probe.isInformationalAlert === undefined
          ? {}
          : { isInformationalAlert: probe.isInformationalAlert }),
      });

      const baseline = await options.baselines.read(screenId);
      const status = baselineStatus(baseline?.signature.version, baseline !== undefined);

      /**
       * Only compared when there is something comparable. `absent` and
       * `version-mismatch` deliberately produce NO delta rather than an empty
       * one - "we did not compare" and "we compared and found nothing" are
       * different findings, and collapsing them would report a brand-new screen
       * as unchanged.
       */
      const delta =
        baseline !== undefined && status === 'matched'
          ? diffSignatures(baseline.signature, signature)
          : undefined;

      const observation: ScreenObservation = {
        screenId,
        signature,
        baseline: status === 'matched' && delta?.meaningful === true ? 'drifted' : status,
        delta,
        maskedScreenshot: await maybeCapture(options, probe, from, screenId),
      };

      screens.push(observation);
      readings.push({ screenId, redactedReading: raw });
    };

    const ctx: ProbeContext = {
      page,
      context,
      secrets: options.secrets,
      logger,
      paths: {
        repoRoot: options.paths.repoRoot,
        dataDir: options.paths.dataDir,
        evidenceDir: options.evidence.dirFor(probe.id),
      },
      steps: stepContext,
      followPage: (next: Page) => {
        active = next;
      },
      observe,
      recordSession: (facts) => Object.assign(session, facts),
      mfaBudget: options.mfaBudget,
    };

    await probe.run(ctx);
  } catch (cause) {
    thrown = cause;
  } finally {
    /**
     * Always. An unclosed context leaks a browser process that then holds the
     * persistent profile, and every later run fails for that reason instead of
     * its own - the twenty-orphaned-browsers failure, one layer down.
     */
    await context.close().catch((cause: unknown) => {
      logger.warn({ err: cause }, 'Could not close the probe browser context');
    });
  }

  const endedAt = new Date();
  const verdict: ProbeVerdict = thrown === undefined ? 'pass' : 'fail';

  const evidence: ProbeEvidence = {
    schemaVersion: 1,
    probeId: probe.id,
    carrier: probe.carrier,
    runId: options.runId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    verdict,
    runtime: options.runtime,
    steps,
    failedStep,
    failedGate,
    error: thrown === undefined ? undefined : options.redactor.deep(serializeError(thrown)),
    portalMessage: undefined,
    session,
    screens,
    httpStatus,
  };

  return { evidence, readings };
}

async function maybeCapture(
  options: RunProbeOptions,
  probe: Probe,
  page: Page,
  screenId: string,
): Promise<string | undefined> {
  if (options.capture === undefined) return undefined;

  const file = path.join(options.evidence.dirFor(probe.id), `screenshot.${slug(screenId)}.masked.png`);
  const masks = probe.maskLocators?.(page) ?? [];

  try {
    await options.capture(page, file, masks);
    return file;
  } catch (cause) {
    options.logger.warn({ screenId, err: cause }, 'Could not capture a masked screenshot');
    return undefined;
  }
}

/**
 * A baseline written under a different normalization version is INCONCLUSIVE,
 * never drift.
 *
 * Comparing across versions produces confident nonsense, and the failure would
 * look exactly like real drift on every screen at once - which is the most
 * misleading possible output from a drift detector.
 */
function baselineStatus(version: number | undefined, present: boolean): BaselineStatus {
  if (!present) return 'absent';
  if (version !== SIGNATURE_VERSION) return 'version-mismatch';
  return 'matched';
}

/** The machine, not the portal. Roughly half of all known causes are runtime causes. */
export function readRuntimeFacts(options: {
  headless: boolean;
  gitCommit?: string;
}): RuntimeFacts {
  return {
    headless: options.headless,
    display: process.env['DISPLAY'],
    platform: `${process.platform}/${process.arch}`,
    /**
     * `/.dockerenv` is the cheap and reliable signal. Reading `/proc/1/cgroup`
     * catches more container runtimes but is absent on macOS, and the point of
     * this field is to tell a container failure from a laptop failure rather
     * than to identify the runtime precisely.
     */
    inContainer: existsSync('/.dockerenv'),
    nodeVersion: process.version,
    gitCommit: options.gitCommit,
    hostname: hostname(),
  };
}

/**
 * Decides whether a probe may spend an MFA code, before it runs.
 *
 * The ordering is the point. A living session costs nothing, so it is checked
 * first and no budget is granted - a probe that signed in anyway would be
 * spending a code for no reason. Only a genuinely lapsed session reaches the
 * daily cap.
 */
export function decideMfaBudget(input: {
  probe: Pick<Probe, 'maySpendMfa'>;
  liveness: 'alive' | 'lapsed' | 'absent' | 'not-probed';
  spentToday: number;
  maxPerDay: number;
}): MfaBudget {
  if (!input.probe.maySpendMfa) return { allowed: false, reason: 'not-requested' };
  if (input.liveness === 'alive') return { allowed: false, reason: 'session-alive' };
  if (input.spentToday >= input.maxPerDay) return { allowed: false, reason: 'budget-spent' };
  return { allowed: true, reason: 'budget-available' };
}

/**
 * Carrier causes first, so a specific row can pre-empt a generic one.
 *
 * `matchKnownCause` is first-match-wins, so this order is behaviour rather than
 * taste: a carrier that knows its own bot-block wording should be consulted
 * before the generic pattern list gets a chance to file an infra issue about it.
 */
export function causesFor(probe: Probe): readonly KnownCause[] {
  return [...probe.knownCauses, ...GENERIC_CAUSES];
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unnamed';
}
