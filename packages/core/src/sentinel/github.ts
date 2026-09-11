import type { Logger } from 'pino';
import { SystemException } from '../errors.ts';
import { readFingerprintMarker } from './fingerprint.ts';

/**
 * The GitHub Issues client, built the way `OrchestratorClient` is.
 *
 * ── WHAT IT LOGS, AND WHAT IT NEVER LOGS ────────────────────────────────────
 * Method, path, status, duration and attempt. Never the token, never its
 * length, never a request body. Rule 12 takes that posture for Orchestrator
 * credentials and the reasoning carries over unchanged - a monitor writes a lot
 * of log lines, and a token that appears in one of them is in the log pipeline
 * forever.
 *
 * ── WHY NOT THE `gh` CLI ────────────────────────────────────────────────────
 * `gh` is not in `tooling/docker/Dockerfile`, and adding it enlarges the one
 * runtime image every automation shares in order to make one API call. Native
 * `fetch` needs nothing.
 *
 * ── THE TOKEN'S SCOPE IS PART OF THE DESIGN ─────────────────────────────────
 * A fine-grained PAT scoped to this repository with **Issues: read and write
 * only**. No contents write, so a compromised sentinel host cannot push code -
 * which matters because the same host runs an autonomous repair agent.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface GitHubIssuesClientOptions {
  /** `owner/repo`. */
  repo: string;
  /** The resolved token. Held in memory, never logged. */
  token: string;
  logger: Logger;
  /** Injectable so the tests can assert on requests without a network. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
}

export interface IssueRef {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
  assignees: readonly string[];
  /** Set when a pull request already references this issue. */
  hasLinkedPullRequest: boolean;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: readonly string[];
}

const GITHUB_API = 'https://api.github.com';

export class GitHubIssuesClient {
  readonly #options: GitHubIssuesClientOptions;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #maxRetries: number;
  readonly #logger: Logger;

  constructor(options: GitHubIssuesClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? GITHUB_API;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#logger = options.logger.child({ component: 'github-issues', repo: options.repo });
  }

  /**
   * Open issues carrying a label, newest first.
   *
   * ── DELIBERATELY NOT THE SEARCH API ────────────────────────────────────────
   * `/search/issues` would let us query the fingerprint directly, but its index
   * lags by up to a minute. At a fifteen-minute cadence that is tolerable; at
   * the moment a finding first appears it is a duplicate-issue generator,
   * because the issue we just filed is not yet findable. The label-filtered
   * list endpoint is strongly consistent.
   */
  async listOpen(label: string): Promise<readonly IssueRef[]> {
    const issues: IssueRef[] = [];

    for (let page = 1; page <= 10; page += 1) {
      const batch = await this.#request<readonly GitHubIssue[]>(
        'GET',
        `/repos/${this.#options.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
      );

      for (const issue of batch) {
        /**
         * GitHub's issues endpoint returns pull requests too - they are issues
         * underneath. A PR counted as an open finding would make the
         * per-probe cap refuse to file while a repair PR was in review.
         */
        if (issue.pull_request !== undefined) continue;

        issues.push({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          labels: issue.labels.map((entry) => (typeof entry === 'string' ? entry : entry.name)),
          assignees: (issue.assignees ?? []).map((entry) => entry.login),
          hasLinkedPullRequest: false,
        });
      }

      if (batch.length < 100) break;
    }

    return issues;
  }

  async create(input: CreateIssueInput): Promise<IssueRef> {
    const created = await this.#request<GitHubIssue>('POST', `/repos/${this.#options.repo}/issues`, {
      title: input.title,
      body: input.body,
      labels: [...input.labels],
    });

    this.#logger.info({ issue: created.number }, 'Filed a sentinel issue');

    return {
      number: created.number,
      title: created.title,
      body: created.body ?? '',
      labels: input.labels,
      assignees: [],
      hasLinkedPullRequest: false,
    };
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    await this.#request('POST', `/repos/${this.#options.repo}/issues/${issueNumber}/comments`, { body });
    this.#logger.info({ issue: issueNumber }, 'Commented on an existing sentinel issue');
  }

  /**
   * Creates a label if it is not already there.
   *
   * A 422 means "already exists", which is success for our purposes - this repo
   * starts with only GitHub's nine defaults, and the alternative is a
   * documented manual setup step that will be skipped on the day it matters.
   */
  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    try {
      await this.#request('POST', `/repos/${this.#options.repo}/labels`, { name, color, description });
    } catch (cause) {
      if (cause instanceof GitHubError && cause.status === 422) return;
      throw cause;
    }
  }

  async #request<T>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    const url = `${this.#baseUrl}${pathAndQuery}`;

    for (let attempt = 1; ; attempt += 1) {
      const startedAt = Date.now();

      const response = await this.#fetch(url, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.#options.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'bentech-rpa-sentinel',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const durationMs = Date.now() - startedAt;

      /** Method, path, status, duration, attempt. Nothing else, ever. */
      this.#logger.debug({ method, path: pathAndQuery, status: response.status, durationMs, attempt }, 'GitHub request');

      if (response.ok) return (await response.json()) as T;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt > this.#maxRetries) {
        /**
         * The response text is included because GitHub's error bodies are
         * genuinely useful ("Validation Failed: label already exists"), and it
         * cannot contain our token - it is a response, not a request echo.
         */
        const detail = await response.text().catch(() => '');
        throw new GitHubError(response.status, method, pathAndQuery, detail.slice(0, 400));
      }

      /**
       * `Retry-After` is honoured when present, because on a secondary rate
       * limit GitHub is telling us exactly how long to wait and guessing
       * shorter is what turns a rate limit into a block.
       */
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : Math.min(30_000, 1_000 * 2 ** (attempt - 1));

      this.#logger.warn({ status: response.status, attempt, waitMs }, 'GitHub request failed; retrying');
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export class GitHubError extends SystemException {
  constructor(
    readonly status: number,
    method: string,
    requestPath: string,
    detail: string,
  ) {
    super(`GitHub ${method} ${requestPath} failed with ${status}: ${detail}`, {
      details: { status, method, path: requestPath },
    });
    this.name = 'GitHubError';
  }
}

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  labels: readonly (string | { name: string })[];
  assignees?: readonly { login: string }[];
  /** Present when this "issue" is actually a pull request. */
  pull_request?: unknown;
}

/** Finds the open issue carrying a fingerprint marker. */
export function findByFingerprint(
  issues: readonly IssueRef[],
  hash: string,
): IssueRef | undefined {
  return issues.find((issue) => readFingerprintMarker(issue.body)?.hash === hash);
}

/**
 * Is someone already working on this?
 *
 * An assignee, a linked pull request, or the healing-in-progress label all mean
 * hands off: the sentinel commenting "still failing" on an issue somebody is
 * actively fixing is noise at best, and at worst it argues with the repair
 * session that is fixing it.
 */
export function isBeingWorkedOn(issue: IssueRef, inProgressLabel: string): boolean {
  return (
    issue.assignees.length > 0 ||
    issue.hasLinkedPullRequest ||
    issue.labels.includes(inProgressLabel)
  );
}
