import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrchestratorConfig } from '../config/schema.ts';
import { createLogger } from '../logger.ts';
import { OrchestratorQueueProvider } from '../queue/OrchestratorQueueProvider.ts';
import { EnvSecretProvider, SecretResolver } from '../secrets.ts';
import { BucketClient } from './BucketClient.ts';
import { OrchestratorClient } from './OrchestratorClient.ts';

/**
 * Integration smoke test against a real sandbox tenant.
 *
 * Off unless ORCH_SMOKE=1, so it never runs in an ordinary `pnpm test`. This is
 * the test that settles the `TODO(orchestrator):` markers, because it is the
 * only one that talks to a real Orchestrator version.
 *
 *   ORCH_SMOKE=1 \
 *   ORCH_BASE_URL=https://cloud.uipath.com \
 *   ORCH_ORGANIZATION=... ORCH_TENANT=... ORCH_FOLDER_ID=... \
 *   ORCH_CLIENT_ID=... ORCH_CLIENT_SECRET=... \
 *   ORCH_QUEUE_NAME=... \
 *   [ORCH_ROBOT_KEY=...] [ORCH_BUCKET_NAME=...] \
 *   pnpm test
 *
 * Everything it writes is synthetic and clearly marked. It never reads or
 * writes real member or group data.
 */

const ENABLED = process.env['ORCH_SMOKE'] === '1';

const REQUIRED = [
  'ORCH_BASE_URL',
  'ORCH_FOLDER_ID',
  'ORCH_CLIENT_ID',
  'ORCH_CLIENT_SECRET',
  'ORCH_QUEUE_NAME',
] as const;

function missingVars(): string[] {
  return REQUIRED.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === '';
  });
}

function config(): OrchestratorConfig {
  const organization = process.env['ORCH_ORGANIZATION'];
  const tenant = process.env['ORCH_TENANT'];

  return {
    baseUrl: process.env['ORCH_BASE_URL'] as string,
    ...(organization === undefined || organization === '' ? {} : { organization }),
    ...(tenant === undefined || tenant === '' ? {} : { tenant }),
    folderId: Number(process.env['ORCH_FOLDER_ID']),
    scopes: (process.env['ORCH_SCOPES'] ?? 'OR.Queues OR.Assets OR.Administration').split(/\s+/),
    clientIdEnv: 'ORCH_CLIENT_ID',
    clientSecretEnv: 'ORCH_CLIENT_SECRET',
    requestTimeoutMs: 30_000,
    maxRetries: 2,
    tokenRefreshSkewMs: 60_000,
  };
}

function buildClient(): OrchestratorClient {
  return new OrchestratorClient({
    config: config(),
    secrets: new SecretResolver(new EnvSecretProvider()),
    logger: createLogger({ level: process.env['ORCH_SMOKE_LOG'] ?? 'silent', pretty: true, base: {} }),
  });
}

describe(
  'Orchestrator smoke (sandbox)',
  {
    skip: ENABLED
      ? false
      : 'set ORCH_SMOKE=1 plus the ORCH_* variables to run this against a sandbox tenant',
  },
  () => {
    it('has all the environment variables it needs', () => {
      const missing = missingVars();
      assert.equal(
        missing.length,
        0,
        `ORCH_SMOKE=1 but these variables are missing: ${missing.join(', ')}. ` +
          'See the "UiPath Orchestrator integration" section of the README.',
      );
    });

    it('authenticates and reports its granted scopes', async () => {
      const client = buildClient();
      const token = await client.tokenInfo();

      assert.ok(token.expiresInMs > 0, 'token should not already be expired');
      assert.ok(token.grantedScopes.length > 0, 'no scopes were granted');
      process.stdout.write(`    api root       : ${client.apiRoot}\n`);
      process.stdout.write(`    granted scopes : ${token.grantedScopes.join(' ')}\n`);
      await client.close();
    });

    it('completes a full add -> getNext -> complete round trip', async () => {
      const client = buildClient();
      const logger = createLogger({ level: 'silent', pretty: false, base: {} });
      const robotKey = process.env['ORCH_ROBOT_KEY'];
      const mode = robotKey === undefined || robotKey === '' ? 'odata' : 'robot';

      const queue = new OrchestratorQueueProvider({
        client,
        queueName: process.env['ORCH_QUEUE_NAME'] as string,
        mode,
        robotIdentifier: robotKey,
        logger,
        specificContentEncoding: 'json-encoded',
      });

      process.stdout.write(`    queue mode     : ${mode} (retries owned by ${queue.retryOwner})\n`);
      await queue.init();

      // Synthetic, unique, and obviously not real data.
      const reference = `SMOKE-${Date.now()}`;
      const payload = {
        smokeTest: true,
        groupId: 'GRP-0000',
        note: 'synthetic smoke test item, safe to delete',
        nested: { encoded: true, values: [1, 2, 3] },
      };

      const added = await queue.add({ reference, priority: 'low', payload });
      assert.equal(added.reference, reference);

      const claimed = await queue.getNext();
      assert.ok(claimed !== null, 'getNext returned nothing; is another worker draining this queue?');

      // Confirms the SpecificContent round trip survives a real Orchestrator.
      if (claimed.reference === reference) {
        assert.deepEqual(claimed.payload, payload, 'SpecificContent did not round-trip');
      } else {
        process.stdout.write(
          `    note           : picked up ${claimed.reference} rather than ${reference}; ` +
            'the queue already had work\n',
        );
      }

      await queue.complete(claimed);
      await queue.close();
      await client.close();
    });

    it('uploads and downloads a file through a storage bucket', async (t) => {
      const bucket = process.env['ORCH_BUCKET_NAME'];
      if (bucket === undefined || bucket === '') {
        t.skip('set ORCH_BUCKET_NAME to exercise storage buckets (needs OR.Administration)');
        return;
      }

      const client = buildClient();
      const buckets = new BucketClient({
        client,
        logger: createLogger({ level: 'silent', pretty: false, base: {} }),
      });

      const remotePath = `smoke/${Date.now()}-smoke.txt`;
      const contents = new TextEncoder().encode(`synthetic smoke payload ${new Date().toISOString()}`);

      await buckets.upload({ bucket, path: remotePath, contentType: 'text/plain', data: contents });
      const roundTripped = await buckets.download({ bucket, path: remotePath });

      assert.deepEqual(
        Array.from(roundTripped),
        Array.from(contents),
        'bytes differed between upload and download',
      );
      process.stdout.write(`    bucket path    : ${remotePath}\n`);
      await client.close();
    });
  },
);
