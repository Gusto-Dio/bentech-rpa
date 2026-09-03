/**
 * ── MFA SEAM ─────────────────────────────────────────────────────────────────
 * Both carrier portals require MFA, and the code arrives as email in a Gmail
 * label. This interface is what the automations code against, so swapping how
 * the code is obtained - persistent browser profile today, Gmail API tomorrow,
 * an SMS gateway or an authenticator seed later - touches one class and no
 * automation.
 *
 * It deliberately mirrors SecretProvider: same shape, same reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface MfaMatcher {
  /**
   * The Gmail label the carrier's MFA mail is filtered into.
   *
   * A dedicated label is a containment control, not a convenience: the provider
   * queries only this label, so it never lists or searches the rest of the
   * mailbox. See docs/poc/mfa-gmail.md for the filter.
   */
  label: string;

  /** Senders permitted to supply a code. A match outside this list is ignored. */
  fromAllowList: readonly string[];

  /** Extracts the code. The first capture group, or the whole match if there is none. */
  codePattern: RegExp;

  /** Optional extra narrowing when a sender emits more than one kind of mail. */
  subjectContains?: string;
}

export interface MfaCodeRequest {
  /**
   * Only accept a code that arrived AFTER this instant.
   *
   * The watermark is the entire point of this interface. Without it, a retry
   * happily re-reads the previous attempt's code and submits it to a portal that
   * already invalidated it - which looks like a portal fault and is not one.
   * Callers set it immediately BEFORE triggering the login.
   */
  since: Date;

  timeoutMs: number;
  matcher: MfaMatcher;

  /** Which login this is for. Logging only - never include a code here. */
  purpose: string;
}

export interface MfaCodeProvider {
  readonly name: string;

  /**
   * Resolves with the code, or throws a SystemException on timeout.
   *
   * A missing code is a System failure, not Business: mail is late, which a
   * retry with a fresh trigger can fix.
   *
   * Implementations MUST consume the message they read - mark it read, or move
   * it - so a retry cannot pick up the same code twice.
   */
  waitForCode(request: MfaCodeRequest): Promise<string>;

  close?(): Promise<void>;
}

/**
 * Pulls a code out of message text.
 *
 * Shared rather than reimplemented per provider, because this is the one piece
 * of the flow that is worth unit-testing hard: the difference between a correct
 * pattern and a nearly-correct one is a login that fails once a month for
 * reasons nobody can reproduce.
 */
export function extractMfaCode(text: string, matcher: MfaMatcher): string | undefined {
  // Patterns are reused across polls, so a /g regex would otherwise resume from
  // wherever the last call stopped.
  matcher.codePattern.lastIndex = 0;
  const match = matcher.codePattern.exec(text);
  if (match === null) return undefined;
  return match[1] ?? match[0];
}

/** True when a sender is on the allow-list. Case-insensitive, matches domains or full addresses. */
export function isAllowedSender(from: string, matcher: MfaMatcher): boolean {
  const normalized = from.toLowerCase();
  return matcher.fromAllowList.some((allowed) => normalized.includes(allowed.toLowerCase()));
}
