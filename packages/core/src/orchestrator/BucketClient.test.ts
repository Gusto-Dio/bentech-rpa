import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrchestratorConfig } from '../config/schema.ts';
import { SystemException } from '../errors.ts';
import { createLogger } from '../logger.ts';
import { SecretResolver, type SecretProvider } from '../secrets.ts';
import { BucketClient, readRequiredHeaders } from './BucketClient.ts';
import { OrchestratorClient } from './OrchestratorClient.ts';
import { createFetchMock, tokenResponse, type MockResponseSpec } from './testFetch.ts';

class MapProvider implements SecretProvider {
  readonly name = 'test';
  async get(key: string): Promise<string | undefined> {
    return { ORCH_CLIENT_ID: 'id', ORCH_CLIENT_SECRET: 'secret' }[key];
  }
}

const CONFIG: OrchestratorConfig = {
  baseUrl: 'https://cloud.uipath.test',
  organization: 'acme',
  tenant: 'DefaultTenant',
  folderId: 7,
  scopes: ['OR.Administration'],
  clientIdEnv: 'ORCH_CLIENT_ID',
  clientSecretEnv: 'ORCH_CLIENT_SECRET',
  requestTimeoutMs: 5_000,
  maxRetries: 0,
  tokenRefreshSkewMs: 60_000,
};

const BUCKET_LOOKUP: MockResponseSpec = { body: { value: [{ Id: 11, Name: 'evidence' }] } };

function build(script: readonly MockResponseSpec[]): {
  buckets: BucketClient;
  mock: ReturnType<typeof createFetchMock>;
} {
  const mock = createFetchMock(script);
  const logger = createLogger({ level: 'silent', pretty: false, base: {} });
  const client = new OrchestratorClient({
    config: CONFIG,
    secrets: new SecretResolver(new MapProvider()),
    logger,
    fetchImpl: mock.fetchImpl,
  });
  return { buckets: new BucketClient({ client, logger }), mock };
}

describe('BucketClient - upload', () => {
  it('resolves the bucket, asks for a write URI, then PUTs the bytes to it', async () => {
    const { buckets, mock } = build([
      tokenResponse(),
      BUCKET_LOOKUP,
      { body: { Uri: 'https://blob.test/container/evidence.png?sig=abc', Verb: 'PUT' } },
      { status: 201, body: {} },
    ]);

    await buckets.upload({
      bucket: 'evidence',
      path: 'runs/SUB-1004/screenshot.png',
      contentType: 'image/png',
      data: new Uint8Array([1, 2, 3]),
    });

    const [, lookup, writeUri, transfer] = mock.calls;
    assert.match(lookup?.url ?? '', /\/Buckets\?/);
    assert.match(writeUri?.url ?? '', /Buckets\(11\)\/UiPath\.Server\.Configuration\.OData\.GetWriteUri/);
    assert.match(decodeURIComponent(writeUri?.url ?? ''), /path=runs\/SUB-1004\/screenshot\.png/);
    assert.match(decodeURIComponent(writeUri?.url ?? ''), /contentType=image\/png/);

    assert.equal(transfer?.url, 'https://blob.test/container/evidence.png?sig=abc');
    assert.equal(transfer?.method, 'PUT');
  });

  /**
   * The signed URI carries its own credential. On several storage backends an
   * unexpected Authorization header invalidates the signature, so the second
   * request must go out clean.
   */
  it('sends no Authorization header to the pre-signed URI', async () => {
    const { buckets, mock } = build([
      tokenResponse(),
      BUCKET_LOOKUP,
      { body: { Uri: 'https://blob.test/x?sig=abc', Verb: 'PUT' } },
      { status: 201, body: {} },
    ]);

    await buckets.upload({
      bucket: 'evidence',
      path: 'a.txt',
      contentType: 'text/plain',
      data: new Uint8Array([1]),
    });

    const transfer = mock.calls.at(-1);
    assert.equal(transfer?.headers['authorization'], undefined);
    assert.equal(transfer?.headers['x-uipath-organizationunitid'], undefined);
  });

  it('authenticates the transfer when Orchestrator says RequiresAuth', async () => {
    const { buckets, mock } = build([
      tokenResponse('tok'),
      BUCKET_LOOKUP,
      { body: { Uri: 'https://cloud.uipath.test/orchestrator_/api/blob', Verb: 'PUT', RequiresAuth: true } },
      { status: 201, body: {} },
    ]);

    await buckets.upload({
      bucket: 'evidence',
      path: 'a.txt',
      contentType: 'text/plain',
      data: new Uint8Array([1]),
    });

    assert.equal(mock.calls.at(-1)?.headers['authorization'], 'Bearer tok');
  });

  it('uses the verb Orchestrator specified rather than assuming PUT', async () => {
    const { buckets, mock } = build([
      tokenResponse(),
      BUCKET_LOOKUP,
      { body: { Uri: 'https://blob.test/x', Verb: 'POST' } },
      { status: 201, body: {} },
    ]);

    await buckets.upload({
      bucket: 'evidence',
      path: 'a.txt',
      contentType: 'text/plain',
      data: new Uint8Array([1]),
    });

    assert.equal(mock.calls.at(-1)?.method, 'POST');
  });

  it('forwards the required headers Orchestrator returned', async () => {
    const { buckets, mock } = build([
      tokenResponse(),
      BUCKET_LOOKUP,
      {
        body: {
          Uri: 'https://blob.test/x',
          Verb: 'PUT',
          Headers: { 'x-ms-blob-type': 'BlockBlob' },
        },
      },
      { status: 201, body: {} },
    ]);

    await buckets.upload({
      bucket: 'evidence',
      path: 'a.txt',
      contentType: 'text/plain',
      data: new Uint8Array([1]),
    });

    assert.equal(mock.calls.at(-1)?.headers['x-ms-blob-type'], 'BlockBlob');
  });

  it('explains the OR.Administration requirement when no URI comes back', async () => {
    const { buckets } = build([tokenResponse(), BUCKET_LOOKUP, { body: {} }]);

    await assert.rejects(
      buckets.upload({
        bucket: 'evidence',
        path: 'a.txt',
        contentType: 'text/plain',
        data: new Uint8Array([1]),
      }),
      /OR\.Administration/,
    );
  });
});

