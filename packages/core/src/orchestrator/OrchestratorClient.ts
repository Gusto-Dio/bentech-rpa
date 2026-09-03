import type { Logger } from 'pino';
import type { OrchestratorConfig } from '../config/schema.ts';
import { SystemException } from '../errors.ts';
import { computeBackoff, sleep } from '../retry.ts';
import type { SecretResolver } from '../secrets.ts';
import {
  isRetryableStatus,
  mapOrchestratorError,
  parseErrorBody,
  parseRetryAfterMs,
  type OrchestratorHttpFailure,
} from './errors.ts';

/**
 * HTTP client for the UiPath Orchestrator REST/OData API.
 *
 * Responsibilities, and nothing beyond them: authenticate, scope requests to a
 * folder, retry what is worth retrying, and translate failures into the
 * framework's Business / System vocabulary. Queue semantics live in
 * OrchestratorQueueProvider; buckets live in BucketClient.
 */

export interface OrchestratorClientOptions {
  config: OrchestratorConfig;
  /** Resolves clientIdEnv / clientSecretEnv. Values never come from config. */
  secrets: SecretResolver;
  logger: Logger;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so token expiry is deterministic. */
  now?: () => number;
  /** The run's stop signal, so a backoff does not hold shutdown open. */
  abortSignal?: AbortSignal;
}

