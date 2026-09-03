import {
  createLogger,
  DEFAULT_PLATFORM_CONFIG,
  LoggerAuditSink,
  SecretResolver,
  type AuditSink,
  type AutomationManifest,
  type Logger,
  type QueueItem,
  type ResolvedConfig,
  type SecretProvider,
  type Session,
  type StopSignal,
  type TxContext,
} from '@rpa/core';
import { FakeSession } from './FakeSession.ts';

/** Silent by default: a test suite that prints a run's worth of logs is unreadable. */
export function createTestLogger(level = 'silent'): Logger {
  return createLogger({ level, pretty: false, base: {} });
}

export function createTestManifest(overrides: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    id: 'test-domain/test-automation',
    name: 'Test Automation',
    description: '',
    domain: 'test-domain',
    owners: ['@test/owner'],
    criticality: 'low',
    sessionKind: 'none',
    entry: 'src/index.ts',
    queue: { name: 'test-domain.test-automation' },
    tags: [],
    ...overrides,
  };
}

export function createTestQueueItem<TPayload>(
  payload: TPayload,
  overrides: Partial<QueueItem<TPayload>> = {},
): QueueItem<TPayload> {
  return {
    id: 'test-1',
    reference: 'TEST-1',
    priority: 'normal',
    payload,
    status: 'inProgress',
    retryCount: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

/** A secret provider backed by a plain object, so tests never touch process.env. */
export class MapSecretProvider implements SecretProvider {
  readonly name = 'test-map';
  readonly #values: Readonly<Record<string, string>>;

  constructor(values: Readonly<Record<string, string>> = {}) {
    this.#values = values;
  }

  async get(key: string): Promise<string | undefined> {
    return this.#values[key];
  }
}

export interface TestContextOptions<TPayload, TConfig> {
  payload: TPayload;
  automationConfig: TConfig;
  attempt?: number;
  manifest?: Partial<AutomationManifest>;
  secrets?: Readonly<Record<string, string>>;
  session?: Session;
  logger?: Logger;
}

/**
 * Builds a TxContext so a single transaction can be exercised without the
 * runner, a browser or a queue.
 *
 * This is what makes business rules testable in milliseconds: the rules are the
 * part most worth testing, and they do not need any of the machinery around
 * them.
 */
export function createTestTxContext<TPayload, TConfig>(
  options: TestContextOptions<TPayload, TConfig>,
): TxContext<TPayload, TConfig> {
  const logger = options.logger ?? createTestLogger();
  const manifest = createTestManifest(options.manifest);
  const session = options.session ?? new FakeSession();
  const audit: AuditSink = new LoggerAuditSink(logger);

  const config: ResolvedConfig<TConfig> = {
    ...DEFAULT_PLATFORM_CONFIG,
    env: 'test',
    automation: options.automationConfig,
    sources: ['test'],
  };

  const stop: StopSignal = {
    requested: false,
    reason: undefined,
    abortSignal: new AbortController().signal,
    request: () => undefined,
  };

  return {
    runId: 'test-run',
    manifest,
    config,
    logger,
    secrets: new SecretResolver(new MapSecretProvider(options.secrets ?? {})),
    audit,
    paths: {
      repoRoot: '/test',
      automationDir: '/test/automations/test-domain/test-automation',
      dataDir: '/test/data',
      artifactsDir: '/test/artifacts',
      runArtifactsDir: '/test/artifacts/test-run',
    },
    stop,
    session,
    state: new Map<string, unknown>(),
    item: createTestQueueItem(options.payload),
    attempt: options.attempt ?? 1,
  };
}
