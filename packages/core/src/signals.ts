import type { Logger } from 'pino';

/**
 * REFramework's ShouldStop. A stop request never aborts the transaction in
 * flight - that would leave the target system half-updated, which is the one
 * outcome an unattended process must not produce. The current transaction
 * finishes, then the loop exits through EndProcess so the browser is closed and
 * the queue item is left in a defensible state.
 */
export interface StopSignal {
  readonly requested: boolean;
  readonly reason: string | undefined;
  /** Lets backoff sleeps wake immediately instead of holding shutdown open. */
  readonly abortSignal: AbortSignal;
  request(reason: string): void;
}

class StopSignalImpl implements StopSignal {
  readonly #controller = new AbortController();
  #reason: string | undefined;

  get requested(): boolean {
    return this.#controller.signal.aborted;
  }

  get reason(): string | undefined {
    return this.#reason;
  }

  get abortSignal(): AbortSignal {
    return this.#controller.signal;
  }

  request(reason: string): void {
    if (this.requested) return;
    this.#reason = reason;
    this.#controller.abort();
  }
}

export interface InstalledStopSignal {
  stop: StopSignal;
  dispose(): void;
}

const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export function installStopSignal(logger: Logger): InstalledStopSignal {
  const stop = new StopSignalImpl();
  const handlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

  for (const signal of HANDLED_SIGNALS) {
    const handler = (): void => {
      if (stop.requested) {
        // Second signal: the operator is insisting. Honour it.
        logger.warn({ signal }, 'Second stop signal received, exiting immediately');
        process.exit(130);
      }
      logger.warn({ signal }, 'Stop requested, finishing the current transaction then shutting down');
      stop.request(`signal:${signal}`);
    };
    process.on(signal, handler);
    handlers.push({ signal, handler });
  }

  return {
    stop,
    dispose(): void {
      for (const { signal, handler } of handlers) process.off(signal, handler);
    },
  };
}
