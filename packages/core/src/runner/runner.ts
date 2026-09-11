import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { ArtifactStore } from '../artifacts.ts';
import { loadConfig } from '../config/load.ts';
import type { ResolvedConfig } from '../config/schema.ts';
import { LoggerAuditSink, type AuditSink } from '../contracts/AuditSink.ts';
import type {
  AnyAutomationDefinition,
  AutomationPaths,
  InitContext,
  TxContext,
} from '../contracts/IAutomation.ts';
import type { QueueItem, QueueProvider } from '../contracts/QueueProvider.ts';
import { isEvidenceCapable, type Session } from '../contracts/Session.ts';
import { classifyError, SystemException, toError } from '../errors.ts';
import { createLogger } from '../logger.ts';
import type { AutomationManifest } from '../manifest.ts';
import { createQueueProvider } from '../queue/factory.ts';
import type { RetryOwner } from '../queue/OrchestratorQueueProvider.ts';
import { findAutomation, findRepoRoot, loadAutomationDefinition } from '../registry.ts';
import { createRunId } from '../run-id.ts';
import { computeBackoff, sleep } from '../retry.ts';
import { SecretResolver, type SecretProvider } from '../secrets.ts';
import { installStopSignal } from '../signals.ts';
import { BrowserSession } from '../session/BrowserSession.ts';
import { NoopSession } from '../session/NoopSession.ts';
import { EXIT_CODES, exitCodeFor, type RunSummary } from './summary.ts';
import { TRANSACTION_LOG_STATUS } from './states.ts';

export interface RunOptions {
  automationId: string;
  env: string;
  repoRoot?: string;
  /** Stop after N terminal transactions. A debugging aid, not a production knob. */
  maxItems?: number;
  processEnv?: NodeJS.ProcessEnv;
  /** Injection point for a managed secret store. Defaults to reading process.env. */
  secretProvider?: SecretProvider;
  /**
   * Overrides the configured queue backend. Used by tests and by
   * `rpa run --provider`; production runs resolve it from config.
   */
  queueProvider?: QueueProvider;
}

export interface RunResult {
  summary: RunSummary;
  exitCode: number;
}

