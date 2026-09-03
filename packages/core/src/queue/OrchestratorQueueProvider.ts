import type { Logger } from 'pino';
import type {
  Priority,
  QueueItem,
  QueueProvider,
  QueueStats,
  TransactionStatus,
} from '../contracts/QueueProvider.ts';
import { SystemException, type FailureReason } from '../errors.ts';
import type { OrchestratorClient } from '../orchestrator/OrchestratorClient.ts';
import {
  fromSpecificContent,
  toSpecificContent,
  type SpecificContentEncoding,
} from '../orchestrator/specificContent.ts';

/**
 * QueueProvider backed by UiPath Orchestrator.
 *
 * Implements the existing interface exactly, so the runner, the exceptions and
 * the session lifecycle are unaware that the queue is remote. The one thing it
 * has to tell the runner is `retryOwner` - see below.
 */

export type OrchestratorQueueMode = 'robot' | 'odata';

/** Who retries a System exception. Read by the runner. */
export type RetryOwner = 'runner' | 'orchestrator';

export interface OrchestratorQueueProviderOptions {
  client: OrchestratorClient;
  /** Queue name as defined in Orchestrator. Comes from automation.json. */
  queueName: string;
  mode: OrchestratorQueueMode;
  /** Unattended robot key. Required for 'robot' mode. */
  robotIdentifier?: string | undefined;
  logger: Logger;
  specificContentEncoding: SpecificContentEncoding;
}

/** Orchestrator's QueueItem entity, narrowed to the fields this provider reads. */
interface QueueItemDto {
  Id: number;
  Key?: string | null;
  Reference?: string | null;
  Priority?: string | null;
  SpecificContent?: Record<string, unknown> | null;
  Status?: string | null;
  RetryNumber?: number | null;
  CreationTime?: string | null;
  StartProcessing?: string | null;
  EndProcessing?: string | null;
  ProcessingExceptionReason?: string | null;
  ProcessingException?: { Reason?: string | null; Type?: string | null } | null;
}

interface QueueDefinitionDto {
  Id: number;
  Name: string;
}

interface ODataList<T> {
  value?: T[];
  '@odata.count'?: number;
}

const PRIORITY_TO_ORCHESTRATOR: Readonly<Record<Priority, string>> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
};

const PRIORITY_FROM_ORCHESTRATOR: Readonly<Record<string, Priority>> = {
  Low: 'low',
  Normal: 'normal',
  High: 'high',
};

/**
 * Orchestrator has two statuses the POC model does not: Retried (a superseded
 * attempt whose retry item now carries the work) and Deleted. Both are terminal
 * and neither should be picked up again, so they map onto the closest POC
 * status rather than inventing new ones the runner would not understand.
 */
const STATUS_FROM_ORCHESTRATOR: Readonly<Record<string, TransactionStatus>> = {
  New: 'new',
  InProgress: 'inProgress',
  Successful: 'success',
  Failed: 'failed',
  Abandoned: 'abandoned',
  Retried: 'failed',
  Deleted: 'abandoned',
};

/** Priority order for client-side selection in odata mode. */
const PRIORITY_RANK: Readonly<Record<Priority, number>> = { high: 0, normal: 1, low: 2 };

/** How many New items odata mode reads before choosing one. */
const ODATA_WINDOW = 25;

export class OrchestratorQueueProvider implements QueueProvider {
  readonly #client: OrchestratorClient;
  readonly #queueName: string;
  readonly #mode: OrchestratorQueueMode;
  readonly #robotIdentifier: string | undefined;
  readonly #logger: Logger;

  #queueDefinitionId: number | undefined;

  /**
   * odata mode only. The OData surface exposes no way to move an item to
   * InProgress, so there is no server-side claim; this stops a single worker
   * from handing the same item out twice within one run. It does NOT make the
   * mode safe for concurrent workers - see the README.
   */
  readonly #claimed = new Set<number>();

  constructor(options: OrchestratorQueueProviderOptions) {
    this.#client = options.client;
    this.#queueName = options.queueName;
    this.#mode = options.mode;
    this.#robotIdentifier = options.robotIdentifier;
    this.#logger = options.logger.child({ component: 'orchestrator-queue', queue: options.queueName });
  }

  /**
   * In robot mode a System exception is reported as an ApplicationException and
   * Orchestrator's Auto-Retry creates the next attempt. The runner must not
   * also retry, or the two multiply. Config validation enforces maxRetries = 0
   * in that mode; this field is what the runner actually reads.
   */
  get retryOwner(): RetryOwner {
    return this.#mode === 'robot' ? 'orchestrator' : 'runner';
  }

