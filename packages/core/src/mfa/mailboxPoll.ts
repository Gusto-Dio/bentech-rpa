import type { Logger } from 'pino';
import { SystemException } from '../errors.ts';
import { sleep } from '../retry.ts';
import { extractMfaCode, isAllowedSender, type MfaCodeRequest } from './MfaCodeProvider.ts';

/**
 * ── THE RULES, WRITTEN ONCE ──────────────────────────────────────────────────
 * Both Gmail providers differ only in how they reach the mailbox. The parts
 * that matter for correctness and containment - the `since` watermark, the
 * sender allow-list, consume-once - are identical, so they live here and each
 * provider is reduced to an MfaMailbox.
 *
 * The reason is not brevity. Two providers each implementing the watermark is
 * exactly how one of them ends up accepting a stale code: it would work in
 * every test, fail once a month in production, and look like a portal fault.
 *
 * Internal. Not exported from index.ts, like orchestrator/testFetch.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface MfaMessage {
  id: string;
  /** Raw From header, e.g. `Anthem <no-reply@anthem.com>`. */
  from: string;
  subject: string;
  /** When the mail server received it. This is what the watermark compares. */
  receivedAt: Date;
  /** Body text the code is extracted from. NEVER logged. */
  text: string;
}

export interface MfaMailbox {
  readonly name: string;

  /**
   * Returns candidates from ONLY `request.matcher.label`, newest first.
   *
   * A throw propagates and ends the poll immediately rather than being retried
   * here: each provider knows which of its own failures are transient, and a
   * profile that is not signed in must fail loudly instead of being retried
   * silently for three minutes.
   */
  search(request: MfaCodeRequest): Promise<readonly MfaMessage[]>;

  /** Marks the message read so a retry cannot reuse the code. Never deletes. */
  consume(id: string): Promise<void>;
}

export interface PollDependencies {
  logger: Logger;
  pollIntervalMs: number;
  /** Injected in tests so a three-minute timeout does not take three minutes. */
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  /** The run's stop signal, so SIGTERM is not held up waiting for mail. */
  abortSignal?: AbortSignal;
}

type RejectReason = 'stale' | 'sender-not-allowed' | 'subject-mismatch' | 'no-code-in-body';

export interface SelectedCode {
  messageId: string;
  code: string;
}

/**
 * Picks the first message that passes every rule.
 *
 * Pure and separately tested, because this function is the security boundary:
 * the sender allow-list is what stops a spoofed "your code is 000000" sitting
 * in the same label from being used, and the watermark is what stops a retry
 * replaying the previous attempt's code.
 */
export function selectCode(
  messages: readonly MfaMessage[],
  request: MfaCodeRequest,
  logger: Logger,
): SelectedCode | undefined {
  const sinceMs = request.since.getTime();

  for (const message of messages) {
    const reason = rejectionReason(message, request, sinceMs);
    if (reason !== undefined) {
      // messageId only. Never the code, its length, the body, or the subject.
      logger.debug({ messageId: message.id, reason }, 'Ignoring a message in the MFA label');
      continue;
    }

    const code = extractMfaCode(message.text, request.matcher);
    // rejectionReason already proved a code is present, so this is unreachable
    // in practice; the guard keeps the types honest without an assertion.
    if (code === undefined) continue;

    return { messageId: message.id, code };
  }

  return undefined;
}

function rejectionReason(
  message: MfaMessage,
  request: MfaCodeRequest,
  sinceMs: number,
): RejectReason | undefined {
  /**
   * Strictly after the watermark. A message that arrived in the same
   * millisecond as the password submission cannot be a response to it.
   */
  if (message.receivedAt.getTime() <= sinceMs) return 'stale';

  // A message in the right label from the wrong sender is not a code.
  if (!isAllowedSender(message.from, request.matcher)) return 'sender-not-allowed';

  const { subjectContains } = request.matcher;
  if (subjectContains !== undefined && subjectContains.length > 0) {
    if (!message.subject.toLowerCase().includes(subjectContains.toLowerCase())) {
      return 'subject-mismatch';
    }
  }

  if (extractMfaCode(message.text, request.matcher) === undefined) return 'no-code-in-body';

  return undefined;
}

/**
 * Polls a mailbox until a code arrives or `request.timeoutMs` elapses.
 *
 * A timeout is a SystemException, never Business: the mail was late, and a
 * retry with a fresh login trigger can genuinely succeed.
 */
export async function pollForCode(
  mailbox: MfaMailbox,
  request: MfaCodeRequest,
  deps: PollDependencies,
): Promise<string> {
  const now = deps.now ?? Date.now;
  const doSleep = deps.sleepImpl ?? ((ms: number): Promise<void> => sleep(ms, deps.abortSignal));
  const logger = deps.logger.child({ mailbox: mailbox.name, purpose: request.purpose });

  const startedAt = now();
  const deadline = startedAt + request.timeoutMs;
  let polls = 0;

  logger.info(
    { timeoutMs: request.timeoutMs, label: request.matcher.label, since: request.since.toISOString() },
    'Waiting for an MFA code',
  );

  for (;;) {
    polls += 1;
    const selected = selectCode(await mailbox.search(request), request, logger);

    if (selected !== undefined) {
      /**
       * Consume BEFORE returning. If marking read fails we must not hand the
       * code back: the next attempt would find the same message, accept it as
       * new, and submit a code the portal has already invalidated.
       */
      await mailbox.consume(selected.messageId);

      logger.info(
        { messageId: selected.messageId, polls, waitedMs: now() - startedAt },
        'MFA code received and the message was marked read',
      );
      return selected.code;
    }

    if (deps.abortSignal?.aborted === true) {
      throw new SystemException('Stopped waiting for an MFA code because the run is shutting down', {
        details: { mailbox: mailbox.name, purpose: request.purpose, polls },
      });
    }

    // Stop before a sleep that would overshoot the deadline anyway.
    if (now() + deps.pollIntervalMs >= deadline) break;
    await doSleep(deps.pollIntervalMs);
  }

  throw new SystemException(
    `No MFA code arrived for "${request.purpose}" within ${request.timeoutMs}ms. ` +
      `Checked the "${request.matcher.label}" label ${polls} time(s) for mail from ` +
      `${request.matcher.fromAllowList.join(', ')} newer than ${request.since.toISOString()}.`,
    {
      details: {
        /**
         * Callers branch on this. "The mail was late" and "the mailbox could
         * not be read" are both System failures but call for opposite
         * responses - the first is worth asking the carrier to resend, the
         * second means resending would bury the real fault.
         */
        reason: 'timeout',
        mailbox: mailbox.name,
        purpose: request.purpose,
        label: request.matcher.label,
        timeoutMs: request.timeoutMs,
        polls,
      },
    },
  );
}
