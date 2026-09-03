/**
 * REFramework's application lifecycle, as a capability rather than an
 * assumption:
 *
 *   init()    -> InitAllApplications
 *   recover() -> KillAllProcesses followed by InitAllApplications
 *   close()   -> CloseAllApplications
 */
export type SessionKind = 'browser' | 'none';

export interface Session {
  readonly kind: SessionKind;
  init(): Promise<void>;
  /**
   * Called after a System exception, before the transaction is retried. Must
   * leave the session as freshly initialised as init() does - a half-recovered
   * session turns one retryable failure into maxRetries of them.
   */
  recover(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Evidence capture is optional capability, not part of every session. A
 * file-processing automation has no screenshot to take, and the artifact store
 * should not have to pretend otherwise.
 */
export interface EvidenceCapableSession extends Session {
  captureScreenshot(file: string): Promise<void>;
  /** Persists the current transaction's trace chunk. */
  saveTrace(file: string): Promise<void>;
  /** Drops the current trace chunk - used after a success, so disks stay sane. */
  discardTrace(): Promise<void>;
  /** Opens a new trace chunk for one transaction attempt. */
  startTrace(title: string): Promise<void>;
}

export function isEvidenceCapable(session: Session): session is EvidenceCapableSession {
  const candidate = session as Partial<EvidenceCapableSession>;
  return (
    typeof candidate.captureScreenshot === 'function' &&
    typeof candidate.saveTrace === 'function' &&
    typeof candidate.discardTrace === 'function' &&
    typeof candidate.startTrace === 'function'
  );
}