interface TokenState {
  token: string;
  expiresAtMs: number;
  scopes: readonly string[];
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface TokenInfo {
  expiresAtMs: number;
  expiresInMs: number;
  /** Scopes Orchestrator actually granted, which can be narrower than requested. */
  grantedScopes: readonly string[];
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative to apiRoot, e.g. '/Queues/UiPathODataSvc.StartTransaction'. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** Never let a server-supplied Retry-After stall a run for longer than this. */
const RETRY_AFTER_CAP_MS = 60_000;

export class OrchestratorClient {
  readonly #config: OrchestratorConfig;
  readonly #secrets: SecretResolver;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #abortSignal: AbortSignal | undefined;

  #token: TokenState | undefined;
  #authInFlight: Promise<TokenState> | undefined;

  constructor(options: OrchestratorClientOptions) {
    this.#config = options.config;
    this.#secrets = options.secrets;
    this.#logger = options.logger.child({ component: 'orchestrator' });
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#abortSignal = options.abortSignal;
  }

  /**
   * Cloud:      {baseUrl}/{organization}/{tenant}/orchestrator_/odata
   * Standalone: {baseUrl}/odata
   *
   * The shape is chosen by whether organization and tenant are configured,
   * rather than by a separate "deployment type" flag that could disagree with
   * the rest of the config.
   */
  get apiRoot(): string {
    const base = trimSlash(this.#config.baseUrl);
    const { organization, tenant } = this.#config;
    return organization !== undefined && tenant !== undefined
      ? `${base}/${organization}/${tenant}/orchestrator_/odata`
      : `${base}/odata`;
  }

  get tokenUrl(): string {
    const host = trimSlash(this.#config.identityUrl ?? this.#config.baseUrl);
    return `${host}/identity_/connect/token`;
  }

  /**
   * Acquires a token, or re-acquires one when the cached token is within the
   * refresh skew of expiry.
   *
   * Note there is no refresh-token path: the client_credentials grant does not
   * issue refresh tokens, so "renewal" is simply another token request.
   */
  async authenticate(force = false): Promise<void> {
    if (force) this.#token = undefined;
    await this.#ensureToken();
  }

  async tokenInfo(): Promise<TokenInfo> {
    const state = await this.#ensureToken();
    return {
      expiresAtMs: state.expiresAtMs,
      expiresInMs: Math.max(state.expiresAtMs - this.#now(), 0),
      grantedScopes: state.scopes,
    };
  }

  async odataGet<T>(path: string, query?: RequestSpec['query']): Promise<T> {
    return this.#execute<T>({ method: 'GET', path, ...(query === undefined ? {} : { query }) });
  }

  async odataAction<T>(path: string, body: unknown): Promise<T> {
    return this.#execute<T>({ method: 'POST', path, body });
  }

  async odataPut<T>(path: string, body: unknown): Promise<T> {
    return this.#execute<T>({ method: 'PUT', path, body });
  }

  /** OData $count, used for queue statistics. */
  async count(path: string, filter?: string): Promise<number> {
    const query: RequestSpec['query'] = { $count: true, $top: 0 };
    if (filter !== undefined) query['$filter'] = filter;
    const response = await this.odataGet<{ '@odata.count'?: number }>(path, query);
    return response['@odata.count'] ?? 0;
  }

  /**
   * For pre-signed storage URIs returned by GetWriteUri / GetReadUri.
   *
   * Deliberately sends no Authorization and no folder header: the URI already
   * carries its own signature, and on some storage backends an extra
   * Authorization header invalidates it. Retries still apply, because a blob
   * upload is exactly as likely to hit a transient 5xx as anything else.
   */
  async rawRequest(
    url: string,
    init: RequestInit,
    /**
     * Some Orchestrator versions return `RequiresAuth: true` alongside the
     * write/read URI, meaning the storage endpoint is Orchestrator itself
     * rather than a pre-signed blob URL. BucketClient passes that flag through.
     */
    options: { authenticate?: boolean } = {},
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();

    for (let attempt = 1; ; attempt += 1) {
      const started = this.#now();
      let response: Response | undefined;
      let networkError: unknown;

      const headers = new Headers(init.headers);
      if (options.authenticate === true) {
        headers.set('Authorization', `Bearer ${(await this.#ensureToken()).token}`);
      }

      try {
        response = await this.#fetch(url, {
          ...init,
          headers,
          signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
        });
      } catch (cause) {
        networkError = cause;
      }

      if (response !== undefined && response.ok) {
        this.#logger.debug(
          { method, target: 'presigned-uri', status: response.status, durationMs: this.#now() - started },
          'Storage request succeeded',
        );
        return response;
      }

      const retryable = networkError !== undefined || isRetryableStatus(response?.status ?? 0);
      const failure: OrchestratorHttpFailure = {
        status: response?.status ?? 0,
        statusText: response?.statusText ?? 'network error',
        method,
        // The signed URI contains a credential; never log or embed it.
        path: '<presigned-uri>',
        body: undefined,
        rawBody: response === undefined ? undefined : await safeText(response),
        attempt,
        ...(networkError === undefined ? {} : { networkError }),
      };

      if (!retryable || attempt > this.#config.maxRetries) throw mapOrchestratorError(failure);
      await this.#backoff(attempt, response ?? undefined);
    }
  }

  async close(): Promise<void> {
    this.#token = undefined;
    this.#authInFlight = undefined;
  }

  async #execute<T>(spec: RequestSpec): Promise<T> {
    const url = buildUrl(`${this.apiRoot}${spec.path}`, spec.query);
    let reauthenticated = false;

    for (let attempt = 1; ; ) {
      const token = await this.#ensureToken();
      const started = this.#now();

      let response: Response | undefined;
      let networkError: unknown;

      try {
        response = await this.#fetch(url, {
          method: spec.method,
          headers: this.#headers(token.token, spec.body !== undefined),
          ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
          signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
        });
      } catch (cause) {
        networkError = cause;
      }

      /**
       * A 401 on a token we believed was valid means it was revoked or the
       * clock skew guess was wrong. Re-authenticate and replay once, without
       * consuming a retry attempt - but only once, so a genuinely unauthorised
       * client cannot loop.
       */
      if (response?.status === 401 && !reauthenticated) {
        reauthenticated = true;
        this.#token = undefined;
        this.#logger.warn(
          { method: spec.method, path: spec.path },
          'Orchestrator returned 401; re-authenticating and replaying once',
        );
        continue;
      }

      if (response !== undefined && response.ok) {
        this.#logger.debug(
          {
            method: spec.method,
            path: spec.path,
            status: response.status,
            durationMs: this.#now() - started,
            attempt,
          },
          'Orchestrator request succeeded',
        );
        return (await parseJsonBody<T>(response)) as T;
      }

      const rawBody = response === undefined ? undefined : await safeText(response);
      const failure: OrchestratorHttpFailure = {
        status: response?.status ?? 0,
        statusText: response?.statusText ?? 'network error',
        method: spec.method,
        path: spec.path,
        body: parseErrorBody(rawBody),
        rawBody,
        attempt,
        ...(networkError === undefined ? {} : { networkError }),
      };

      const retryable = networkError !== undefined || isRetryableStatus(failure.status);

      if (!retryable || attempt > this.#config.maxRetries) {
        this.#logger.error(
          {
            method: spec.method,
            path: spec.path,
            status: failure.status,
            errorCode: failure.body?.errorCode,
            traceId: failure.body?.traceId,
            attempt,
            retryable,
          },
          'Orchestrator request failed',
        );
        throw mapOrchestratorError(failure);
      }

