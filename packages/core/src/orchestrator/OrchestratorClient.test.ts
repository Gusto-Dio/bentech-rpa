import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrchestratorConfig } from '../config/schema.ts';
import { BusinessException, SystemException } from '../errors.ts';
import { createLogger } from '../logger.ts';
import { SecretResolver, type SecretProvider } from '../secrets.ts';
import { OrchestratorClient } from './OrchestratorClient.ts';
import { createFetchMock, tokenResponse, type MockResponseSpec } from './testFetch.ts';

const SECRETS: Record<string, string> = {
  ORCH_CLIENT_ID: 'client-abc',
  ORCH_CLIENT_SECRET: 'super-secret-value',
};

class MapProvider implements SecretProvider {
  readonly name = 'test';
  async get(key: string): Promise<string | undefined> {
    return SECRETS[key];
  }
}

const CONFIG: OrchestratorConfig = {
  baseUrl: 'https://cloud.uipath.test',
  organization: 'acme',
  tenant: 'DefaultTenant',
  folderId: 42,
  scopes: ['OR.Queues', 'OR.Assets'],
  clientIdEnv: 'ORCH_CLIENT_ID',
  clientSecretEnv: 'ORCH_CLIENT_SECRET',
  requestTimeoutMs: 5_000,
  maxRetries: 2,
  tokenRefreshSkewMs: 60_000,
};

interface Harness {
  client: OrchestratorClient;
  mock: ReturnType<typeof createFetchMock>;
  logLines: string[];
  setNow: (value: number) => void;
}

