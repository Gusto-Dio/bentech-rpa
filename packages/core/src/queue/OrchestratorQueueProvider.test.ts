import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrchestratorConfig } from '../config/schema.ts';
import { BusinessException } from '../errors.ts';
import { createLogger } from '../logger.ts';
import { OrchestratorClient } from '../orchestrator/OrchestratorClient.ts';
import {
  createFetchMock,
  tokenResponse,
  type MockResponseSpec,
} from '../orchestrator/testFetch.ts';
import { SecretResolver, type SecretProvider } from '../secrets.ts';
import { OrchestratorQueueProvider, type OrchestratorQueueMode } from './OrchestratorQueueProvider.ts';

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
  scopes: ['OR.Queues'],
  clientIdEnv: 'ORCH_CLIENT_ID',
  clientSecretEnv: 'ORCH_CLIENT_SECRET',
  requestTimeoutMs: 5_000,
  maxRetries: 0,
  tokenRefreshSkewMs: 60_000,
};

/** QueueDefinitions lookup performed by init(). */
const QUEUE_DEFINITION: MockResponseSpec = {
  body: { value: [{ Id: 99, Name: 'group-submission.demo' }] },
};

function queueItemDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 1234,
    Reference: 'SUB-1001',
    Priority: 'High',
    Status: 'InProgress',
    RetryNumber: 0,
    CreationTime: '2026-09-01T00:00:00Z',
    SpecificContent: {
      groupId: 'GRP-8842',
      contact: '{"firstName":"Ada"}',
      __jsonFields: '["contact"]',
    },
    ...overrides,
  };
}

async function build(
  mode: OrchestratorQueueMode,
  script: readonly MockResponseSpec[],
): Promise<{
  provider: OrchestratorQueueProvider;
  mock: ReturnType<typeof createFetchMock>;
}> {
  const mock = createFetchMock(script);
  const logger = createLogger({ level: 'silent', pretty: false, base: {} });

  const client = new OrchestratorClient({
    config: CONFIG,
    secrets: new SecretResolver(new MapProvider()),
    logger,
    fetchImpl: mock.fetchImpl,
  });

  const provider = new OrchestratorQueueProvider({
    client,
    queueName: 'group-submission.demo',
    mode,
    robotIdentifier: mode === 'robot' ? 'robot-key-1' : undefined,
    logger,
    specificContentEncoding: 'json-encoded',
  });

  return { provider, mock };
}

function bodyOf(call: { body: string | undefined }): Record<string, unknown> {
  return JSON.parse(call.body ?? '{}') as Record<string, unknown>;
}

describe('OrchestratorQueueProvider - retry ownership', () => {
  it('robot mode hands retries to Orchestrator', async () => {
    const { provider } = await build('robot', []);
    assert.equal(provider.retryOwner, 'orchestrator');
  });

  it('odata mode leaves retries with the runner', async () => {
    const { provider } = await build('odata', []);
    assert.equal(provider.retryOwner, 'runner');
  });
});

describe('OrchestratorQueueProvider - init', () => {
  it('resolves the queue definition by name', async () => {
    const { provider, mock } = await build('robot', [tokenResponse(), QUEUE_DEFINITION]);
    await provider.init();
    assert.match(mock.apiCalls()[0]?.url ?? '', /QueueDefinitions/);
    assert.match(decodeURIComponent(mock.apiCalls()[0]?.url ?? ''), /Name eq 'group-submission.demo'/);
  });

  it('fails with an actionable message when the queue does not exist', async () => {
    const { provider } = await build('robot', [tokenResponse(), { body: { value: [] } }]);
    await assert.rejects(provider.init(), /does not exist in the configured Orchestrator folder/);
  });

  it('refuses robot mode without a robot identifier', async () => {
    const mock = createFetchMock([]);
    const logger = createLogger({ level: 'silent', pretty: false, base: {} });
    const provider = new OrchestratorQueueProvider({
      client: new OrchestratorClient({
        config: CONFIG,
        secrets: new SecretResolver(new MapProvider()),
        logger,
        fetchImpl: mock.fetchImpl,
      }),
      queueName: 'q',
      mode: 'robot',
      robotIdentifier: undefined,
      logger,
      specificContentEncoding: 'json-encoded',
    });

    await assert.rejects(provider.init(), /no robot identifier was resolved/);
  });
});