export async function runAutomation(options: RunOptions): Promise<RunResult> {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const discovered = await findAutomation(repoRoot, options.automationId);
  const manifest = discovered.manifest;
  const definition = await loadAutomationDefinition(discovered);

  const config = await loadConfig({
    repoRoot,
    automationDir: discovered.dir,
    env: options.env,
    automationSchema: definition.configSchema,
    processEnv: options.processEnv,
  });

  const runId = createRunId();
  const logger = createLogger({
    level: config.logLevel,
    pretty: config.logPretty,
    base: {
      runId,
      automationId: manifest.id,
      domain: manifest.domain,
      env: config.env,
    },
  });

  const artifactsDir = path.resolve(repoRoot, config.artifactsDir);
  const dataDir = path.resolve(repoRoot, config.dataDir);
  const artifacts = new ArtifactStore({ artifactsDir, runId, logger });

  const paths: AutomationPaths = {
    repoRoot,
    automationDir: discovered.dir,
    dataDir,
    artifactsDir,
    runArtifactsDir: artifacts.runDir,
  };

  const session: Session =
    manifest.sessionKind === 'browser'
      ? new BrowserSession({ config: config.browser, logger, videoDir: artifacts.runDir })
      : new NoopSession(logger);

  const audit: AuditSink = new LoggerAuditSink(logger);
  const { stop, dispose: disposeSignals } = installStopSignal(logger);
  const state = new Map<string, unknown>();

  /**
   * The queue backend is resolved from config (local JSON file, or
   * Orchestrator) by queue/factory.ts. The runner only ever sees a
   * QueueProvider plus one fact it must honour: who owns retries.
   */
  const injected = options.queueProvider;
  const bundle =
    injected === undefined
      ? await createQueueProvider({
          config,
          manifest,
          automationDir: discovered.dir,
          dataDir,
          secrets: new SecretResolver(options.secretProvider),
          logger,
          abortSignal: stop.abortSignal,
        })
      : {
          queue: injected,
          retryOwner: readRetryOwner(injected),
          secrets: new SecretResolver(options.secretProvider),
        };

  const queue: QueueProvider = bundle.queue;
  const secrets = bundle.secrets;
  const retryOwner: RetryOwner = bundle.retryOwner;

  /**
   * When the backend owns retries, the runner must not also retry: a System
   * exception is reported once, the backend re-queues, and the two retry counts
   * would otherwise multiply into that many real executions.
   *
   * Config validation already rejects maxRetries > 0 for that mode, but the
   * per-automation manifest override is not visible to it - so the authoritative
   * clamp lives here.
   */
  const configuredMaxRetries = manifest.queue.maxRetries ?? config.maxRetries;
  const maxRetries = retryOwner === 'orchestrator' ? 0 : configuredMaxRetries;

  if (retryOwner === 'orchestrator' && configuredMaxRetries > 0) {
    logger.warn(
      { configuredMaxRetries, retryOwner },
      'The queue backend owns retries, so the runner will not retry. ' +
        'maxRetries is being ignored - set it to 0 to make that explicit.',
    );
  }

  const startedAt = new Date();
  const summary: RunSummary = {
    runId,
    automationId: manifest.id,
    env: config.env,
    startedAt: startedAt.toISOString(),
    endedAt: startedAt.toISOString(),
    durationMs: 0,
    processed: 0,
    success: 0,
    business: 0,
    system: 0,
    retries: 0,
    stopRequested: false,
    aborted: false,
    abortReason: undefined,
  };

  const contexts = createContextFactory({
    runId,
    manifest,
    config,
    logger,
    secrets,
    audit,
    paths,
    stop,
    session,
    state,
  });
  const initContext = contexts.init;

  logger.info(
    {
      state: 'Initialize',
      sessionKind: manifest.sessionKind,
      queue: manifest.queue.name,
      maxRetries,
      headless: config.browser.headless,
      configSources: config.sources,
      secretProvider: secrets.providerName,
    },
    `Starting ${manifest.name}`,
  );
  await audit.emit({
    at: new Date().toISOString(),
    runId,
    automationId: manifest.id,
    type: 'run.started',
    detail: { env: config.env, maxRetries },
  });

  // ── Initialize ────────────────────────────────────────────────────────────
  // A failure here never enters the loop. Half-initialised runs are how a
  // process quietly converts an environment problem into a queue full of
  // failed transactions.
  try {
    await mkdir(artifacts.runDir, { recursive: true });
    await queue.init();
    await session.init();
    await definition.initialize(initContext);
  } catch (thrown) {
    const error = toError(thrown);
    logger.error({ status: 'INIT_FAILED', state: 'Initialize', err: error }, 'Initialize failed; not processing any transaction');
    await audit.emit({
      at: new Date().toISOString(),
      runId,
      automationId: manifest.id,
      type: 'run.aborted',
      detail: { phase: 'initialize', message: error.message },
    });
    await artifacts.captureFailure({
      reference: 'initialize',
      attempt: 1,
      error,
      session,
      reason: 'system',
    });

    summary.aborted = true;
    summary.abortReason = `initialize: ${error.message}`;
    await finish({ summary, startedAt, artifacts, session, queue, audit, disposeSignals, logger });
    return { summary, exitCode: EXIT_CODES.initFailed };
  }

  // ── Transaction loop ──────────────────────────────────────────────────────
  let consecutiveSystemExceptions = 0;

  loop: while (true) {
    if (stop.requested) {
      summary.stopRequested = true;
      logger.warn({ state: 'GetTransactionData', reason: stop.reason }, 'Graceful stop: leaving the transaction loop');
      break;
    }

    if (options.maxItems !== undefined && summary.processed >= options.maxItems) {
      logger.info({ state: 'GetTransactionData', maxItems: options.maxItems }, 'Reached --max-items; leaving the transaction loop');
      break;
    }

    const next = await queue.getNext();
    if (next === null) {
      logger.info({ state: 'GetTransactionData' }, 'Queue drained');
      break;
    }

    let item: QueueItem = next;

    // Retry loop for THIS transaction. Business failures leave immediately;
    // System failures come back around after the session has been recovered.
    attempts: while (true) {
      const attempt = item.retryCount + 1;
      const txLogger = logger.child({
        transactionId: item.id,
        reference: item.reference,
        attempt,
        retry: item.retryCount,
      });

      if (isEvidenceCapable(session)) {
        await session.startTrace(`${item.reference} attempt ${attempt}`);
      }

      txLogger.info({ state: 'ProcessTransaction' }, `Processing ${item.reference}`);
      await audit.emit({
        at: new Date().toISOString(),
        runId,
        automationId: manifest.id,
        type: 'transaction.started',
        reference: item.reference,
        transactionId: item.id,
        attempt,
      });

      try {
        // Payload validation is part of the transaction: bad data is a business
        // failure, and no retry will make it good.
        const payload = definition.parsePayload(item.payload);
        const txContext = contexts.transaction({ ...item, payload }, attempt, txLogger);

        await withTransactionTimeout(
          definition.processTransaction(txContext),
          config.transactionTimeoutMs,
          item.reference,
        );

        await recordSuccess({ item, attempt, session, artifacts, config, keep: config.keepArtifactsOnSuccess });
        await queue.complete(item);

        summary.processed += 1;
        summary.success += 1;
        consecutiveSystemExceptions = 0;

        txLogger.info({ status: TRANSACTION_LOG_STATUS.success }, `${item.reference} succeeded`);
        await audit.emit({
          at: new Date().toISOString(),
          runId,
          automationId: manifest.id,
          type: 'transaction.succeeded',
          reference: item.reference,
          transactionId: item.id,
          attempt,
        });
        break attempts;
      } catch (thrown) {
        const { reason, error } = classifyError(thrown);
        const evidence = await artifacts.captureFailure({
          reference: item.reference,
          attempt,
          error,
          session,
          reason,
        });

        item.lastError = { type: reason, message: error.message, at: new Date().toISOString() };

        if (definition.onTransactionFailure !== undefined) {
          try {
            const payload = safeParsePayload(definition, item.payload);
            await definition.onTransactionFailure(
              contexts.transaction({ ...item, payload }, attempt, txLogger),
              error,
            );
          } catch (hookError) {
            txLogger.warn({ err: hookError }, 'onTransactionFailure hook threw; ignoring');
          }
        }

        // ── Business exception: terminal, no retry ──
        if (reason === 'business') {
          await queue.fail(item, 'business', error);
          summary.processed += 1;
          summary.business += 1;

          txLogger.warn(
            { status: TRANSACTION_LOG_STATUS.business, artifacts: evidence.dir, err: error },
            `${item.reference} violated a business rule`,
          );
          await audit.emit({
            at: new Date().toISOString(),
            runId,
            automationId: manifest.id,
            type: 'transaction.business_failed',
            reference: item.reference,
            transactionId: item.id,
            attempt,
            detail: { message: error.message },
          });
          break attempts;
        }

        // ── System exception: retry, if the runner owns retries and budget remains ──
        if (retryOwner === 'runner' && item.retryCount < maxRetries) {
          summary.retries += 1;
          txLogger.warn(
            { status: 'SYSTEM_EXCEPTION_RETRY', artifacts: evidence.dir, maxRetries, err: error },
            `${item.reference} hit a system error; recovering the session and retrying`,
          );
          await audit.emit({
            at: new Date().toISOString(),
            runId,
            automationId: manifest.id,
            type: 'transaction.retry_scheduled',
            reference: item.reference,
            transactionId: item.id,
            attempt,
            detail: { message: error.message },
          });

          item = await queue.requeue(item);

          try {
            await session.recover();
            // Re-running initialize() is what makes recovery real: the session
            // is fresh, so the automation must log in again. This is why
            // initialize() is documented as having to be idempotent.
            await definition.initialize(initContext);
          } catch (recoveryFailure) {
            const failure = toError(recoveryFailure);
            logger.error({ err: failure }, 'Session recovery failed; aborting the run');
            summary.aborted = true;
            summary.abortReason = `recovery failed: ${failure.message}`;
            await queue.fail(item, 'system', failure);
            summary.processed += 1;
            summary.system += 1;
            break loop;
          }

          await audit.emit({
            at: new Date().toISOString(),
            runId,
            automationId: manifest.id,
            type: 'session.recovered',
            reference: item.reference,
            transactionId: item.id,
            attempt,
          });

          // Abortable: a SIGTERM during backoff wakes immediately, and the
          // retry still runs, so the transaction is never left half-decided.
          await sleep(
            computeBackoff(
              {
                baseMs: config.retryBackoffMs,
                factor: config.retryBackoffFactor,
                maxMs: config.retryBackoffMaxMs,
              },
              item.retryCount,
            ),
            stop.abortSignal,
          );
          continue attempts;
        }

        // ── System exception: terminal for this run ──
        // Either the retry budget is spent, or the backend owns retries and
        // will create the next attempt itself.
        await queue.fail(item, 'system', error);
        summary.processed += 1;
        summary.system += 1;
        consecutiveSystemExceptions += 1;

        txLogger.error(
          { status: TRANSACTION_LOG_STATUS.system, artifacts: evidence.dir, retries: item.retryCount, err: error },
          `${item.reference} failed with a system error after ${item.retryCount} ${item.retryCount === 1 ? 'retry' : 'retries'}`,
        );
        await audit.emit({
          at: new Date().toISOString(),
          runId,
          automationId: manifest.id,
          type: 'transaction.system_failed',
          reference: item.reference,
          transactionId: item.id,
          attempt,
          detail: { message: error.message, retries: item.retryCount },
        });
        break attempts;
      }
    }

    // Circuit breaker. Without this, a portal that went down at 03:00 converts
    // the entire remaining queue into failed transactions that a human then has
    // to sort out one by one.
    if (consecutiveSystemExceptions >= config.maxConsecutiveSystemExceptions) {
      summary.aborted = true;
      summary.abortReason = `ABORTED_UNSTABLE: ${consecutiveSystemExceptions} consecutive system exceptions`;
      logger.error(
        { status: 'ABORTED_UNSTABLE', consecutiveSystemExceptions },
        'Too many consecutive system exceptions; the target system looks unavailable. Stopping.',
      );
      await audit.emit({
        at: new Date().toISOString(),
        runId,
        automationId: manifest.id,
        type: 'run.aborted',
        detail: { reason: 'circuit_breaker', consecutiveSystemExceptions },
      });
      break;
    }
  }

  // ── EndProcess ────────────────────────────────────────────────────────────
  summary.stopRequested = summary.stopRequested || stop.requested;

  try {
    await definition.endProcess(initContext, summary);
  } catch (thrown) {
    logger.error({ status: 'END_PROCESS_FAILED', err: toError(thrown) }, 'endProcess threw; continuing teardown');
  }

  await finish({ summary, startedAt, artifacts, session, queue, audit, disposeSignals, logger });
  return { summary, exitCode: exitCodeFor(summary) };
}