describe('BucketClient - download', () => {
  it('asks for a read URI then GETs the bytes', async () => {
    const { buckets, mock } = build([
      tokenResponse(),
      BUCKET_LOOKUP,
      { body: { Uri: 'https://blob.test/read?sig=abc', Verb: 'GET' } },
      { status: 200, rawBody: 'hello bucket' },
    ]);

    const bytes = await buckets.download({ bucket: 'evidence', path: 'a.txt' });

    assert.match(mock.calls[2]?.url ?? '', /GetReadUri/);
    assert.equal(mock.calls.at(-1)?.method, 'GET');
    assert.equal(new TextDecoder().decode(bytes), 'hello bucket');
  });
});

describe('BucketClient - bucket resolution', () => {
  it('accepts a numeric id without a lookup', async () => {
    const { buckets, mock } = build([tokenResponse()]);
    assert.equal(await buckets.resolveBucketId('11'), 11);
    assert.equal(mock.apiCalls().length, 0, 'a numeric id needs no round trip');
  });

  it('caches a resolved name for the rest of the run', async () => {
    const { buckets, mock } = build([tokenResponse(), BUCKET_LOOKUP]);
    assert.equal(await buckets.resolveBucketId('evidence'), 11);
    assert.equal(await buckets.resolveBucketId('evidence'), 11);
    assert.equal(mock.apiCalls().length, 1);
  });

  it('fails clearly when the bucket is not in the folder', async () => {
    const { buckets } = build([tokenResponse(), { body: { value: [] } }]);
    await assert.rejects(buckets.resolveBucketId('missing'), SystemException);
  });
});

describe('readRequiredHeaders', () => {
  it('reads the plain-object shape', () => {
    assert.deepEqual(readRequiredHeaders({ 'x-a': '1' }), { 'x-a': '1' });
  });

  // Some Orchestrator versions serialise a dictionary as parallel arrays.
  it('reads the parallel Keys/Values shape', () => {
    assert.deepEqual(readRequiredHeaders({ Keys: ['x-a', 'x-b'], Values: ['1', '2'] }), {
      'x-a': '1',
      'x-b': '2',
    });
  });

  it('tolerates absent or mismatched header data', () => {
    assert.deepEqual(readRequiredHeaders(null), {});
    assert.deepEqual(readRequiredHeaders(undefined), {});
    assert.deepEqual(readRequiredHeaders({ Keys: ['x-a'], Values: [] }), {});
  });
});
