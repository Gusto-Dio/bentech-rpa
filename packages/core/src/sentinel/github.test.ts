import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pino, type Logger } from 'pino';
import { GitHubError, GitHubIssuesClient, findByFingerprint, isBeingWorkedOn } from './github.ts';
import { fingerprintMarker } from './fingerprint.ts';
import { SENTINEL_LABELS } from './labels.ts';

const TOKEN = 'ghp_thisIsNotARealTokenAtAll1234567890';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A recording fetch. The Orchestrator client is tested the same way and for the
 * same reason: nothing in this suite may touch a network.
 */
function recorder(responses: readonly { status: number; body?: unknown; headers?: Record<string, string> }[]): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;

    return {
      ok: (next?.status ?? 200) < 400,
      status: next?.status ?? 200,
      headers: { get: (name: string) => next?.headers?.[name.toLowerCase()] ?? null },
      json: async () => next?.body ?? {},
      text: async () => JSON.stringify(next?.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/**
 * Captures every log line so the token can be searched for.
 *
 * A real pino instance writing to an in-memory sink rather than a fake logger:
 * the thing under test is what actually reaches the OUTPUT, and a stub that
 * recorded call arguments would pass even if serialization leaked the token.
 */
function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = pino(
    { level: 'trace' },
    { write: (chunk: string) => lines.push(chunk) } as never,
  );
  return { logger, lines };
}

function client(
  responses: readonly { status: number; body?: unknown; headers?: Record<string, string> }[],
  logger: Logger = pino({ level: 'silent' }),
): { client: GitHubIssuesClient; calls: Call[] } {
  const { fetchImpl, calls } = recorder(responses);
  return {
    client: new GitHubIssuesClient({
      repo: 'Gusto/bentech-rpa',
      token: TOKEN,
      logger,
      fetchImpl,
      maxRetries: 2,
    }),
    calls,
  };
}

describe('GitHubIssuesClient - the token', () => {
  /**
   * Rule 12's posture, mirrored. A monitor writes a lot of log lines, and a
   * token that appears in one of them is in the log pipeline forever.
   */
  it('never appears in a log line, on success or on failure', async () => {
    const { logger, lines } = capturingLogger();

    const ok = client([{ status: 200, body: [] }], logger);
    await ok.client.listOpen(SENTINEL_LABELS.all);

    const bad = client([{ status: 404, body: { message: 'Not Found' } }], logger);
    await assert.rejects(bad.client.listOpen(SENTINEL_LABELS.all));

    assert.ok(lines.length > 0, 'the client should log something');
    for (const entry of lines) {
      assert.doesNotMatch(entry, /ghp_/, `a log line carried the token: ${entry}`);
      assert.doesNotMatch(entry, new RegExp(TOKEN));
      // Not even its length, which would narrow a brute force.
      assert.doesNotMatch(entry, /tokenLength|token_length/);
    }
  });

  it('sends it as a bearer credential', async () => {
    const { client: c, calls } = client([{ status: 200, body: [] }]);
    await c.listOpen(SENTINEL_LABELS.all);
    assert.equal(calls[0]?.headers['authorization'], `Bearer ${TOKEN}`);
  });
});

describe('GitHubIssuesClient - listOpen', () => {
  it('filters on the label that dedup depends on', async () => {
    const { client: c, calls } = client([{ status: 200, body: [] }]);
    await c.listOpen(SENTINEL_LABELS.all);

    assert.match(calls[0]?.url ?? '', /\/repos\/Gusto\/bentech-rpa\/issues/);
    assert.match(calls[0]?.url ?? '', /state=open/);
    assert.match(calls[0]?.url ?? '', /labels=portal-sentinel/);
  });

  /**
   * The search API would let us query the fingerprint directly, but its index
   * lags up to a minute - and at the moment a finding first appears, that is a
   * duplicate-issue generator.
   */
  it('does not use the search endpoint', async () => {
    const { client: c, calls } = client([{ status: 200, body: [] }]);
    await c.listOpen(SENTINEL_LABELS.all);
    assert.doesNotMatch(calls[0]?.url ?? '', /search/);
  });

  /**
   * GitHub's issues endpoint returns pull requests too. A repair PR counted as
   * an open finding would make the per-probe cap refuse to file while that PR
   * was in review.
   */
  it('excludes pull requests, which the issues endpoint also returns', async () => {
    const { client: c } = client([
      {
        status: 200,
        body: [
          { number: 1, title: 'a finding', labels: ['portal-sentinel'] },
          { number: 2, title: 'a repair PR', labels: ['portal-sentinel'], pull_request: { url: 'x' } },
        ],
      },
    ]);

    const issues = await c.listOpen(SENTINEL_LABELS.all);
    assert.deepEqual(issues.map((issue) => issue.number), [1]);
  });

  it('normalizes labels whether they arrive as strings or objects', async () => {
    const { client: c } = client([
      {
        status: 200,
        body: [{ number: 1, title: 't', labels: ['a', { name: 'b' }], assignees: [{ login: 'someone' }] }],
      },
    ]);

    const issues = await c.listOpen(SENTINEL_LABELS.all);
    assert.deepEqual(issues[0]?.labels, ['a', 'b']);
    assert.deepEqual(issues[0]?.assignees, ['someone']);
  });

  it('stops paging when a page is not full', async () => {
    const { client: c, calls } = client([{ status: 200, body: [{ number: 1, title: 't', labels: [] }] }]);
    await c.listOpen(SENTINEL_LABELS.all);
    assert.equal(calls.length, 1);
  });
});

describe('GitHubIssuesClient - retries', () => {
  it('retries a 500 and then succeeds', async () => {
    const { client: c, calls } = client([
      { status: 500, body: { message: 'boom' } },
      { status: 200, body: [] },
    ]);

    await c.listOpen(SENTINEL_LABELS.all);
    assert.equal(calls.length, 2);
  });

  /** Guessing shorter than GitHub asked is what turns a rate limit into a block. */
  it('honours Retry-After on a 429', async () => {
    const { client: c, calls } = client([
      { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '0' } },
      { status: 200, body: [] },
    ]);

    await c.listOpen(SENTINEL_LABELS.all);
    assert.equal(calls.length, 2);
  });

  it('does not retry a 4xx, which will not become truer', async () => {
    const { client: c, calls } = client([{ status: 404, body: { message: 'Not Found' } }]);
    await assert.rejects(c.listOpen(SENTINEL_LABELS.all), GitHubError);
    assert.equal(calls.length, 1);
  });

  it('reports the status and path on failure', async () => {
    const { client: c } = client([{ status: 403, body: { message: 'Resource not accessible' } }]);

    try {
      await c.create({ title: 't', body: 'b', labels: [] });
      assert.fail('expected a GitHubError');
    } catch (error) {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 403);
      assert.match(error.message, /POST \/repos\/Gusto\/bentech-rpa\/issues failed with 403/);
      assert.match(error.message, /Resource not accessible/);
      // Classified System: a 403 might be a scope problem, which is environmental.
      assert.equal(error.reason, 'system');
    }
  });
});

