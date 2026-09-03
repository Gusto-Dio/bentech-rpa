import path from 'node:path';
import type { Logger } from 'pino';
import type { ResolvedConfig } from '../config/schema.ts';
import type { QueueProvider } from '../contracts/QueueProvider.ts';
import { SystemException } from '../errors.ts';
import type { AutomationManifest } from '../manifest.ts';
import { OrchestratorClient } from '../orchestrator/OrchestratorClient.ts';
import { ChainedSecretProvider } from '../secrets/ChainedSecretProvider.ts';
import { OrchestratorAssetsProvider } from '../secrets/OrchestratorAssetsProvider.ts';
import { EnvSecretProvider, SecretResolver } from '../secrets.ts';
import { LocalQueueProvider } from './LocalQueueProvider.ts';
import { OrchestratorQueueProvider, type RetryOwner } from './OrchestratorQueueProvider.ts';

/**
 * Resolves which queue backend a run uses.
 *
 * This is the only place that knows both backends exist. The runner receives a
 * QueueProvider and a retryOwner, and is otherwise unaware of Orchestrator.
 */

export interface CreateQueueProviderInput {
  config: ResolvedConfig<unknown>;
  manifest: AutomationManifest;
  /** Absolute path to the automation folder, for seed data in local mode. */
  automationDir: string;
  dataDir: string;
  secrets: SecretResolver;
  logger: Logger;
  abortSignal?: AbortSignal | undefined;
}

export interface QueueProviderBundle {
  queue: QueueProvider;
  /**
   * Who retries a System exception. The runner honours this instead of always
   * retrying, because in Orchestrator robot mode the platform owns retries and
   * doing both would multiply real executions.
   */
  retryOwner: RetryOwner;
  /**
   * Secrets, possibly widened to read Orchestrator assets. Returned because
   * the chain can only be built once the Orchestrator client exists.
   */
  secrets: SecretResolver;
  /** Present only for the Orchestrator backend. Used by `rpa orchestrator check`. */
  client?: OrchestratorClient;
  /**
   * The same provider as `queue`, typed concretely, so dispatcher-side calls
   * like add() are available without a cast. Absent for the local backend.
   */
  orchestratorQueue?: OrchestratorQueueProvider;
}

export async function createQueueProvider(
  input: CreateQueueProviderInput,
): Promise<QueueProviderBundle> {
  if (input.config.queue.provider === 'local') {
    return {
      queue: new LocalQueueProvider({
        file: path.join(input.dataDir, `queue.${input.manifest.queue.name}.json`),
        seedFile: path.join(input.automationDir, 'data', 'seed', 'queue.json'),
        queueName: input.manifest.queue.name,
        logger: input.logger,
      }),
      retryOwner: 'runner',
      secrets: input.secrets,
    };
  }

  const orchestratorConfig = input.config.orchestrator;
  if (orchestratorConfig === undefined) {
    // Config validation already rejects this; the guard keeps the type honest
    // and gives a clear message if someone constructs a config in code.
    throw new SystemException(
      'queue.provider is "orchestrator" but no orchestrator config block is present',
    );
  }

  const client = new OrchestratorClient({
    config: orchestratorConfig,
    secrets: input.secrets,
    logger: input.logger,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
  });

  const robotIdentifier =
    input.config.queue.robotIdentifierEnv === undefined
      ? undefined
      : await input.secrets.optional(input.config.queue.robotIdentifierEnv);

  /**
   * Widen secrets to fall back to Orchestrator assets, env first.
   *
   * Env-first is deliberate: a developer's .env should be able to point one
   * automation at a sandbox without editing shared tenant configuration, while
   * a deployed run has no .env and falls through to Orchestrator.
   */
  const secrets = new SecretResolver(
    new ChainedSecretProvider([
      new EnvSecretProvider(),
      new OrchestratorAssetsProvider({
        client,
        logger: input.logger,
        robotIdentifier,
      }),
    ]),
  );

  const queue = new OrchestratorQueueProvider({
    client,
    queueName: input.manifest.queue.name,
    mode: input.config.queue.mode,
    robotIdentifier,
    logger: input.logger,
    specificContentEncoding: input.config.queue.specificContentEncoding,
  });

  return { queue, retryOwner: queue.retryOwner, secrets, client, orchestratorQueue: queue };
}