  async init(): Promise<void> {
    if (this.#mode === 'robot' && (this.#robotIdentifier === undefined || this.#robotIdentifier === '')) {
      throw new SystemException(
        'queue.mode is "robot" but no robot identifier was resolved. Set queue.robotIdentifierEnv ' +
          'and provide that environment variable, or switch to queue.mode "odata".',
      );
    }

    this.#queueDefinitionId = await this.#resolveQueueDefinitionId();

    this.#logger.info(
      {
        mode: this.#mode,
        queueDefinitionId: this.#queueDefinitionId,
        retryOwner: this.retryOwner,
      },
      'Connected to the Orchestrator queue',
    );

    if (this.#mode === 'odata') {
      this.#logger.warn(
        'queue.mode "odata" cannot claim an item atomically, so this queue is SINGLE-WORKER ONLY. ' +
          'Use "robot" mode wherever a robot identity is available.',
      );
    }
  }

  async getNext(): Promise<QueueItem | null> {
    return this.#mode === 'robot' ? this.#startTransaction() : this.#pickNewItem();
  }

  async complete(item: QueueItem): Promise<void> {
    await this.#setTransactionResult(item, { IsSuccessful: true });
    this.#claimed.delete(Number(item.id));
  }

  async fail(item: QueueItem, reason: FailureReason, error: Error): Promise<void> {
    /**
     * The Type field is the whole point of the Business/System split reaching
     * Orchestrator: BusinessException is terminal there too, whereas
     * ApplicationException is what triggers the queue's Auto-Retry.
     *
     * ProcessingException is mandatory whenever IsSuccessful is false -
     * omitting it makes Orchestrator reject the call with InvalidRequest.
     */
    await this.#setTransactionResult(item, {
      IsSuccessful: false,
      ProcessingException: {
        Reason: truncate(error.message, 400),
        // Only the message, name and stack. The exception's `details` object is
        // deliberately not sent: it can carry payload fields, and Specific Data
        // is the wrong place for them unless the queue is encrypted.
        Details: truncate(`${error.name}: ${error.message}\n${error.stack ?? ''}`, 2_000),
        Type: reason === 'business' ? 'BusinessException' : 'ApplicationException',
      },
    });
    this.#claimed.delete(Number(item.id));
  }

  async requeue(item: QueueItem): Promise<QueueItem> {
    if (this.retryOwner === 'orchestrator') {
      // Reaching here means the runner's retry guard did not fire. Log loudly
      // rather than silently double-retrying a real submission.
      this.#logger.error(
        { reference: item.reference },
        'requeue() was called in robot mode, where Orchestrator owns retries. ' +
          'Check that maxRetries is 0 for this environment.',
      );
    }

    item.retryCount += 1;
    return item;
  }

  async stats(): Promise<QueueStats> {
    const filterFor = (status: string): string =>
      `QueueDefinitionId eq ${this.#requireQueueDefinitionId()} and Status eq '${status}'`;

    // TODO(orchestrator): if your version supports $apply/groupby on QueueItems,
    // these six counts collapse into one request. Kept as counts because
    // aggregation support has been inconsistent across releases.
    const [total, newCount, inProgress, success, failed, abandoned] = await Promise.all([
      this.#client.count('/QueueItems', `QueueDefinitionId eq ${this.#requireQueueDefinitionId()}`),
      this.#client.count('/QueueItems', filterFor('New')),
      this.#client.count('/QueueItems', filterFor('InProgress')),
      this.#client.count('/QueueItems', filterFor('Successful')),
      this.#client.count('/QueueItems', filterFor('Failed')),
      this.#client.count('/QueueItems', filterFor('Abandoned')),
    ]);

    return { total, new: newCount, inProgress, success, failed, abandoned };
  }

  async close(): Promise<void> {
    this.#claimed.clear();
  }

  /**
   * Dispatcher side. Not part of QueueProvider, because the runner only ever
   * consumes - adding work is a separate concern (a scheduled dispatcher, or
   * `rpa queue <id> --push-seed`).
   */
  async add(input: {
    reference: string;
    priority?: Priority;
    payload: unknown;
    deferDate?: string;
    dueDate?: string;
  }): Promise<QueueItem> {
    const created = await this.#client.odataAction<QueueItemDto>(
      '/Queues/UiPathODataSvc.AddQueueItem',
      {
        itemData: {
          Name: this.#queueName,
          Priority: PRIORITY_TO_ORCHESTRATOR[input.priority ?? 'normal'],
          Reference: input.reference,
          SpecificContent: toSpecificContent(input.payload),
          ...(input.deferDate === undefined ? {} : { DeferDate: input.deferDate }),
          ...(input.dueDate === undefined ? {} : { DueDate: input.dueDate }),
        },
      },
    );

    this.#logger.info({ reference: input.reference, id: created.Id }, 'Queue item added to Orchestrator');
    return this.#toQueueItem(created);
  }

  /** Mode A. The REFramework path: Orchestrator picks, locks and tracks retries. */
  async #startTransaction(): Promise<QueueItem | null> {
    const response = await this.#client.odataAction<QueueItemDto | undefined>(
      '/Queues/UiPathODataSvc.StartTransaction',
      {
        transactionData: {
          Name: this.#queueName,
          /**
           * TODO(orchestrator): confirm that RobotIdentifier in transactionData
           * is accepted for an External Application on your version, or whether
           * a true unattended robot identity is required. `rpa orchestrator
           * check` reports what came back.
           */
          RobotIdentifier: this.#robotIdentifier,
        },
      },
    );

    /**
     * TODO(orchestrator): a drained queue has been observed to return 204, a
     * 200 with an empty body, and a 200 with an object carrying no Id -
     * depending on version. All three are treated as "no work", which is the
     * safe reading in every case.
     */
    if (response === undefined || response === null || typeof response.Id !== 'number') {
      return null;
    }

    return this.#toQueueItem(response);
  }

  /** Mode B. Read-only selection, with the concurrency caveat documented on #claimed. */
  async #pickNewItem(): Promise<QueueItem | null> {
    const filter = `QueueDefinitionId eq ${this.#requireQueueDefinitionId()} and Status eq 'New'`;

    /**
     * Ordered by CreationTime only, then ranked by priority in code.
     * `$orderby=Priority desc` would depend on the numeric ordering of
     * Orchestrator's Priority enum, which is not something to bet a queue on.
     */
    const page = await this.#client.odataGet<ODataList<QueueItemDto>>('/QueueItems', {
      $filter: filter,
      $orderby: 'CreationTime asc',
      $top: ODATA_WINDOW,
    });

    const candidates = (page.value ?? [])
      .filter((dto) => !this.#claimed.has(dto.Id))
      .map((dto) => this.#toQueueItem(dto))
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          a.createdAt.localeCompare(b.createdAt),
      );

    const next = candidates[0];
    if (next === undefined) return null;

    this.#claimed.add(Number(next.id));

    // A soft marker so a human looking at Orchestrator can see the item was
    // picked up. It sets Progress, not Status - there is no status transition
    // available here, which is exactly why this mode is single-worker.
    await this.#markProgress(next, 'InProgress (external worker)');

    next.status = 'inProgress';
    next.startedAt = new Date().toISOString();
    return next;
  }

  async #markProgress(item: QueueItem, progress: string): Promise<void> {
    try {
      await this.#client.odataAction(
        `/QueueItems(${item.id})/UiPathODataSvc.SetTransactionProgress`,
        { progress },
      );
    } catch (cause) {
      // Cosmetic only. Failing the transaction because a progress note did not
      // stick would be absurd.
      this.#logger.debug({ err: cause, reference: item.reference }, 'Could not set transaction progress');
    }
  }

  async #setTransactionResult(item: QueueItem, transactionResult: unknown): Promise<void> {
    await this.#client.odataAction(
      `/Queues(${item.id})/UiPathODataSvc.SetTransactionResult`,
      { transactionResult },
    );
  }

  async #resolveQueueDefinitionId(): Promise<number> {
    const escaped = this.#queueName.replace(/'/g, "''");
    const page = await this.#client.odataGet<ODataList<QueueDefinitionDto>>('/QueueDefinitions', {
      $filter: `Name eq '${escaped}'`,
      $top: 1,
    });

    const definition = (page.value ?? [])[0];
    if (definition === undefined) {
      throw new SystemException(
        `Queue "${this.#queueName}" does not exist in the configured Orchestrator folder. ` +
          'Check automation.json queue.name and orchestrator.folderId.',
        { details: { queueName: this.#queueName } },
      );
    }

    return definition.Id;
  }

  #requireQueueDefinitionId(): number {
    if (this.#queueDefinitionId === undefined) {
      throw new SystemException('Orchestrator queue provider was used before init()');
    }
    return this.#queueDefinitionId;
  }

  #toQueueItem(dto: QueueItemDto): QueueItem {
    const priority = PRIORITY_FROM_ORCHESTRATOR[dto.Priority ?? 'Normal'] ?? 'normal';
    const status = STATUS_FROM_ORCHESTRATOR[dto.Status ?? 'New'] ?? 'new';

    const item: QueueItem = {
      id: String(dto.Id),
      reference: dto.Reference ?? `orchestrator-${dto.Id}`,
      priority,
      payload: fromSpecificContent(dto.SpecificContent),
      status,
      retryCount: dto.RetryNumber ?? 0,
      createdAt: dto.CreationTime ?? new Date().toISOString(),
    };

    if (dto.StartProcessing !== null && dto.StartProcessing !== undefined) {
      item.startedAt = dto.StartProcessing;
    }
    if (dto.EndProcessing !== null && dto.EndProcessing !== undefined) {
      item.endedAt = dto.EndProcessing;
    }

    const reason = dto.ProcessingException?.Reason ?? dto.ProcessingExceptionReason;
    if (reason !== null && reason !== undefined && reason.length > 0) {
      item.lastError = {
        type: dto.ProcessingException?.Type === 'BusinessException' ? 'business' : 'system',
        message: reason,
        at: dto.EndProcessing ?? new Date().toISOString(),
      };
    }

    return item;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