      this.#logger.warn(
        { method: spec.method, path: spec.path, status: failure.status, attempt },
        'Orchestrator request failed transiently; retrying',
      );
      await this.#backoff(attempt, response ?? undefined);
      attempt += 1;
    }
  }

  /**
   * Headers for every authenticated call.
   *
   * TODO(orchestrator): confirm which folder header your version requires.
   * folderId -> X-UIPATH-OrganizationUnitId is the long-standing one and is
   * preferred when configured. X-UIPATH-FolderPath-Encoded is sent when only a
   * path is available; the exact expected encoding has changed between
   * releases, so verify with `rpa orchestrator check` before relying on it.
   */
  #headers(token: string, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (hasBody) headers['Content-Type'] = 'application/json';

    if (this.#config.folderId !== undefined) {
      headers['X-UIPATH-OrganizationUnitId'] = String(this.#config.folderId);
    } else if (this.#config.folderPath !== undefined) {
      headers['X-UIPATH-FolderPath-Encoded'] = encodeURIComponent(this.#config.folderPath);
    }

    return headers;
  }

  /** Shared so N concurrent callers on a cold client produce one token request, not N. */
  async #ensureToken(): Promise<TokenState> {
    const cached = this.#token;
    if (cached !== undefined && cached.expiresAtMs > this.#now()) return cached;

    this.#authInFlight ??= this.#requestToken().finally(() => {
      this.#authInFlight = undefined;
    });

    return this.#authInFlight;
  }

  async #requestToken(): Promise<TokenState> {
    const clientId = await this.#secrets.require(this.#config.clientIdEnv);
    const clientSecret = await this.#secrets.require(this.#config.clientSecretEnv);

    const form = new URLSearchParams({
      // Orchestrator rejects the request outright if grant_type is omitted.
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: this.#config.scopes.join(' '),
    });

    let response: Response;
    try {
      response = await this.#fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
      });
    } catch (cause) {
      throw new SystemException(`Could not reach the Orchestrator token endpoint`, {
        cause,
        details: { tokenUrl: this.tokenUrl },
      });
    }

    if (!response.ok) {
      const raw = await safeText(response);
      /**
       * Always a SystemException, never Business - even on a 400. An
       * invalid_client here means the External Application, its secret or its
       * scopes are misconfigured. That is an environment fault, and marking a
       * queue item as a business failure because of it would be wrong.
       */
      throw new SystemException(
        `Orchestrator authentication failed: ${response.status} ${response.statusText}` +
          (raw === undefined ? '' : ` - ${redactTokenBody(raw)}`),
        { details: { tokenUrl: this.tokenUrl, status: response.status } },
      );
    }

    const payload = (await parseJsonBody<TokenResponse>(response)) ?? {};
    if (payload.access_token === undefined || payload.access_token.length === 0) {
      throw new SystemException('Orchestrator token response contained no access_token');
    }

    const expiresInMs = (payload.expires_in ?? 3600) * 1000;
    const expiresAtMs = this.#now() + expiresInMs - this.#config.tokenRefreshSkewMs;
    const scopes = payload.scope === undefined ? this.#config.scopes : payload.scope.split(' ');

    const state: TokenState = { token: payload.access_token, expiresAtMs, scopes };
    this.#token = state;

    // The token itself is never logged, only its lifetime and granted scopes.
    this.#logger.info(
      { expiresInMs, grantedScopes: scopes, tokenUrl: this.tokenUrl },
      'Authenticated with Orchestrator',
    );

    return state;
  }

  async #backoff(attempt: number, response: Response | undefined): Promise<void> {
    const retryAfter =
      response === undefined
        ? undefined
        : parseRetryAfterMs(response.headers.get('retry-after'), RETRY_AFTER_CAP_MS);

    const delayMs =
      retryAfter ??
      computeBackoff({ baseMs: 500, factor: 2, maxMs: 15_000 }, attempt);

    await sleep(delayMs, this.#abortSignal);
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function buildUrl(base: string, query: RequestSpec['query']): string {
  if (query === undefined) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  if (search.length === 0) return base;

  /**
   * URLSearchParams encodes a space as '+', which is the
   * application/x-www-form-urlencoded convention for request *bodies*. In a
   * query string, '%20' is the safer encoding: OData $filter expressions are
   * full of spaces, and while most servers accept '+' there, not all do.
   */
  return `${base}?${search.replace(/\+/g, '%20')}`;
}

/** 204, and 200-with-empty-body, are both normal for Orchestrator actions. */
async function parseJsonBody<T>(response: Response): Promise<T | undefined> {
  if (response.status === 204) return undefined;
  const text = await safeText(response);
  if (text === undefined || text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new SystemException('Orchestrator returned a non-JSON response body', {
      cause,
      details: { status: response.status, preview: text.slice(0, 200) },
    });
  }
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/** Token-endpoint error bodies can echo the request; strip anything secret-shaped. */
function redactTokenBody(raw: string): string {
  return raw
    .replace(/("?client_secret"?\s*[:=]\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(client_secret=)[^&\s]*/gi, '$1[REDACTED]')
    .replace(/("?access_token"?\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .slice(0, 400);
}
