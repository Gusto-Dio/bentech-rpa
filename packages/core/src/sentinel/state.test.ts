import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createLogger, type Logger } from '../logger.ts';
import {
  LockHeldError,
  PortalLock,
  StateStore,
  breakStreaks,
  bumpDaily,
  dailyCount,
  recordSighting,
  type SentinelState,
} from './state.ts';

function silent(): Logger {
  return createLogger({ level: 'silent', pretty: false, base: {} });
}

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sentinel-state-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function emptyState(): SentinelState {
  return { version: 1, fingerprints: {}, daily: {} };
}

describe('StateStore', () => {
  it('starts from empty when there is no file', async () => {
    await withDir(async (dir) => {
      const state = await new StateStore({ dir, logger: silent() }).read();
      assert.deepEqual(state, emptyState());
    });
  });

  /**
   * THE INVARIANT. AGENTS.md lists an audit store as deliberately absent, and
   * this must not become one by accident - so losing the file must lose no
   * correctness, only some API calls. A corrupt file that wedged the monitor
   * would make the file load-bearing, which is exactly what we are avoiding.
   */
  it('starts from empty when the file is corrupt, rather than wedging', async () => {
    await withDir(async (dir) => {
      await writeFile(path.join(dir, 'state.json'), '{ not json', 'utf8');
      const state = await new StateStore({ dir, logger: silent() }).read();
      assert.deepEqual(state, emptyState());
    });
  });

  it('round-trips', async () => {
    await withDir(async (dir) => {
      const store = new StateStore({ dir, logger: silent() });
      const state = emptyState();
      recordSighting(state, 'abc123abc123');
      bumpDaily(state, 'newIssues');

      await store.write(state);
      assert.deepEqual(await store.read(), state);
    });
  });

  it('writes valid JSON even if the previous file was longer', async () => {
    await withDir(async (dir) => {
      const store = new StateStore({ dir, logger: silent() });
      const big = emptyState();
      for (let i = 0; i < 30; i += 1) recordSighting(big, `hash${i}`);
      await store.write(big);
      await store.write(emptyState());

      const raw = await readFile(path.join(dir, 'state.json'), 'utf8');
      assert.deepEqual(JSON.parse(raw), emptyState());
    });
  });
});

describe('recordSighting and breakStreaks', () => {
  it('counts occurrences and the consecutive streak separately', () => {
    const state = emptyState();
    recordSighting(state, 'h');
    recordSighting(state, 'h');

    assert.equal(state.fingerprints['h']?.occurrences, 2);
    assert.equal(state.fingerprints['h']?.streak, 2);
  });

  it('keeps firstSeen and moves lastSeen', () => {
    const state = emptyState();
    recordSighting(state, 'h', new Date('2026-09-01T00:00:00Z'));
    recordSighting(state, 'h', new Date('2026-09-05T00:00:00Z'));

    assert.equal(state.fingerprints['h']?.firstSeen, '2026-09-01T00:00:00.000Z');
    assert.equal(state.fingerprints['h']?.lastSeen, '2026-09-05T00:00:00.000Z');
  });

  /**
   * Without this, a threshold of "two consecutive failures" would be satisfied
   * by any two failures however far apart - which is precisely the flapping
   * case the threshold exists to absorb.
   */
  it('breaks the streak of a fingerprint a run did not reproduce', () => {
    const state = emptyState();
    recordSighting(state, 'still-broken');
    recordSighting(state, 'transient');
    recordSighting(state, 'still-broken');

    breakStreaks(state, ['still-broken']);

    assert.equal(state.fingerprints['still-broken']?.streak, 2);
    assert.equal(state.fingerprints['transient']?.streak, 0);
    // The total is history and is NOT reset - only the streak is.
    assert.equal(state.fingerprints['transient']?.occurrences, 1);
  });

  it('lets a broken streak build again', () => {
    const state = emptyState();
    recordSighting(state, 'h');
    breakStreaks(state, []);
    recordSighting(state, 'h');

    assert.equal(state.fingerprints['h']?.streak, 1);
    assert.equal(state.fingerprints['h']?.occurrences, 2);
  });
});

describe('daily counters', () => {
  it('counts per day, so a cap needs no cron to reset it', () => {
    const state = emptyState();
    const monday = new Date('2026-09-07T10:00:00');
    const tuesday = new Date('2026-09-08T10:00:00');

    bumpDaily(state, 'newIssues', monday);
    bumpDaily(state, 'newIssues', monday);
    assert.equal(dailyCount(state, 'newIssues', monday), 2);
    assert.equal(dailyCount(state, 'newIssues', tuesday), 0);
  });

  it('tracks MFA spend separately from issues', () => {
    const state = emptyState();
    const day = new Date('2026-09-07T10:00:00');
    bumpDaily(state, 'mfaCodes', day);

    assert.equal(dailyCount(state, 'mfaCodes', day), 1);
    assert.equal(dailyCount(state, 'newIssues', day), 0);
  });

  /** The file must not grow without bound just because the calendar advances. */
  it('keeps a fortnight and drops older days', () => {
    const state = emptyState();
    state.daily['2020-01-01'] = { newIssues: 9, mfaCodes: 9 };
    bumpDaily(state, 'newIssues', new Date('2026-09-07T10:00:00'));

    assert.equal(state.daily['2020-01-01'], undefined);
    assert.ok(Object.keys(state.daily).length <= 14);
  });
});

