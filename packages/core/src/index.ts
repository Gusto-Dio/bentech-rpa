/**
 * @rpa/core - the public API surface.
 *
 * Automations import from "@rpa/core" and nothing else (plus their own domain
 * `_shared` package). Deep imports into these files are blocked by lint and by
 * `rpa validate`, so that the platform team can restructure internals without
 * a 100-automation migration.
 */

// ── Authoring an automation ──────────────────────────────────────────────────
export {
  defineAutomation,
  defineWebAutomation,
  type AnyAutomationDefinition,
  type AutomationDefinition,
  type AutomationPaths,
  type InitContext,
  type TxContext,
  type WebAutomationDefinition,
  type WebInitContext,
  type WebTxContext,
} from './contracts/IAutomation.ts';

// ── The Business / System contract ───────────────────────────────────────────
export {
  AutomationError,
  BusinessException,
  SystemException,
  classifyError,
  isBusinessException,
  isSystemException,
  serializeError,
  toError,
  type FailureReason,
  type SerializedError,
} from './errors.ts';

// ── Steps: precondition -> action -> postcondition ───────────────────────────
export {
  step,
  type StepContext,
  type StepOutcome,
  type StepPhase,
  type StepResult,
  type StepSpec,
} from './steps.ts';

// ── Gates: the WAITING answers a step() gate needs ───────────────────────────
export { hidden, textVisible, valueIs, visible } from './gates.ts';

// ── MFA (seam) ───────────────────────────────────────────────────────────────
export {
  extractMfaCode,
  isAllowedSender,
  type MfaCodeProvider,
  type MfaCodeRequest,
  type MfaMatcher,
} from './mfa/MfaCodeProvider.ts';
export { createMfaProvider, type CreateMfaProviderOptions } from './mfa/factory.ts';
export {
  GmailApiMfaProvider,
  buildMfaQuery,
  type GmailApiMfaProviderOptions,
} from './mfa/GmailApiMfaProvider.ts';
export {
  ImapMfaProvider,
  type ImapCredentials,
  type ImapFetchedMessage,
  type ImapMfaProviderOptions,
  type ImapRange,
  type ImapSearchObject,
  type ImapSession,
} from './mfa/ImapMfaProvider.ts';
export {
  GmailUiMfaProvider,
  PlaywrightGmailUiPage,
  parseAccountFromTitle,
  parseGmailDate,
  type GmailRow,
  type GmailUiMfaProviderOptions,
  type GmailUiMode,
  type GmailUiPage,
} from './mfa/GmailUiMfaProvider.ts';
export { ManualMfaProvider } from './mfa/ManualMfaProvider.ts';
export { StaticMfaProvider } from './mfa/StaticMfaProvider.ts';

// ── Retry helpers (RetryScope analogue) ──────────────────────────────────────
export {
  computeBackoff,
  sleep,
  withRetry,
  withTimeout,
  type BackoffPolicy,
  type WithRetryOptions,
} from './retry.ts';

// ── Queue ────────────────────────────────────────────────────────────────────
export type {
  Priority,
  QueueItem,
  QueueProvider,
  QueueStats,
  TransactionStatus,
} from './contracts/QueueProvider.ts';
export {
  LocalQueueProvider,
  readLocalQueueStats,
  type LocalQueueProviderOptions,
} from './queue/LocalQueueProvider.ts';
export {
  OrchestratorQueueProvider,
  type OrchestratorQueueMode,
  type OrchestratorQueueProviderOptions,
  type RetryOwner,
} from './queue/OrchestratorQueueProvider.ts';
export {
  createQueueProvider,
  type CreateQueueProviderInput,
  type QueueProviderBundle,
} from './queue/factory.ts';

