import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import type {
  Priority,
  QueueItem,
  QueueProvider,
  QueueStats,
} from '../contracts/QueueProvider.ts';
import { SystemException, type FailureReason } from '../errors.ts';

/**
 * The POC queue backend: one JSON file per queue, written atomically.
 *
 * Chosen over SQLite deliberately. better-sqlite3 is a native module that
 * compiles per platform, which is exactly the macOS-arm64 vs Linux-amd64 hazard
 * this repo is built to avoid. A JSON file has no build step, is identical on
 * both platforms, and can be read and hand-edited while debugging - which turns
 * out to matter far more during a migration than transactional throughput.
 *
 * It is single-writer by design. Multi-worker leasing belongs to a real backend
 * behind the same QueueProvider interface.
 */

const seedItemSchema = z.strictObject({
  reference: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  payload: z.unknown(),
});

const seedFileSchema = z.strictObject({
  $comment: z.string().optional(),
  items: z.array(seedItemSchema).min(1),
});

interface QueueFileShape {
  queue: string;
  updatedAt: string;
  items: QueueItem[];
}

export interface LocalQueueProviderOptions {
  /** Absolute path to the live queue state, e.g. <repoRoot>/data/queue.<name>.json */
  file: string;
  /** Absolute path to the automation's synthetic seed items. */
  seedFile: string | undefined;
  queueName: string;
  logger: Logger;
  leaseMs?: number;
}

const PRIORITY_ORDER: Readonly<Record<Priority, number>> = { high: 0, normal: 1, low: 2 };

export class LocalQueueProvider implements QueueProvider {
  readonly #file: string;
  readonly #seedFile: string | undefined;
  readonly #queueName: string;
  readonly #logger: Logger;
  readonly #leaseMs: number;