describe('PortalLock', () => {
  const options = (dir: string, probeSet = 'access') => ({
    dir,
    probeSet,
    runId: 'run-1',
    staleAfterMs: 30 * 60_000,
    logger: silent(),
  });

  it('acquires and releases', async () => {
    await withDir(async (dir) => {
      const lock = new PortalLock(options(dir));
      await lock.acquire();
      await lock.release();

      // Released, so a second acquire must succeed.
      const again = new PortalLock(options(dir));
      await again.acquire();
      await again.release();
    });
  });

  /**
   * Two concurrent probe runs fight over the persistent Chromium profile, and
   * the loser reports "the profile is already in use" - a failure with nothing
   * to do with the portal.
   */
  it('refuses a second holder while the first is alive, and says who holds it', async () => {
    await withDir(async (dir) => {
      const first = new PortalLock(options(dir, 'navigation'));
      await first.acquire();

      try {
        const second = new PortalLock(options(dir, 'access'));
        await assert.rejects(second.acquire(), LockHeldError);

        try {
          await second.acquire();
          assert.fail('expected the lock to be refused');
        } catch (error) {
          assert.ok(error instanceof LockHeldError);
          assert.equal(error.holder.pid, process.pid);
          assert.equal(error.holder.probeSet, 'navigation');
          assert.match(error.message, /portal lock is held by pid/);
        }
      } finally {
        await first.release();
      }
    });
  });

  /** A monitor that blocks on a dead process's lock simply stops monitoring. */
  it('takes over a lock that is older than the stale window', async () => {
    await withDir(async (dir) => {
      await writeFile(
        path.join(dir, 'portal.lock'),
        JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          probeSet: 'access',
          startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          runId: 'ancient',
        }),
        'utf8',
      );

      const lock = new PortalLock(options(dir));
      await lock.acquire();
      await lock.release();
    });
  });

  it('takes over a lock whose holder process is gone', async () => {
    await withDir(async (dir) => {
      /**
       * A pid that cannot exist. `kill(pid, 0)` throws ESRCH, which is what
       * proves the holder is gone rather than merely quiet.
       */
      await writeFile(
        path.join(dir, 'portal.lock'),
        JSON.stringify({
          pid: 2_147_483_646,
          hostname: hostname(),
          probeSet: 'access',
          startedAt: new Date().toISOString(),
          runId: 'dead',
        }),
        'utf8',
      );

      const lock = new PortalLock(options(dir));
      await lock.acquire();
      await lock.release();
    });
  });

  /**
   * A pid from another machine says nothing about a process here, and
   * `kill(pid, 0)` would cheerfully report some unrelated local process as the
   * holder. Getting this wrong puts two browsers on one profile.
   */
  it('does not judge liveness from a pid belonging to another host', async () => {
    await withDir(async (dir) => {
      await writeFile(
        path.join(dir, 'portal.lock'),
        JSON.stringify({
          pid: 2_147_483_646,
          hostname: 'some-other-machine',
          probeSet: 'access',
          startedAt: new Date().toISOString(),
          runId: 'elsewhere',
        }),
        'utf8',
      );

      const lock = new PortalLock(options(dir));
      await assert.rejects(lock.acquire(), LockHeldError);
    });
  });

  it('takes over an unreadable lock file rather than deadlocking on it', async () => {
    await withDir(async (dir) => {
      await writeFile(path.join(dir, 'portal.lock'), 'not json at all', 'utf8');
      const lock = new PortalLock(options(dir));
      await lock.acquire();
      await lock.release();
    });
  });

  it('is safe to release twice, so a finally block cannot make things worse', async () => {
    await withDir(async (dir) => {
      const lock = new PortalLock(options(dir));
      await lock.acquire();
      await lock.release();
      await lock.release();
    });
  });

  it('releasing a lock never acquired is a no-op, not a deletion', async () => {
    await withDir(async (dir) => {
      const holder = new PortalLock(options(dir, 'navigation'));
      await holder.acquire();

      try {
        // A second instance that failed to acquire must not delete the holder's lock.
        const other = new PortalLock(options(dir, 'access'));
        await assert.rejects(other.acquire(), LockHeldError);
        await other.release();

        const raw = await readFile(path.join(dir, 'portal.lock'), 'utf8');
        assert.match(raw, /navigation/);
      } finally {
        await holder.release();
      }
    });
  });
});
