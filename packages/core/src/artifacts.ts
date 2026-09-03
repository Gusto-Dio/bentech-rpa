import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { isEvidenceCapable, type Session } from './contracts/Session.ts';
import { serializeError, type FailureReason } from './errors.ts';
import type { RunSummary } from './runner/summary.ts';

/**
 * REFramework's TakeScreenshot-on-error, plus the thing UiPath never had: a
 * Playwright trace. For an unattended run at 03:00 the trace is usually the
 * difference between "we know what happened" and "run it again and watch".
 */
export interface FailureArtifacts {
  dir: string;
  screenshot: string | undefined;
  trace: string | undefined;
  error: string;
}

export interface ArtifactStoreOptions {
  /** Absolute path to <repoRoot>/artifacts. */
  artifactsDir: string;
  runId: string;
  logger: Logger;
}

export class ArtifactStore {
  readonly #runDir: string;
  readonly #logger: Logger;

  constructor(options: ArtifactStoreOptions) {
    this.#runDir = path.join(options.artifactsDir, options.runId);
    this.#logger = options.logger;
  }

  get runDir(): string {
    return this.#runDir;
  }

  attemptDir(reference: string, attempt: number): string {
    return path.join(this.#runDir, `${sanitizeSegment(reference)}-attempt-${attempt}`);
  }

  /**
   * Evidence capture must never mask the failure that triggered it. If the page
   * is already dead, the screenshot will fail too - that gets logged, and the
   * original error still propagates untouched.
   */
  async captureFailure(input: {
    reference: string;
    attempt: number;
    error: unknown;
    session: Session;
    /**
     * Business failures get a screenshot; system failures also get the trace.
     *
     * A trace runs a few megabytes. For a business rule the screenshot plus
     * error.json already answer "why did it decline this one", whereas a system
     * failure is the case where you genuinely need to replay the session. At
     * 100+ automations on a schedule, keeping traces for the normal outcome
     * would fill a disk for no diagnostic gain.
     */
    reason: FailureReason;
  }): Promise<FailureArtifacts> {
    const dir = this.attemptDir(input.reference, input.attempt);
    await mkdir(dir, { recursive: true });

    const errorFile = path.join(dir, 'error.json');
    await writeFile(errorFile, `${JSON.stringify(serializeError(input.error), null, 2)}\n`, 'utf8');

    let screenshot: string | undefined;
    let trace: string | undefined;

    if (isEvidenceCapable(input.session)) {
      const screenshotFile = path.join(dir, 'screenshot.png');
      try {
        await input.session.captureScreenshot(screenshotFile);
        screenshot = screenshotFile;
      } catch (cause) {
        this.#logger.warn({ err: cause }, 'Could not capture failure screenshot');
      }

      if (input.reason === 'system') {
        const traceFile = path.join(dir, 'trace.zip');
        try {
          await input.session.saveTrace(traceFile);
          trace = traceFile;
        } catch (cause) {
          this.#logger.warn({ err: cause }, 'Could not save failure trace');
        }
      } else {
        // Close the chunk so the next attempt starts a clean one.
        await input.session.discardTrace().catch(() => undefined);
      }
    }

    return { dir, screenshot, trace, error: errorFile };
  }

  async writeRunSummary(summary: RunSummary): Promise<string> {
    await mkdir(this.#runDir, { recursive: true });
    const file = path.join(this.#runDir, 'run-summary.json');
    await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return file;
  }
}

/** Queue references become path segments, so anything exotic is flattened. */
function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'unnamed';
}