  #items: QueueItem[] = [];
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: LocalQueueProviderOptions) {
    this.#file = options.file;
    this.#seedFile = options.seedFile;
    this.#queueName = options.queueName;
    this.#logger = options.logger;
    this.#leaseMs = options.leaseMs ?? 15 * 60 * 1000;
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });

    const existing = await this.#readFile();
    if (existing !== undefined) {
      this.#items = existing.items;
      const reclaimed = this.#abandonInterrupted();
      if (reclaimed.length > 0) {
        /**
         * An item left inProgress means a previous run died mid-transaction, so
         * the target system may be half-updated. Orchestrator marks these
         * Abandoned rather than silently replaying them, and so do we: replaying
         * a submission that actually went through is worse than needing a human
         * to look.
         */
        this.#logger.warn(
          { queue: this.#queueName, references: reclaimed },
          'Abandoned transactions left in progress by a previous run; they were NOT replayed',
        );
        await this.#persist();
      }
      this.#logger.debug({ queue: this.#queueName, file: this.#file, items: this.#items.length }, 'Queue loaded');
      return;
    }

    this.#items = await this.#buildFromSeed();
    await this.#persist();
    this.#logger.info(
      { queue: this.#queueName, file: this.#file, items: this.#items.length },
      'Queue seeded from synthetic seed data',
    );
  }

  async getNext(): Promise<QueueItem | null> {
    return this.#withLock(async () => {
      const candidates = this.#items
        .filter((item) => item.status === 'new')
        .sort(
          (a, b) =>
            PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
            a.createdAt.localeCompare(b.createdAt),
        );

      const next = candidates[0];
      if (next === undefined) return null;

      next.status = 'inProgress';
      next.startedAt = new Date().toISOString();
      next.leaseUntil = new Date(Date.now() + this.#leaseMs).toISOString();
      await this.#persist();
      return next;
    });
  }

  async complete(item: QueueItem): Promise<void> {
    await this.#withLock(async () => {
      const target = this.#require(item.id);
      target.status = 'success';
      target.endedAt = new Date().toISOString();
      delete target.leaseUntil;
      delete target.lastError;
      await this.#persist();
    });
  }

  async fail(item: QueueItem, reason: FailureReason, error: Error): Promise<void> {
    await this.#withLock(async () => {
      const target = this.#require(item.id);
      target.status = 'failed';
      target.endedAt = new Date().toISOString();
      delete target.leaseUntil;
      target.lastError = { type: reason, message: error.message, at: new Date().toISOString() };
      await this.#persist();
    });
  }

  async requeue(item: QueueItem): Promise<QueueItem> {
    return this.#withLock(async () => {
      const target = this.#require(item.id);
      target.retryCount += 1;
      target.status = 'inProgress';
      target.leaseUntil = new Date(Date.now() + this.#leaseMs).toISOString();
      if (item.lastError !== undefined) target.lastError = item.lastError;
      await this.#persist();
      return target;
    });
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
    await this.#tail.catch(() => undefined);
  }

  /** Adapter-specific, used by `rpa queue --reset`. Not part of QueueProvider. */
  async reset(): Promise<number> {
    return this.#withLock(async () => {
      this.#items = await this.#buildFromSeed();
      await this.#persist();
      return this.#items.length;
    });
  }

  #abandonInterrupted(): string[] {
    const reclaimed: string[] = [];
    for (const item of this.#items) {
      if (item.status !== 'inProgress') continue;
      item.status = 'abandoned';
      item.endedAt = new Date().toISOString();
      delete item.leaseUntil;
      reclaimed.push(item.reference);
    }
    return reclaimed;
  }

  #require(id: string): QueueItem {
    const found = this.#items.find((item) => item.id === id);
    if (found === undefined) {
      throw new SystemException(`Queue item ${id} vanished from queue "${this.#queueName}"`);
    }
    return found;
  }

  async #buildFromSeed(): Promise<QueueItem[]> {
    if (this.#seedFile === undefined) return [];

    let text: string;
    try {
      text = await readFile(this.#seedFile, 'utf8');
    } catch {
      this.#logger.warn({ seedFile: this.#seedFile }, 'No seed file found; starting with an empty queue');
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new SystemException(`Seed file is not valid JSON: ${this.#seedFile}`, { cause });
    }

    const result = seedFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new SystemException(
        `Seed file ${this.#seedFile} is malformed: expected { "items": [{ "reference", "payload" }] }`,
      );
    }

    const now = new Date().toISOString();
    return result.data.items.map((seed) => ({
      id: crypto.randomUUID(),
      reference: seed.reference,
      priority: seed.priority,
      payload: seed.payload ?? {},
      status: 'new' as const,
      retryCount: 0,
      createdAt: now,
    }));
  }

  async #readFile(): Promise<QueueFileShape | undefined> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(text) as QueueFileShape;
    } catch (cause) {
      throw new SystemException(
        `Queue state file is corrupt: ${this.#file}. Delete it to re-seed, or repair it by hand.`,
        { cause },
      );
    }
  }

  /** Write to a temp file then rename: a crash mid-write cannot truncate the queue. */
  async #persist(): Promise<void> {
    const payload: QueueFileShape = {
      queue: this.#queueName,
      updatedAt: new Date().toISOString(),
      items: this.#items,
    };
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, this.#file);
  }

  /** Serialises read-modify-write cycles so concurrent callers cannot interleave. */
  #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.catch(() => undefined);
    return run;
  }
}

/**
 * Reads queue counts without instantiating the provider.
 *
 * `init()` deliberately has a side effect - it marks interrupted transactions
 * abandoned - so a read-only command like `rpa queue --stats` must not go
 * through it.
 */
export async function readLocalQueueStats(file: string): Promise<QueueStats | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  const parsed = JSON.parse(text) as QueueFileShape;
  const stats: QueueStats = {
    total: parsed.items.length,
    new: 0,
    inProgress: 0,
    success: 0,
    failed: 0,
    abandoned: 0,
  };
  for (const item of parsed.items) stats[item.status] += 1;
  return stats;
}