interface FinishInput {
  summary: RunSummary;
  startedAt: Date;
  artifacts: ArtifactStore;
  session: Session;
  queue: QueueProvider;
  audit: AuditSink;
  disposeSignals: () => void;
  logger: Logger;
}

/** Always runs, on every exit path. An unattended process must not leave a browser behind. */
async function finish(input: FinishInput): Promise<void> {
  const endedAt = new Date();
  input.summary.endedAt = endedAt.toISOString();
  input.summary.durationMs = endedAt.getTime() - input.startedAt.getTime();

  let queueStats: unknown;
  try {
    queueStats = await input.queue.stats();
  } catch {
    queueStats = undefined;
  }

  try {
    await input.session.close();
  } catch (thrown) {
    input.logger.warn({ err: thrown }, 'Failed to close the session cleanly');
  }

  try {
    await input.artifacts.writeRunSummary(input.summary);
  } catch (thrown) {
    input.logger.warn({ err: thrown }, 'Failed to write run-summary.json');
  }

  await input.audit.emit({
    at: endedAt.toISOString(),
    runId: input.summary.runId,
    automationId: input.summary.automationId,
    type: input.summary.aborted ? 'run.aborted' : 'run.finished',
    detail: { ...input.summary },
  });

  input.logger.info(
    {
      state: 'EndProcess',
      status: input.summary.aborted ? 'ABORTED' : 'COMPLETED',
      processed: input.summary.processed,
      success: input.summary.success,
      business: input.summary.business,
      system: input.summary.system,
      retries: input.summary.retries,
      durationMs: input.summary.durationMs,
      queueStats,
      artifacts: input.artifacts.runDir,
    },
    'Run finished',
  );

  await input.queue.close();
  await input.audit.close();
  input.disposeSignals();
}