describe('OrchestratorQueueProvider - robot mode', () => {
  it('starts a transaction and maps the item, decoding SpecificContent', async () => {
    const { provider, mock } = await build('robot', [
      tokenResponse(),
      QUEUE_DEFINITION,
      { body: queueItemDto() },
    ]);

    await provider.init();
    const item = await provider.getNext();

    assert.ok(item);
    assert.equal(item.id, '1234');
    assert.equal(item.reference, 'SUB-1001');
    assert.equal(item.priority, 'high');
    assert.equal(item.status, 'inProgress');
    assert.deepEqual(item.payload, { groupId: 'GRP-8842', contact: { firstName: 'Ada' } });

    const start = mock.apiCalls().at(-1);
    assert.match(start?.url ?? '', /UiPathODataSvc\.StartTransaction/);
    const payload = bodyOf(start!) as { transactionData: Record<string, unknown> };
    assert.equal(payload.transactionData['Name'], 'group-submission.demo');
    assert.equal(payload.transactionData['RobotIdentifier'], 'robot-key-1');
  });

  /**
   * A drained queue is reported differently across versions, so all three
   * observed shapes must read as "no work" rather than as an error.
   */
  for (const [label, spec] of [
    ['204 No Content', { status: 204 } as MockResponseSpec],
    ['200 with an empty body', { status: 200, rawBody: '' } as MockResponseSpec],
    ['200 with an object carrying no Id', { body: {} } as MockResponseSpec],
  ] as const) {
    it(`treats ${label} as a drained queue`, async () => {
      const { provider } = await build('robot', [tokenResponse(), QUEUE_DEFINITION, spec]);
      await provider.init();
      assert.equal(await provider.getNext(), null);
    });
  }

  it('reports success as IsSuccessful true', async () => {
    const { provider, mock } = await build('robot', [
      tokenResponse(),
      QUEUE_DEFINITION,
      { body: queueItemDto() },
      { status: 200, body: {} },
    ]);

    await provider.init();
    const item = await provider.getNext();
    await provider.complete(item!);

    const call = mock.apiCalls().at(-1);
    assert.match(call?.url ?? '', /Queues\(1234\)\/UiPathODataSvc\.SetTransactionResult/);
    const result = (bodyOf(call!) as { transactionResult: Record<string, unknown> }).transactionResult;
    assert.equal(result['IsSuccessful'], true);
  });

  /**
   * The Type field is what carries the Business/System split into Orchestrator:
   * BusinessException is terminal there too, ApplicationException is what
   * triggers Auto-Retry.
   */
  it('reports a business failure as ProcessingException.Type BusinessException', async () => {
    const { provider, mock } = await build('robot', [
      tokenResponse(),
      QUEUE_DEFINITION,
      { body: queueItemDto() },
      { status: 200, body: {} },
    ]);

    await provider.init();
    const item = await provider.getNext();
    await provider.fail(item!, 'business', new BusinessException('plan not offered'));

    const result = (bodyOf(mock.apiCalls().at(-1)!) as { transactionResult: Record<string, unknown> })
      .transactionResult as Record<string, Record<string, unknown>>;
    assert.equal(result['IsSuccessful'], false);
    assert.equal(result['ProcessingException']?.['Type'], 'BusinessException');
    assert.match(String(result['ProcessingException']?.['Reason']), /plan not offered/);
  });

  it('reports a system failure as ApplicationException, so Auto-Retry applies', async () => {
    const { provider, mock } = await build('robot', [
      tokenResponse(),
      QUEUE_DEFINITION,
      { body: queueItemDto() },
      { status: 200, body: {} },
    ]);

    await provider.init();
    const item = await provider.getNext();
    await provider.fail(item!, 'system', new Error('portal down'));

    const result = (bodyOf(mock.apiCalls().at(-1)!) as { transactionResult: Record<string, unknown> })
      .transactionResult as Record<string, Record<string, unknown>>;
    assert.equal(result['ProcessingException']?.['Type'], 'ApplicationException');
  });

  /** Orchestrator rejects IsSuccessful:false without a ProcessingException. */
  it('always includes ProcessingException on failure', async () => {
    const { provider, mock } = await build('robot', [
      tokenResponse(),
      QUEUE_DEFINITION,
      { body: queueItemDto() },
      { status: 200, body: {} },
    ]);

    await provider.init();
    const item = await provider.getNext();
    await provider.fail(item!, 'system', new Error('x'));

    const result = (bodyOf(mock.apiCalls().at(-1)!) as { transactionResult: Record<string, unknown> })
      .transactionResult as Record<string, unknown>;
    assert.ok(result['ProcessingException'] !== undefined);
  });

  it('does not send the exception details object, which can carry payload fields', async () => {
    const { provider, mock } = await build('robot', [
      tokenResponse(),
      QUEUE_DEFINITION,
      { body: queueItemDto() },
      { status: 200, body: {} },
    ]);

    await provider.init();
    const item = await provider.getNext();
    await provider.fail(
      item!,
      'business',
      new BusinessException('declined', { details: { ssn: '000-00-0000' } }),
    );

    assert.ok(!(mock.apiCalls().at(-1)?.body ?? '').includes('000-00-0000'));
  });
});

