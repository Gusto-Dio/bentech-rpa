/**
 * Test-only fetch double. Not exported from index.ts.
 *
 * Every Orchestrator behaviour worth asserting - token renewal, single-flight
 * auth, 401 replay, backoff, error mapping - is about the *sequence* of HTTP
 * calls, so the mock records calls and answers from a script rather than
 * pattern-matching URLs.
 */

export interface MockResponseSpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Reject instead of responding, to simulate a network failure or timeout. */
  networkError?: Error;
  /** Send a body that is not valid JSON. */
  rawBody?: string;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface FetchMock {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  /** Calls whose URL contains the identity token endpoint. */
  tokenCalls: () => RecordedCall[];
  apiCalls: () => RecordedCall[];
}

export function createFetchMock(
  script: readonly MockResponseSpec[] | ((call: RecordedCall, index: number) => MockResponseSpec),
): FetchMock {
  const calls: RecordedCall[] = [];

  // Typed loosely because RequestInfo is a DOM type and this project's lib is
  // ES2023 + @types/node. The cast to `typeof fetch` below is what matters.
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = readUrl(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const call: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    const index = calls.length;
    calls.push(call);

    const spec = typeof script === 'function' ? script(call, index) : script[index];
    if (spec === undefined) {
      throw new Error(`fetch mock ran out of scripted responses at call ${index + 1}: ${call.method} ${url}`);
    }
    if (spec.networkError !== undefined) throw spec.networkError;

    const status = spec.status ?? 200;
    const body =
      spec.rawBody ?? (spec.body === undefined ? '' : JSON.stringify(spec.body));

    return new Response(status === 204 || body === '' ? null : body, {
      status,
      headers: { 'content-type': 'application/json', ...spec.headers },
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    tokenCalls: () => calls.filter((call) => call.url.includes('/identity_/connect/token')),
    apiCalls: () => calls.filter((call) => !call.url.includes('/identity_/connect/token')),
  };
}

function readUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const candidate = (input as { url?: unknown }).url;
  return typeof candidate === 'string' ? candidate : String(input);
}

export function tokenResponse(
  token = 'test-token',
  expiresIn = 3600,
  scope?: string,
): MockResponseSpec {
  return {
    status: 200,
    body: {
      access_token: token,
      expires_in: expiresIn,
      token_type: 'Bearer',
      ...(scope === undefined ? {} : { scope }),
    },
  };
}