interface ContextSeed {
  runId: string;
  manifest: AutomationManifest;
  config: ResolvedConfig<unknown>;
  logger: Logger;
  secrets: SecretResolver;
  audit: AuditSink;
  paths: AutomationPaths;
  stop: ReturnType<typeof installStopSignal>['stop'];
  session: Session;
  state: Map<string, unknown>;
}

interface ContextFactory {
  init: InitContext<unknown>;
  transaction(item: QueueItem, attempt: number, logger: Logger): TxContext<unknown, unknown>;
}

/**
 * Builds the contexts handed to the automation.
 *
 * `page` is exposed as a getter, not a captured value: after session.recover()
 * the Page object is a different instance, and a stale reference would fail on
 * the very retry it was created for.
 *
 * The two casts below are the only unsound ones in the codebase, and they are
 * deliberately concentrated here. WebInitContext/WebTxContext declare a
 * non-optional `page`, which is true exactly when sessionKind is "browser" -
 * a condition the runner, not the automation author, is responsible for.
 */
function createContextFactory(seed: ContextSeed): ContextFactory {
  const base = {
    runId: seed.runId,
    manifest: seed.manifest,
    config: seed.config,
    secrets: seed.secrets,
    audit: seed.audit,
    paths: seed.paths,
    stop: seed.stop,
    session: seed.session,
    state: seed.state,
  };

  const browserSession = seed.session instanceof BrowserSession ? seed.session : undefined;

  const init = (
    browserSession === undefined
      ? { ...base, logger: seed.logger }
      : {
          ...base,
          logger: seed.logger,
          get page() {
            return browserSession.page;
          },
        }
  ) as InitContext<unknown>;

  return {
    init,
    transaction(item: QueueItem, attempt: number, logger: Logger): TxContext<unknown, unknown> {
      const tx =
        browserSession === undefined
          ? { ...base, logger, item, attempt }
          : {
              ...base,
              logger,
              item,
              attempt,
              get page() {
                return browserSession.page;
              },
            };
      return tx as TxContext<unknown, unknown>;
    },
  };
}

