import type { Logger } from 'pino';
import { BusinessException, SystemException, toError } from './errors.ts';
import { withTimeout } from './retry.ts';

/**
 * Precondition -> action -> postcondition, for every portal interaction.
 *
 * A senior RPA developer never fires an action blind and never assumes it
 * landed. This helper makes that discipline structural rather than a matter of
 * remembering, and it is where each of the three interesting failure modes gets
 * its correct classification:
 *
 *   precondition fails  -> we are not on the screen we thought. The SESSION is
 *                          wrong, so it is a SystemException and the runner
 *                          relaunches and re-authenticates.
 *   portal rejects data -> the portal looked at the value and refused it. That
 *                          is a BusinessException; no retry will change it.
 *   postcondition fails -> the click or fill did not take effect. Environment,
 *                          so SystemException after one repair attempt.
 *
 * The postcondition is also checked BEFORE the action. If it is already
 * satisfied the step is skipped, which is what makes a resumed submission safe -
 * and both carrier processes document "re-enter the portal mid-submission", so
 * resumability is a real operational requirement here, not a nicety.
 */

export type StepPhase = 'precondition' | 'action' | 'postcondition' | 'repair';

export type StepOutcome =
  /** The postcondition was already satisfied. Nothing was done. */
  | 'skipped'
  /** Action ran and the postcondition held. */
  | 'completed'
  /** Action ran, the postcondition failed, repair fixed it. */
  | 'repaired';

export interface StepResult<T> {
  outcome: StepOutcome;
  /** undefined when the step was skipped. */
  value: T | undefined;
  durationMs: number;
}

export interface StepContext {
  logger: Logger;
  /**
   * Called when a gate fails, before the exception is thrown - the hook the
   * automation uses to capture a screenshot. Kept as a callback so this module
   * depends on neither Playwright nor the artifact store.
   */
  onGateFailure?: (info: { step: string; gate: 'precondition' | 'postcondition' }) => Promise<void>;
}

export interface StepSpec<T = void> {
  /** Appears in every log line for this step, and in artifact filenames. */
  name: string;

  /**
   * Are we where we think we are? Must be cheap and side-effect free.
   *
   * Omit it only when the action is safe from any screen. Most portal steps are
   * not.
   */
  precondition?: () => Promise<boolean>;

  action: () => Promise<T>;

  /**
   * Did it actually take effect?
   *
   * MUST be specific to THIS transaction. "A quote exists" would let the
   * skip-ahead above sail straight past creating a new quote, because the
   * previous group's quote is still on screen. Reference a payload value:
   * "a quote exists for FEIN 881234567".
   */
  postcondition: () => Promise<boolean>;

  /** One repair attempt, between two postcondition checks. */
  repair?: () => Promise<void>;

  /**
   * Reads the portal's OWN validation message. A non-empty return becomes a
   * BusinessException carrying that wording, which is almost always more useful
   * to an operator than anything we could phrase ourselves.
   */
  businessCheck?: () => Promise<string | undefined>;

  timeoutMs?: number;

  /**
   * Opt out of the skip-if-already-satisfied short-circuit, for actions whose
   * postcondition cannot be made transaction-specific.
   */
  alwaysRun?: boolean;
}

const DEFAULT_STEP_TIMEOUT_MS = 60_000;

