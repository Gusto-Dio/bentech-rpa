import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';

/**
 * The lock, and the counters. Both deliberately small.
 *
 * ── THIS IS A CACHE, NOT AN AUDIT STORE ─────────────────────────────────────
 * `AGENTS.md` lists an audit store under "deliberately absent - do not add
 * without asking", and this must not become one by accident. So the invariant
 * is explicit and testable: **deleting `data/sentinel/state.json` loses no
 * correctness.** The GitHub issues are the record of truth; the client rebuilds
 * the fingerprint map by listing open issues. What is lost is one cycle of
 * extra API calls, which is a cost, not a bug.
 *
 * It therefore holds counters and open-issue numbers, and no event history.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Optional fields are OMITTED rather than set to `undefined`.
 *
 * `JSON.stringify` drops an undefined-valued key, so a record built with
 * `issueNumber: undefined` is not deep-equal to the same record read back off
 * disk - one has the key, the other does not. For state that is persisted,
 * compared and merged on every cycle, "the shape after a round trip is the
 * shape before it" is a property worth keeping rather than a detail to remember.
 */
export interface FingerprintRecord {
  /** The open GitHub issue for this fingerprint, when there is one. */
  issueNumber?: number;
  firstSeen: string;
  lastSeen: string;
  /** How many probe runs have produced this fingerprint. */
  occurrences: number;
  /** Consecutive occurrences, reset when a run does not reproduce it. */
  streak: number;
  /** Do not comment again before this. */
  cooldownUntil?: string;
}

export interface SentinelState {
  version: 1;
  /** Keyed by fingerprint hash. */
  fingerprints: Record<string, FingerprintRecord>;
  /** `YYYY-MM-DD` -> counts, so a daily cap needs no cron to reset it. */
  daily: Record<string, { newIssues: number; mfaCodes: number }>;
}

const EMPTY: SentinelState = { version: 1, fingerprints: {}, daily: {} };

export interface StateStoreOptions {
  /** Absolute path to `<repoRoot>/data/sentinel`. */
  dir: string;
  logger: Logger;
}

export class StateStore {
  readonly #dir: string;
  readonly #file: string;
  readonly #logger: Logger;

  constructor(options: StateStoreOptions) {
    this.#dir = options.dir;
    this.#file = path.join(options.dir, 'state.json');
    this.#logger = options.logger;
  }