/**
 * Wall-clock guard for one transaction.
 *
 * Racing a promise does not cancel the work behind it - Playwright has no
 * cancellation token. What makes this safe is what happens next: a timeout is a
 * System exception, so the runner tears the whole session down and relaunches
 * it, which unblocks anything stuck in the old browser.
 */
async function withTransactionTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  reference: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new SystemException(
              `Transaction "${reference}" exceeded transactionTimeoutMs (${timeoutMs}ms)`,
              { details: { reference, timeoutMs } },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function recordSuccess(input: {
  item: QueueItem;
  attempt: number;
  session: Session;
  artifacts: ArtifactStore;
  config: ResolvedConfig<unknown>;
  keep: boolean;
}): Promise<void> {
  if (!isEvidenceCapable(input.session)) return;

  if (!input.keep) {
    await input.session.discardTrace();
    return;
  }

  const dir = input.artifacts.attemptDir(input.item.reference, input.attempt);
  await mkdir(dir, { recursive: true });
  await input.session.saveTrace(path.join(dir, 'trace.zip'));
}

/** The failure hook should still receive a payload even when parsing was what failed. */
function safeParsePayload(definition: AnyAutomationDefinition, raw: unknown): unknown {
  try {
    return definition.parsePayload(raw);
  } catch {
    return raw;
  }
}

/**
 * An injected provider may declare retry ownership (the Orchestrator provider
 * does). Anything that does not is assumed to leave retries to the runner,
 * which is the behaviour every local provider wants.
 */
function readRetryOwner(provider: QueueProvider): RetryOwner {
  const declared = (provider as { retryOwner?: unknown }).retryOwner;
  return declared === 'orchestrator' ? 'orchestrator' : 'runner';
}