function harness(
  script: readonly MockResponseSpec[] | ((call: never, index: number) => MockResponseSpec),
  config: Partial<OrchestratorConfig> = {},
): Harness {
  const mock = createFetchMock(script as readonly MockResponseSpec[]);
  const logLines: string[] = [];
  let now = 1_000_000;

  // Capture what the logger would emit, so redaction can be asserted.
  const logger = createLogger({ level: 'trace', pretty: false, base: {} });
  const captured = logger.child({});
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    (captured as unknown as Record<string, unknown>)[level] = (...args: unknown[]): void => {
      logLines.push(JSON.stringify(args));
    };
  }
  (captured as unknown as Record<string, unknown>)['child'] = (): unknown => captured;

  const client = new OrchestratorClient({
    config: { ...CONFIG, ...config },
    secrets: new SecretResolver(new MapProvider()),
    logger: captured,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  return {
    client,
    mock,
    logLines,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('OrchestratorClient - URL shapes', () => {
  it('builds the Automation Cloud API root from organization and tenant', () => {
    const { client } = harness([]);
    assert.equal(client.apiRoot, 'https://cloud.uipath.test/acme/DefaultTenant/orchestrator_/odata');
    assert.equal(client.tokenUrl, 'https://cloud.uipath.test/identity_/connect/token');
  });

  it('falls back to the standalone shape when organization and tenant are absent', () => {
    const { client } = harness([], { organization: undefined, tenant: undefined });
    assert.equal(client.apiRoot, 'https://cloud.uipath.test/odata');
  });

  it('honours a separate identity host', () => {
    const { client } = harness([], { identityUrl: 'https://identity.uipath.test/' });
    assert.equal(client.tokenUrl, 'https://identity.uipath.test/identity_/connect/token');
  });
});

describe('OrchestratorClient - authentication', () => {
  it('sends an explicit client_credentials grant and the requested scopes', async () => {
    const { client, mock } = harness([tokenResponse(), { body: { value: [] } }]);
    await client.odataGet('/QueueDefinitions');

    const token = mock.tokenCalls()[0];
    assert.ok(token);
    const form = new URLSearchParams(token.body ?? '');
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('client_id'), 'client-abc');
    assert.equal(form.get('scope'), 'OR.Queues OR.Assets');
    assert.equal(token.headers['content-type'], 'application/x-www-form-urlencoded');
  });

  it('reuses one token across many requests', async () => {
    const { client, mock } = harness([
      tokenResponse(),
      { body: { value: [] } },
      { body: { value: [] } },
      { body: { value: [] } },
    ]);

    await client.odataGet('/QueueDefinitions');
    await client.odataGet('/QueueDefinitions');
    await client.odataGet('/QueueDefinitions');

    assert.equal(mock.tokenCalls().length, 1);
    assert.equal(mock.apiCalls().length, 3);
  });

  /**
   * Without single-flight, a cold client hit by N concurrent requests asks the
   * identity server for N tokens - which is both wasteful and a good way to get
   * rate-limited on the one endpoint you cannot afford to lose.
   */
  it('acquires exactly one token under concurrency (single-flight)', async () => {
    const { client, mock } = harness([
      tokenResponse(),
      { body: { value: [] } },
      { body: { value: [] } },
      { body: { value: [] } },
      { body: { value: [] } },
      { body: { value: [] } },
    ]);

    await Promise.all(
      Array.from({ length: 5 }, async () => client.odataGet('/QueueDefinitions')),
    );

    assert.equal(mock.tokenCalls().length, 1);
  });

  /**
   * The client_credentials grant issues no refresh token, so renewal is another
   * full token request. The skew makes it happen before the token is actually
   * dead rather than after a 401.
   */
  it('re-authenticates once the refresh skew is reached', async () => {
    const { client, mock, setNow } = harness([
      tokenResponse('token-1', 3600),
      { body: { value: [] } },
      tokenResponse('token-2', 3600),
      { body: { value: [] } },
    ]);

    await client.odataGet('/QueueDefinitions');
    assert.equal(mock.tokenCalls().length, 1);

    // 3600s lifetime, 60s skew -> expires from the client's point of view at +3540s.
    setNow(1_000_000 + 3_541_000);
    await client.odataGet('/QueueDefinitions');

    assert.equal(mock.tokenCalls().length, 2);
    assert.equal(mock.apiCalls()[1]?.headers['authorization'], 'Bearer token-2');
  });

  it('treats a token-endpoint 400 as a SystemException, not a business failure', async () => {
    const { client } = harness([
      { status: 400, body: { error: 'invalid_client' } },
    ]);

    await assert.rejects(client.odataGet('/QueueDefinitions'), (error: unknown) => {
      assert.ok(error instanceof SystemException, 'invalid_client is an environment fault');
      assert.match((error as Error).message, /authentication failed/i);
      return true;
    });
  });

  it('rejects a token response with no access_token', async () => {
    const { client } = harness([{ status: 200, body: { expires_in: 3600 } }]);
    await assert.rejects(client.odataGet('/QueueDefinitions'), SystemException);
  });
});

describe('OrchestratorClient - headers', () => {
  it('sends the bearer token and the folder header on every API call', async () => {
    const { client, mock } = harness([tokenResponse('tok'), { body: { value: [] } }]);
    await client.odataGet('/QueueDefinitions');

    const call = mock.apiCalls()[0];
    assert.equal(call?.headers['authorization'], 'Bearer tok');
    assert.equal(call?.headers['x-uipath-organizationunitid'], '42');
  });

  it('falls back to the folder-path header when no folder id is configured', async () => {
    const { client, mock } = harness([tokenResponse(), { body: { value: [] } }], {
      folderId: undefined,
      folderPath: 'Shared/Benefits',
    });
    await client.odataGet('/QueueDefinitions');

    const call = mock.apiCalls()[0];
    assert.equal(call?.headers['x-uipath-folderpath-encoded'], 'Shared%2FBenefits');
    assert.equal(call?.headers['x-uipath-organizationunitid'], undefined);
  });
});

describe('OrchestratorClient - 401 handling', () => {
  it('re-authenticates and replays the request once', async () => {
    const { client, mock } = harness([
      tokenResponse('stale'),
      { status: 401, body: { message: 'expired' } },
      tokenResponse('fresh'),
      { body: { value: ['ok'] } },
    ]);

    const result = await client.odataGet<{ value: string[] }>('/QueueDefinitions');
    assert.deepEqual(result.value, ['ok']);
    assert.equal(mock.tokenCalls().length, 2);
    assert.equal(mock.apiCalls().at(-1)?.headers['authorization'], 'Bearer fresh');
  });

  it('gives up after a second 401 instead of looping', async () => {
    const { client, mock } = harness([
      tokenResponse('a'),
      { status: 401, body: { message: 'nope' } },
      tokenResponse('b'),
      { status: 401, body: { message: 'still nope' } },
    ]);

    await assert.rejects(client.odataGet('/QueueDefinitions'), SystemException);
    // Two token requests and two API attempts. No more.
    assert.equal(mock.tokenCalls().length, 2);
    assert.equal(mock.apiCalls().length, 2);
  });
});

describe('OrchestratorClient - retries', () => {
  it('retries a 500 and succeeds', async () => {
    const { client, mock } = harness([
      tokenResponse(),
      { status: 500, body: { message: 'boom' } },
      { body: { value: ['recovered'] } },
    ]);

    const result = await client.odataGet<{ value: string[] }>('/QueueDefinitions');
    assert.deepEqual(result.value, ['recovered']);
    assert.equal(mock.apiCalls().length, 2);
  });

  it('retries a network failure', async () => {
    const { client, mock } = harness([
      tokenResponse(),
      { networkError: new Error('ECONNRESET') },
      { body: { value: [] } },
    ]);

    await client.odataGet('/QueueDefinitions');
    assert.equal(mock.apiCalls().length, 2);
  });

  it('honours Retry-After on 429', async () => {
    const started = Date.now();
    const { client } = harness([
      tokenResponse(),
      { status: 429, headers: { 'retry-after': '1' }, body: { message: 'slow down' } },
      { body: { value: [] } },
    ]);

    await client.odataGet('/QueueDefinitions');
    assert.ok(Date.now() - started >= 900, 'should have waited about the advertised second');
  });

  it('surfaces a SystemException once retries are exhausted', async () => {
    const { client, mock } = harness(
      [
        tokenResponse(),
        { status: 503, body: { message: 'down' } },
        { status: 503, body: { message: 'down' } },
        { status: 503, body: { message: 'down' } },
      ],
      { maxRetries: 2 },
    );

    await assert.rejects(client.odataGet('/QueueDefinitions'), SystemException);
    // First attempt plus two retries.
    assert.equal(mock.apiCalls().length, 3);
  });

  /**
   * The important half of the retry policy: a rejected payload must NOT be
   * retried. Retrying a duplicate reference three times produces three
   * identical rejections and delays the whole queue.
   */
  it('does not retry a 400 and maps it to BusinessException', async () => {
    const { client, mock } = harness([
      tokenResponse(),
      { status: 400, body: { message: 'Reference is required', errorCode: 1001 } },
    ]);

    await assert.rejects(client.odataAction('/Queues/UiPathODataSvc.AddQueueItem', {}), BusinessException);
    assert.equal(mock.apiCalls().length, 1, 'a business rejection must not be retried');
  });

  it('maps a 409 duplicate reference to BusinessException', async () => {
    const { client } = harness([
      tokenResponse(),
      { status: 409, body: { message: 'Queue item already exists', errorCode: 1002 } },
    ]);

    await assert.rejects(
      client.odataAction('/Queues/UiPathODataSvc.AddQueueItem', {}),
      (error: unknown) => {
        assert.ok(error instanceof BusinessException);
        assert.match((error as Error).message, /reference already exists/i);
        return true;
      },
    );
  });

  it('maps 403 to SystemException, because a missing scope is an environment fault', async () => {
    const { client } = harness([
      tokenResponse(),
      { status: 403, body: { message: 'forbidden' } },
    ]);
    await assert.rejects(client.odataGet('/Buckets'), SystemException);
  });
});

describe('OrchestratorClient - response handling', () => {
  it('treats 204 as an empty result', async () => {
    const { client } = harness([tokenResponse(), { status: 204 }]);
    assert.equal(await client.odataAction('/Queues/UiPathODataSvc.StartTransaction', {}), undefined);
  });

  it('treats a 200 with an empty body as an empty result', async () => {
    const { client } = harness([tokenResponse(), { status: 200, rawBody: '' }]);
    assert.equal(await client.odataAction('/Queues/UiPathODataSvc.StartTransaction', {}), undefined);
  });

  it('reads $count from an OData count response', async () => {
    const { client, mock } = harness([tokenResponse(), { body: { '@odata.count': 17, value: [] } }]);
    assert.equal(await client.count('/QueueItems', "Status eq 'New'"), 17);
    assert.match(mock.apiCalls()[0]?.url ?? '', /%24count=true/);
  });

  it('fails clearly on a non-JSON body', async () => {
    const { client } = harness([tokenResponse(), { status: 200, rawBody: '<html>gateway</html>' }]);
    await assert.rejects(client.odataGet('/QueueDefinitions'), /non-JSON/);
  });
});

describe('OrchestratorClient - redaction', () => {
  it('never writes the token or the client secret to the log', async () => {
    const { client, logLines } = harness([
      tokenResponse('super-sensitive-token'),
      { status: 500, body: { message: 'boom' } },
      { body: { value: [] } },
    ]);

    await client.odataGet('/QueueDefinitions');

    const everything = logLines.join('\n');
    assert.ok(logLines.length > 0, 'the client should log something');
    assert.ok(!everything.includes('super-sensitive-token'), 'token must never be logged');
    assert.ok(!everything.includes('super-secret-value'), 'client secret must never be logged');
  });

  it('redacts a client_secret echoed back in a token error body', async () => {
    const { client } = harness([
      {
        status: 400,
        rawBody: JSON.stringify({ error: 'invalid_client', client_secret: 'super-secret-value' }),
      },
    ]);

    await assert.rejects(client.odataGet('/QueueDefinitions'), (error: unknown) => {
      const message = (error as Error).message;
      assert.ok(!message.includes('super-secret-value'), 'secret must not reach the exception message');
      assert.match(message, /REDACTED/);
      return true;
    });
  });
});