  async read(): Promise<SentinelState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, 'utf8'));
      if (!isState(parsed)) throw new Error('not a sentinel state document');
      return parsed;
    } catch (cause) {
      /**
       * Absent is the normal first run. Corrupt is also survivable precisely
       * because this is a cache - starting from empty costs some extra API
       * calls and, at worst, one duplicate comment. Wedging the monitor to
       * protect a counter would be the wrong trade.
       */
      if (isMissing(cause)) return structuredClone(EMPTY);
      this.#logger.warn({ file: this.#file, err: cause }, 'Sentinel state is unreadable; starting from empty');
      return structuredClone(EMPTY);
    }
  }

  async write(state: SentinelState): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    /**
     * Written via a temp file and renamed, because `rename` is atomic on both
     * platforms. A truncated write here would be read back as corrupt on the
     * next cycle - survivable, but it would silently reset the daily caps that
     * exist to stop an issue storm.
     */
    const temp = `${this.#file}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const handle = await open(temp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.#file);
  }

  /** Today, in the host's own timezone - a daily cap should align with a working day. */
  static today(now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = `${now.getMonth() + 1}`.padStart(2, '0');
    const day = `${now.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

/**
 * Records a sighting and returns the updated record.
 *
 * `streak` is what `minConsecutiveFailures` reads. It counts CONSECUTIVE
 * sightings, so a single transient failure between two healthy runs never
 * reaches the threshold - which is the whole point of having a threshold.
 */
export function recordSighting(
  state: SentinelState,
  hash: string,
  now: Date = new Date(),
): FingerprintRecord {
  const iso = now.toISOString();
  const existing = state.fingerprints[hash];

  const record: FingerprintRecord = existing === undefined
    ? { firstSeen: iso, lastSeen: iso, occurrences: 1, streak: 1 }
    : { ...existing, lastSeen: iso, occurrences: existing.occurrences + 1, streak: existing.streak + 1 };

  state.fingerprints[hash] = record;
  return record;
}

/**
 * Breaks the streak of every fingerprint this run did NOT reproduce.
 *
 * Without this, `streak` would only ever grow and `minConsecutiveFailures`
 * would be satisfied by any two failures however far apart - which is exactly
 * the flapping case the threshold is meant to absorb.
 */
export function breakStreaks(state: SentinelState, seen: readonly string[]): void {
  const reproduced = new Set(seen);
  for (const [hash, record] of Object.entries(state.fingerprints)) {
    if (reproduced.has(hash)) continue;
    if (record.streak === 0) continue;
    state.fingerprints[hash] = { ...record, streak: 0 };
  }
}

/** Have we already spent today's allowance? */
export function dailyCount(state: SentinelState, key: 'newIssues' | 'mfaCodes', now?: Date): number {
  return state.daily[StateStore.today(now)]?.[key] ?? 0;
}

export function bumpDaily(state: SentinelState, key: 'newIssues' | 'mfaCodes', now?: Date): void {
  const today = StateStore.today(now);
  const entry = state.daily[today] ?? { newIssues: 0, mfaCodes: 0 };
  state.daily[today] = { ...entry, [key]: entry[key] + 1 };

  /**
   * Keep a fortnight and drop the rest, so the file cannot grow without bound
   * just by the calendar advancing.
   */
  const keep = new Set(
    Array.from({ length: 14 }, (_, back) => {
      const day = new Date(now ?? new Date());
      day.setDate(day.getDate() - back);
      return StateStore.today(day);
    }),
  );
  for (const day of Object.keys(state.daily)) {
    if (!keep.has(day)) delete state.daily[day];
  }
}

export interface LockInfo {
  pid: number;
  hostname: string;
  probeSet: string;
  startedAt: string;
  runId: string;
}

export class LockHeldError extends Error {
  constructor(readonly holder: LockInfo) {
    super(
      `The portal lock is held by pid ${holder.pid} on ${holder.hostname} ` +
        `(probe set "${holder.probeSet}", since ${holder.startedAt}).`,
    );
    this.name = 'LockHeldError';
  }
}

export interface PortalLockOptions {
  /** Absolute path to `<repoRoot>/data/sentinel`. */
  dir: string;
  probeSet: string;
  runId: string;
  /** After this, a lock is assumed abandoned. */
  staleAfterMs: number;
  logger: Logger;
}

/**
 * One browser against one portal at a time.
 *
 * ── WHY NOT `flock` ─────────────────────────────────────────────────────────
 * macOS has neither `flock` nor `setsid` (AGENTS.md's gotcha table records the
 * second one costing time), and this has to work on both a Mac mini and a Linux
 * VM. A lock that exists on only one of the two plausible hosts is worse than
 * one that exists on both, because it produces a false sense of exclusion.
 *
 * `open(path, 'wx')` fails if the file exists and is atomic on both platforms,
 * which is the whole mechanism.
 *
 * ── WHY IT MATTERS HERE SPECIFICALLY ────────────────────────────────────────
 * Two concurrent probe runs fight over the persistent Chromium profile, and the
 * loser reports "the profile is already in use" - a failure with nothing to do
 * with the portal. Twenty orphaned browsers accumulated once, and every later
 * run failed for that reason instead of its own.
 * ────────────────────────────────────────────────────────────────────────────
 */
export class PortalLock {
  readonly #file: string;
  readonly #options: PortalLockOptions;
  #held = false;

  constructor(options: PortalLockOptions) {
    this.#options = options;
    this.#file = path.join(options.dir, 'portal.lock');
  }

  async acquire(): Promise<void> {
    await mkdir(this.#options.dir, { recursive: true });

    const info: LockInfo = {
      pid: process.pid,
      hostname: hostname(),
      probeSet: this.#options.probeSet,
      startedAt: new Date().toISOString(),
      runId: this.#options.runId,
    };

    try {
      const handle = await open(this.#file, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      this.#held = true;
      return;
    } catch (cause) {
      if (!isExists(cause)) throw cause;
    }

    const holder = await this.#readHolder();

    if (holder !== undefined && !this.#isStale(holder)) throw new LockHeldError(holder);

    /**
     * Stale, or unreadable. Either way the previous holder is gone, so the lock
     * is replaced rather than waited on - a monitor that blocks on a dead
     * process's lock simply stops monitoring.
     */
    this.#options.logger.warn(
      { file: this.#file, holder },
      'Taking over a stale portal lock; the previous holder is gone',
    );
    await rm(this.#file, { force: true });
    const handle = await open(this.#file, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    this.#held = true;
  }

  /** Always call in a `finally`. An unreleased lock blocks every later run. */
  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    await rm(this.#file, { force: true }).catch((cause: unknown) => {
      this.#options.logger.warn({ file: this.#file, err: cause }, 'Could not release the portal lock');
    });
  }

  async #readHolder(): Promise<LockInfo | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return undefined;
      const candidate = parsed as Partial<LockInfo>;
      if (typeof candidate.pid !== 'number' || typeof candidate.startedAt !== 'string') return undefined;
      return {
        pid: candidate.pid,
        hostname: candidate.hostname ?? '(unknown)',
        probeSet: candidate.probeSet ?? '(unknown)',
        startedAt: candidate.startedAt,
        runId: candidate.runId ?? '(unknown)',
      };
    } catch {
      return undefined;
    }
  }

  #isStale(holder: LockInfo): boolean {
    const age = Date.now() - Date.parse(holder.startedAt);
    if (Number.isNaN(age) || age > this.#options.staleAfterMs) return true;

    /**
     * A liveness check, but ONLY on the same host - a pid from another machine
     * says nothing about a process here, and `kill(pid, 0)` would cheerfully
     * report some unrelated local process as the holder. Getting this wrong
     * means two browsers on one profile, which is the failure the lock exists
     * to prevent.
     */
    if (holder.hostname !== hostname()) return false;

    try {
      process.kill(holder.pid, 0);
      return false;
    } catch (cause) {
      // EPERM means it exists but is not ours to signal, so it is alive.
      return !(cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'EPERM');
    }
  }
}

function isState(value: unknown): value is SentinelState {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<SentinelState>;
  return (
    candidate.version === 1 &&
    candidate.fingerprints !== null &&
    typeof candidate.fingerprints === 'object' &&
    candidate.daily !== null &&
    typeof candidate.daily === 'object'
  );
}

function isMissing(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT';
}

function isExists(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST';
}
