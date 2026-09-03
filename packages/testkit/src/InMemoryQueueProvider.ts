import type { FailureReason, QueueItem, QueueProvider, QueueStats } from '@rpa/core';

/**
 * A QueueProvider with no filesystem behind it.
 *
 * Useful for two things: testing the runner itself, and demonstrating that the
 * queue really is a seam - this is the whole interface, in about 80 lines, with
 * no I/O at all.
 */
export class InMemoryQueueProvider implements QueueProvider {
  readonly #items: QueueItem[];

  /** Records every status transition, so a test can assert on the sequence. */
  readonly transitions: Array<{ reference: string; status: string; reason?: FailureReason }> = [];

  constructor(items: readonly Partial<QueueItem>[] = []) {
    this.#items = items.map((item, index) => ({
      id: item.id ?? `test-${index + 1}`,
      reference: item.reference ?? `TEST-${index + 1}`,
      priority: item.priority ?? 'normal',
      payload: item.payload ?? {},
      status: item.status ?? 'new',
      retryCount: item.retryCount ?? 0,
      createdAt: item.createdAt ?? new Date(0).toISOString(),
    }));
  }

  async init(): Promise<void> {
    // Nothing to load.
  }

  async getNext(): Promise<QueueItem | null> {
    const next = this.#items.find((item) => item.status === 'new');
    if (next === undefined) return null;
    next.status = 'inProgress';
    next.startedAt = new Date().toISOString();
    return next;
  }

  async complete(item: QueueItem): Promise<void> {
    const target = this.#find(item.id);
    target.status = 'success';
    target.endedAt = new Date().toISOString();
    this.transitions.push({ reference: target.reference, status: 'success' });
  }

  async fail(item: QueueItem, reason: FailureReason, error: Error): Promise<void> {
    const target = this.#find(item.id);
    target.status = 'failed';
    target.endedAt = new Date().toISOString();
    target.lastError = { type: reason, message: error.message, at: new Date().toISOString() };
    this.transitions.push({ reference: target.reference, status: 'failed', reason });
  }

  async requeue(item: QueueItem): Promise<QueueItem> {
    const target = this.#find(item.id);
    target.retryCount += 1;
    target.status = 'inProgress';
    this.transitions.push({ reference: target.reference, status: 'requeued' });
    return target;
  }

  async stats(): Promise<QueueStats> {
    const stats: QueueStats = {
      total: this.#items.length,
      new: 0,
      inProgress: 0,
      success: 0,
      failed: 0,
      abandoned: 0,
    };
    for (const item of this.#items) stats[item.status] += 1;
    return stats;
  }

  async close(): Promise<void> {
    // Nothing to flush.
  }

  get items(): readonly QueueItem[] {
    return this.#items;
  }

  #find(id: string): QueueItem {
    const found = this.#items.find((item) => item.id === id);
    if (found === undefined) throw new Error(`No queue item with id ${id}`);
    return found;
  }
}