export async function step<T>(ctx: StepContext, spec: StepSpec<T>): Promise<StepResult<T>> {
  const startedAt = Date.now();
  const logger = ctx.logger.child({ step: spec.name });
  const timeoutMs = spec.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  // ── 1. Already done? This is the resume path. ──
  if (spec.alwaysRun !== true) {
    if (await evaluateGate(logger, spec.postcondition, 'postcondition', timeoutMs)) {
      const durationMs = Date.now() - startedAt;
      logger.info({ phase: 'postcondition', outcome: 'skipped', durationMs }, `Step already satisfied: ${spec.name}`);
      return { outcome: 'skipped', value: undefined, durationMs };
    }
  }

  // ── 2. Are we on the right screen? ──
  if (spec.precondition !== undefined) {
    if (!(await evaluateGate(logger, spec.precondition, 'precondition', timeoutMs))) {
      await reportGateFailure(ctx, spec.name, 'precondition');
      logger.error({ phase: 'precondition', outcome: 'failed' }, `Not in the expected state for: ${spec.name}`);
      throw new SystemException(
        `Precondition failed for step "${spec.name}": the portal is not in the expected state`,
        { details: { step: spec.name, gate: 'precondition' } },
      );
    }
    logger.debug({ phase: 'precondition', outcome: 'ok' }, 'Precondition satisfied');
  }

  // ── 3. Do it. ──
  let value: T;
  try {
    value = await withTimeout(
      spec.action(),
      timeoutMs,
      () =>
        new SystemException(`Step "${spec.name}" exceeded its ${timeoutMs}ms timeout`, {
          details: { step: spec.name, phase: 'action', timeoutMs },
        }),
    );
  } catch (thrown) {
    const error = toError(thrown);
    logger.error({ phase: 'action', outcome: 'failed', err: error }, `Action threw in step: ${spec.name}`);
    throw error;
  }

  // ── 4. Did the portal itself object? ──
  if (spec.businessCheck !== undefined) {
    const message = await spec.businessCheck();
    if (message !== undefined && message.length > 0) {
      logger.warn({ phase: 'action', outcome: 'rejected' }, `Portal rejected the input in step: ${spec.name}`);
      throw new BusinessException(`${spec.name}: ${message}`, {
        details: { step: spec.name, portalMessage: message },
      });
    }
  }

  // ── 5. Did it take effect? ──
  if (await evaluateGate(logger, spec.postcondition, 'postcondition', timeoutMs)) {
    const durationMs = Date.now() - startedAt;
    logger.info({ phase: 'postcondition', outcome: 'completed', durationMs }, `Step completed: ${spec.name}`);
    return { outcome: 'completed', value, durationMs };
  }

  // ── 6. One repair attempt. ──
  if (spec.repair !== undefined) {
    logger.warn({ phase: 'repair' }, `Postcondition failed; attempting repair for: ${spec.name}`);
    await spec.repair();

    if (await evaluateGate(logger, spec.postcondition, 'postcondition', timeoutMs)) {
      const durationMs = Date.now() - startedAt;
      logger.info({ phase: 'repair', outcome: 'repaired', durationMs }, `Step repaired: ${spec.name}`);
      return { outcome: 'repaired', value, durationMs };
    }
  }

  await reportGateFailure(ctx, spec.name, 'postcondition');
  logger.error({ phase: 'postcondition', outcome: 'failed' }, `Step did not take effect: ${spec.name}`);
  throw new SystemException(
    `Postcondition failed for step "${spec.name}": the action ran but did not take effect`,
    { details: { step: spec.name, gate: 'postcondition', repaired: spec.repair !== undefined } },
  );
}

/**
 * Evaluates a gate, converting both a throw and a timeout into `false`.
 *
 * A gate is a question, not an assertion. Locator checks routinely throw rather
 * than return false - a detached element, a navigation mid-check - and letting a
 * Playwright error escape a predicate would bypass the caller's classification
 * entirely.
 *
 * Timing out is deliberately `false` too, and that reading is safe in both
 * places a gate is used: a slow precondition fails loudly, and a slow "already
 * done?" check means the step is attempted rather than skipped. Attempting an
 * idempotent step is cheap; wrongly skipping one is data corruption.
 *
 * Either way the reason is logged, so a gate that is quietly always false or
 * always slow is visible rather than mysterious.
 */
async function evaluateGate(
  logger: Logger,
  gate: () => Promise<boolean>,
  phase: StepPhase,
  timeoutMs: number,
): Promise<boolean> {
  try {
    return await withTimeout(gate(), timeoutMs, () => new GateTimeout());
  } catch (cause) {
    if (cause instanceof GateTimeout) {
      logger.warn({ phase, timeoutMs }, 'Gate check timed out; treating as not satisfied');
    } else {
      logger.debug({ phase, err: cause }, 'Gate check threw; treating as not satisfied');
    }
    return false;
  }
}

/** Internal marker so a gate timeout can be logged differently from a gate throw. */
class GateTimeout extends Error {
  constructor() {
    super('gate timeout');
    this.name = 'GateTimeout';
  }
}

async function reportGateFailure(
  ctx: StepContext,
  stepName: string,
  gate: 'precondition' | 'postcondition',
): Promise<void> {
  if (ctx.onGateFailure === undefined) return;
  try {
    await ctx.onGateFailure({ step: stepName, gate });
  } catch (cause) {
    // Evidence capture must never replace the failure that triggered it.
    ctx.logger.debug({ err: cause }, 'Could not capture gate-failure evidence');
  }
}