describe('OrchestratorQueueProvider - odata mode', () => {
  it('filters for New items in the resolved queue and ranks by priority in code', async () => {
    const { provider, mock } = await build('odata', [
      tokenResponse(),
      QUEUE_DEFINITION,
      {
        body: {
          value: [
            queueItemDto({ Id: 1, Reference: 'LOW', Priority: 'Low', Status: 'New' }),
            queueItemDto({ Id: 2, Reference: 'HIGH', Priority: 'High', Status: 'New' }),
          ],
        },
      },
      { status: 200, body: {} },
    ]);

    await provider.init();
    const item = await provider.getNext();

    const query = decodeURIComponent(mock.apiCalls()[1]?.url ?? '');
    assert.match(query, /QueueDefinitionId eq 99/);
    assert.match(query, /Status eq 'New'/);
    // Ordering by CreationTime, not by the Priority enum, whose numeric order
    // is not something to depend on.
    assert.match(query, /CreationTime asc/);
    assert.equal(item?.reference, 'HIGH', 'highest priority wins client-side');
  });

  it('does not hand the same item out twice within a run', async () => {
    const { provider } = await build('odata', [
      tokenResponse(),
      QUEUE_DEFINITION,
      { body: { value: [queueItemDto({ Id: 5, Status: 'New' })] } },
      { status: 200, body: {} },
      { body: { value: [queueItemDto({ Id: 5, Status: 'New' })] } },
    ]);

    await provider.init();
    assert.equal((await provider.getNext())?.id, '5');
    // Orchestrator still reports it as New, because there is no status
    // transition available - the in-process claim guard is what prevents the
    // double take. This is why the mode is single-worker only.
    assert.equal(await provider.getNext(), null);
  });

  it('tolerates a failing progress marker, which is cosmetic', async () => {
    const { provider } = await build('odata', [
      tokenResponse(),
      QUEUE_DEFINITION,
      { body: { value: [queueItemDto({ Id: 8, Status: 'New' })] } },
      { status: 500, body: { message: 'progress unavailable' } },
    ]);

    await provider.init();
    assert.equal((await provider.getNext())?.id, '8');
  });
});

describe('OrchestratorQueueProvider - dispatcher', () => {
  it('encodes SpecificContent and sends Reference and Priority', async () => {
    const { provider, mock } = await build('robot', [
      tokenResponse(),
      QUEUE_DEFINITION,
      { body: queueItemDto({ Id: 42, Reference: 'SUB-9', Status: 'New' }) },
    ]);

    await provider.init();
    const created = await provider.add({
      reference: 'SUB-9',
      priority: 'high',
      payload: { groupId: 'GRP-1', contact: { firstName: 'Ada' } },
    });

    const call = mock.apiCalls().at(-1);
    assert.match(call?.url ?? '', /UiPathODataSvc\.AddQueueItem/);

    const itemData = (bodyOf(call!) as { itemData: Record<string, unknown> }).itemData;
    assert.equal(itemData['Name'], 'group-submission.demo');
    assert.equal(itemData['Reference'], 'SUB-9');
    assert.equal(itemData['Priority'], 'High');

    const content = itemData['SpecificContent'] as Record<string, unknown>;
    assert.equal(content['groupId'], 'GRP-1');
    assert.equal(typeof content['contact'], 'string', 'nested object must be JSON-encoded');
    assert.equal(created.id, '42');
  });
});

describe('OrchestratorQueueProvider - status mapping', () => {
  it('maps Orchestrator statuses onto the framework model', async () => {
    const cases: Array<[string, string]> = [
      ['New', 'new'],
      ['InProgress', 'inProgress'],
      ['Successful', 'success'],
      ['Failed', 'failed'],
      ['Abandoned', 'abandoned'],
      // Retried means a successor item now carries the work; Deleted is gone.
      // Both are terminal and must never be picked up again.
      ['Retried', 'failed'],
      ['Deleted', 'abandoned'],
    ];

    for (const [orchestrator, expected] of cases) {
      const { provider } = await build('robot', [
        tokenResponse(),
        QUEUE_DEFINITION,
        { body: queueItemDto({ Status: orchestrator }) },
      ]);
      await provider.init();
      assert.equal((await provider.getNext())?.status, expected, orchestrator);
    }
  });

  it('carries a processing exception back as lastError with its type', async () => {
    const { provider } = await build('robot', [
      tokenResponse(),
      QUEUE_DEFINITION,
      {
        body: queueItemDto({
          ProcessingException: { Reason: 'plan missing', Type: 'BusinessException' },
        }),
      },
    ]);

    await provider.init();
    const item = await provider.getNext();
    assert.equal(item?.lastError?.type, 'business');
    assert.equal(item?.lastError?.message, 'plan missing');
  });
});