describe('GitHubIssuesClient - writes', () => {
  it('creates an issue with its labels', async () => {
    const { client: c, calls } = client([{ status: 201, body: { number: 7, title: 't' } }]);

    const issue = await c.create({ title: 't', body: 'b', labels: ['portal-sentinel'] });

    assert.equal(issue.number, 7);
    assert.equal(calls[0]?.method, 'POST');
    assert.deepEqual(calls[0]?.body, { title: 't', body: 'b', labels: ['portal-sentinel'] });
  });

  it('comments on an existing issue', async () => {
    const { client: c, calls } = client([{ status: 201, body: {} }]);
    await c.comment(7, 'still failing');

    assert.match(calls[0]?.url ?? '', /\/issues\/7\/comments$/);
    assert.deepEqual(calls[0]?.body, { body: 'still failing' });
  });

  /**
   * This repo starts with only GitHub's nine default labels, and a `POST
   * /issues` with an unknown label silently creates the issue WITHOUT it - after
   * which the dedup query never finds it again.
   */
  it('treats "label already exists" as success', async () => {
    const { client: c } = client([{ status: 422, body: { message: 'Validation Failed' } }]);
    await assert.doesNotReject(c.ensureLabel('portal-sentinel', '6e7781', 'x'));
  });

  it('still raises a real failure when creating a label', async () => {
    const { client: c } = client([{ status: 403, body: { message: 'Forbidden' } }]);
    await assert.rejects(c.ensureLabel('portal-sentinel', '6e7781', 'x'), GitHubError);
  });
});

describe('findByFingerprint', () => {
  const withMarker = (number: number, hash: string) => ({
    number,
    title: 't',
    body: `prose\n\n${fingerprintMarker({
      version: 1,
      probeId: 'p',
      kind: 'failure' as const,
      screenId: undefined,
      step: undefined,
      gate: undefined,
      errorClass: undefined,
      causeId: undefined,
      deltaShape: undefined,
      hash,
    })}\n`,
    labels: [] as string[],
    assignees: [] as string[],
    hasLinkedPullRequest: false,
  });

  it('finds the issue carrying the hash', () => {
    const issues = [withMarker(1, 'aaaaaaaaaaaa'), withMarker(2, 'bbbbbbbbbbbb')];
    assert.equal(findByFingerprint(issues, 'bbbbbbbbbbbb')?.number, 2);
  });

  it('returns undefined rather than a wrong match', () => {
    assert.equal(findByFingerprint([withMarker(1, 'aaaaaaaaaaaa')], 'cccccccccccc'), undefined);
  });

  /** A human retitling an issue must not orphan it - hence the marker is in the body. */
  it('does not care what the title says', () => {
    const issue = { ...withMarker(1, 'aaaaaaaaaaaa'), title: 'renamed by a human' };
    assert.equal(findByFingerprint([issue], 'aaaaaaaaaaaa')?.number, 1);
  });
});

describe('isBeingWorkedOn', () => {
  const base = {
    number: 1,
    title: 't',
    body: '',
    labels: [] as string[],
    assignees: [] as string[],
    hasLinkedPullRequest: false,
  };

  it('respects an assignee', () => {
    assert.equal(isBeingWorkedOn({ ...base, assignees: ['someone'] }, SENTINEL_LABELS.healingInProgress), true);
  });

  it('respects a linked pull request', () => {
    assert.equal(isBeingWorkedOn({ ...base, hasLinkedPullRequest: true }, SENTINEL_LABELS.healingInProgress), true);
  });

  it('respects the healing-in-progress label', () => {
    assert.equal(
      isBeingWorkedOn({ ...base, labels: [SENTINEL_LABELS.healingInProgress] }, SENTINEL_LABELS.healingInProgress),
      true,
    );
  });

  it('reports an untouched issue as free', () => {
    assert.equal(isBeingWorkedOn(base, SENTINEL_LABELS.healingInProgress), false);
  });
});
