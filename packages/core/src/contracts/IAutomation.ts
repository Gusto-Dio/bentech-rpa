import type { Logger } from 'pino';
import type { Page } from 'playwright';
import type { ZodType } from 'zod';
import type { ResolvedConfig } from '../config/schema.ts';
import type { AutomationManifest } from '../manifest.ts';
import type { SecretResolver } from '../secrets.ts';
import type { StopSignal } from '../signals.ts';
import type { RunSummary } from '../runner/summary.ts';
import type { AuditSink } from './AuditSink.ts';
import type { QueueItem } from './QueueProvider.ts';
import type { Session } from './Session.ts';

export interface AutomationPaths {
  repoRoot: string;
  automationDir: string;
  /** <repoRoot>/data - queue state and any input files. */
  dataDir: string;
  artifactsDir: string;
  /** <artifactsDir>/<runId> - everything this run produced. */
  runArtifactsDir: string;
}

/** Available during Initialize and EndProcess. */
export interface InitContext<TConfig = unknown> {
  readonly runId: string;
  readonly manifest: AutomationManifest;
  readonly config: ResolvedConfig<TConfig>;
  readonly logger: Logger;
  readonly secrets: SecretResolver;
  readonly audit: AuditSink;
  readonly paths: AutomationPaths;
  readonly stop: StopSignal;
  readonly session: Session;
  /**
   * Scratch space that lives for the whole run, for things Initialize computed
   * and transactions need - reference data, a parsed catalogue, an auth token.
   * REFramework kept these as workflow-level variables.
   */
  readonly state: Map<string, unknown>;
}

/** Available during ProcessTransaction. */
export interface TxContext<TPayload, TConfig = unknown> extends InitContext<TConfig> {
  readonly item: QueueItem<TPayload>;
  /** 1-based. attempt > 1 means a System exception was retried after session recovery. */
  readonly attempt: number;
}

/**
 * Browser flavours of the contexts. Two parallel context types, rather than one
 * with `page?: Page`, so that a UI automation never writes `ctx.page!` and a
 * file automation cannot reach for a page that was never launched. The single
 * unsound cast this requires lives in the runner, once.
 */
export interface WebInitContext<TConfig = unknown> extends InitContext<TConfig> {
  readonly page: Page;
}

export interface WebTxContext<TPayload, TConfig = unknown> extends TxContext<TPayload, TConfig> {
  readonly page: Page;
}

interface AutomationLifecycle<TConfig, TInit extends InitContext<TConfig>> {
  /**
   * Validates this automation's `automation` config subtree. Declaring it is
   * what turns a missing setting into a precise startup error.
   */
  readonly configSchema?: ZodType<TConfig>;

  /**
   * InitAllSettings + InitAllApplications.
   *
   * MUST be idempotent: it runs once at startup and again after every session
   * recovery, exactly as REFramework re-invokes InitAllApplications.
   */
  initialize(ctx: TInit): Promise<void>;

  /** CloseAllApplications-adjacent cleanup plus any end-of-run reporting. */
  endProcess(ctx: TInit, summary: RunSummary): Promise<void>;
}

export interface AutomationDefinition<TPayload, TConfig = unknown>
  extends AutomationLifecycle<TConfig, InitContext<TConfig>> {
  /** Malformed payload is a BusinessException: no retry will fix bad data. */
  parsePayload(raw: unknown): TPayload;
  processTransaction(ctx: TxContext<TPayload, TConfig>): Promise<void>;
  /** Optional per-automation failure hook, in addition to the framework's screenshot/trace capture. */
  onTransactionFailure?(ctx: TxContext<TPayload, TConfig>, error: Error): Promise<void>;
}

export interface WebAutomationDefinition<TPayload, TConfig = unknown>
  extends AutomationLifecycle<TConfig, WebInitContext<TConfig>> {
  parsePayload(raw: unknown): TPayload;
  processTransaction(ctx: WebTxContext<TPayload, TConfig>): Promise<void>;
  onTransactionFailure?(ctx: WebTxContext<TPayload, TConfig>, error: Error): Promise<void>;
}

/** What the runner holds. Method parameter bivariance makes both flavours assignable. */
export type AnyAutomationDefinition = AutomationDefinition<unknown, unknown>;

/** Identity function. Exists purely so TypeScript infers TPayload and TConfig from the object literal. */
export function defineAutomation<TPayload, TConfig = unknown>(
  definition: AutomationDefinition<TPayload, TConfig>,
): AutomationDefinition<TPayload, TConfig> {
  return definition;
}

/** As defineAutomation, for `sessionKind: "browser"`. Gives ctx.page a non-optional type. */
export function defineWebAutomation<TPayload, TConfig = unknown>(
  definition: WebAutomationDefinition<TPayload, TConfig>,
): WebAutomationDefinition<TPayload, TConfig> {
  return definition;
}