// ── UiPath Orchestrator ──────────────────────────────────────────────────────
export {
  OrchestratorClient,
  type OrchestratorClientOptions,
  type TokenInfo,
} from './orchestrator/OrchestratorClient.ts';
export { BucketClient, readRequiredHeaders, type BucketClientOptions } from './orchestrator/BucketClient.ts';
export {
  DUPLICATE_REFERENCE_ERROR_CODES,
  describeOrchestratorError,
  isDuplicateReference,
  isRetryableStatus,
  mapOrchestratorError,
  parseErrorBody,
  parseRetryAfterMs,
  type OrchestratorErrorBody,
  type OrchestratorHttpFailure,
} from './orchestrator/errors.ts';
export {
  JSON_FIELDS_KEY,
  fromSpecificContent,
  toSpecificContent,
  type SpecificContent,
  type SpecificContentEncoding,
  type SpecificContentValue,
} from './orchestrator/specificContent.ts';

// ── Sessions ─────────────────────────────────────────────────────────────────
export {
  isEvidenceCapable,
  type EvidenceCapableSession,
  type Session,
  type SessionKind,
} from './contracts/Session.ts';
export {
  BrowserSession,
  chromiumLaunchOptions,
  type BrowserSessionOptions,
} from './session/BrowserSession.ts';
export { NoopSession } from './session/NoopSession.ts';

// ── Secrets (vault seam) ─────────────────────────────────────────────────────
export {
  EnvSecretProvider,
  SecretResolver,
  type Credential,
  type SecretProvider,
} from './secrets.ts';
export { ChainedSecretProvider } from './secrets/ChainedSecretProvider.ts';
export {
  OrchestratorAssetsProvider,
  type OrchestratorAssetsProviderOptions,
} from './secrets/OrchestratorAssetsProvider.ts';

// ── Audit (governance seam) ──────────────────────────────────────────────────
export {
  LoggerAuditSink,
  type AuditEvent,
  type AuditEventType,
  type AuditSink,
} from './contracts/AuditSink.ts';

// ── Config ───────────────────────────────────────────────────────────────────
export { ENV_OVERRIDES, loadConfig, type LoadConfigOptions } from './config/load.ts';
export {
  DEFAULT_PLATFORM_CONFIG,
  browserConfigSchema,
  gmailApiConfigSchema,
  imapConfigSchema,
  logLevelSchema,
  mfaConfigSchema,
  orchestratorConfigSchema,
  platformConfigSchema,
  queueConfigSchema,
  type BrowserConfig,
  type GmailApiConfig,
  type ImapConfig,
  type LogLevel,
  type MfaConfig,
  type OrchestratorConfig,
  type PlatformConfig,
  type QueueConfig,
  type ResolvedConfig,
} from './config/schema.ts';

// ── Manifest & registry ──────────────────────────────────────────────────────
export {
  AUTOMATION_ID_PATTERN,
  SEGMENT_PATTERN,
  automationManifestSchema,
  checkManifestLocation,
  criticalitySchema,
  type AutomationManifest,
  type Criticality,
  type ManifestIssue,
} from './manifest.ts';
export {
  AUTOMATIONS_DIR,
  MANIFEST_FILENAME,
  discoverAutomations,
  findAutomation,
  findRepoRoot,
  loadAutomationDefinition,
  type DiscoveredAutomation,
  type DiscoveryFailure,
  type DiscoveryResult,
} from './registry.ts';

// ── Runner ───────────────────────────────────────────────────────────────────
export { runAutomation, type RunOptions, type RunResult } from './runner/runner.ts';
export {
  EXIT_CODES,
  exitCodeFor,
  formatSummary,
  type RunSummary,
} from './runner/summary.ts';
export {
  TRANSACTION_LOG_STATUS,
  type RunnerState,
  type TransactionOutcome,
} from './runner/states.ts';

// ── Logging & signals ────────────────────────────────────────────────────────
export { REDACT_PATHS, createLogger, type CreateLoggerOptions, type Logger } from './logger.ts';
export { installStopSignal, type InstalledStopSignal, type StopSignal } from './signals.ts';

// ── Artifacts ────────────────────────────────────────────────────────────────
export { ArtifactStore, type ArtifactStoreOptions, type FailureArtifacts } from './artifacts.ts';
