import { z } from 'zod';

/**
 * This is REFramework's Config.xlsx, with the sheets replaced by layers:
 *
 *   Settings / Constants -> platform.json + environments/<env>.json + the
 *                            automation's own config.<env>.json
 *   Assets               -> the automation's config declares the NAME of each
 *                            credential; the value is fetched at runtime via
 *                            ctx.secrets. See secrets.ts.
 *
 * Divergence from REFramework worth knowing: there are no untyped
 * `Settings("SomeKey")` string bags. Platform knobs are a strict schema, and
 * each automation declares a Zod schema for its own subtree, so a missing or
 * misspelled setting fails at Initialize with a precise message instead of
 * surfacing as `undefined` in the middle of transaction 40.
 */

export const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const browserConfigSchema = z.strictObject({
  /**
   * Default true, everywhere, including dev. The Ubuntu runtime has no display,
   * so headed mode must be an explicit local opt-in (HEADLESS=false) rather than
   * something a developer can accidentally commit. Never branched on
   * process.platform: the code is identical in both places, only the env differs.
   */
  headless: z.boolean(),
  slowMoMs: z.number().int().min(0),
  navigationTimeoutMs: z.number().int().min(1_000),
  actionTimeoutMs: z.number().int().min(500),
  viewport: z.strictObject({
    width: z.number().int().min(320),
    height: z.number().int().min(240),
  }),
  locale: z.string().min(2),
  timezoneId: z.string().min(3),
  /**
   * Chromium's sandbox is a real security boundary. The provided image runs as
   * the non-root `pwuser`, so this should stay false. Turn it on only if you are
   * forced to run as root in a container you do not control, and understand that
   * a compromised page then has the container's privileges.
   */
  noSandbox: z.boolean(),
  args: z.array(z.string()),
  /** Playwright traces for failed attempts. Cheap, and the only real forensics you get from an unattended run. */
  tracing: z.boolean(),
  /**
   * Record the whole session to video, into the run's artifacts directory.
   *
   * Off by default and deliberately not a per-failure thing like `tracing`: a
   * video covers the ENTIRE run, which is what makes it useful for showing a
   * long process end to end - and also what makes it unsuitable for unattended
   * production, where it would record every carrier portal a robot touches.
   * Enable it per run with `RECORD_VIDEO=true`.
   */
  recordVideo: z.boolean(),
});
export type BrowserConfig = z.infer<typeof browserConfigSchema>;

/**
 * Which queue backend this environment talks to.
 *
 * The queue *name* lives in each automation's automation.json; the *provider*
 * lives here, in environment config. That split is what lets the same
 * automation run against the local JSON queue in dev and against Orchestrator
 * in production without a line of automation code changing.
 */
export const queueConfigSchema = z.strictObject({
  provider: z.enum(['local', 'orchestrator']),

  /**
   * Only meaningful when provider is 'orchestrator'.
   *
   *   robot - StartTransaction / SetTransactionResult, the REFramework path.
   *           Orchestrator owns locking and Auto-Retry. Needs a robot identity.
   *   odata - plain OData reads for external applications with no robot
   *           identity. Cannot claim an item atomically, so it is
   *           SINGLE-WORKER ONLY. See docs/orchestrator.md.
   */
  mode: z.enum(['robot', 'odata']),

  /** NAME of the env var holding the unattended robot key. Required for 'robot'. */
  robotIdentifierEnv: z.string().min(1).optional(),

  /**
   * Orchestrator's SpecificContent is a Dictionary(Of String, Object) that only
   * really wants primitives, so nested objects and arrays are JSON-encoded with
   * a __jsonFields companion key. See orchestrator/specificContent.ts.
   */
  specificContentEncoding: z.enum(['json-encoded']),
});
export type QueueConfig = z.infer<typeof queueConfigSchema>;

/**
 * Orchestrator connection settings. Contains NO secrets: client id and secret
 * are referenced by environment-variable name and resolved through
 * ctx.secrets at runtime.
 */
export const orchestratorConfigSchema = z.strictObject({
  /** https://cloud.uipath.com (cloud) or https://orchestrator.internal (standalone). */
  baseUrl: z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL'),
  /** Identity host, when it differs from baseUrl. Defaults to baseUrl. */
  identityUrl: z.string().regex(/^https?:\/\/\S+$/).optional(),

  /**
   * Cloud only. When both are present the API root is
   * {baseUrl}/{organization}/{tenant}/orchestrator_/odata; when absent it is
   * the standalone shape, {baseUrl}/odata.
   */
  organization: z.string().min(1).optional(),
  tenant: z.string().min(1).optional(),

  /** Folder scoping. One of these is required. folderId maps to X-UIPATH-OrganizationUnitId. */
  folderId: z.number().int().positive().optional(),
  folderPath: z.string().min(1).optional(),

  scopes: z.array(z.string().min(1)).min(1),

  /** NAMES of the credential env vars, never the values. */
  clientIdEnv: z.string().min(1),
  clientSecretEnv: z.string().min(1),

  requestTimeoutMs: z.number().int().min(1_000),
  /** HTTP-level retries for 429/5xx/network only. Not transaction retries. */
  maxRetries: z.number().int().min(0).max(10),
  /**
   * Re-authenticate this long before the token's stated expiry. Client
   * credentials issues no refresh token, so "renewal" is a fresh token request.
   */
  tokenRefreshSkewMs: z.number().int().min(0),
});
export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;

/**
 * Gmail API credentials for GmailApiMfaProvider. Contains NO secrets: the
 * client id, client secret and refresh token are referenced by
 * environment-variable name and resolved through ctx.secrets at runtime.
 */
export const gmailApiConfigSchema = z.strictObject({
  /** NAMES of the credential env vars, never the values. */
  clientIdEnv: z.string().min(1),
  clientSecretEnv: z.string().min(1),
  refreshTokenEnv: z.string().min(1),

  requestTimeoutMs: z.number().int().min(1_000),
  /** HTTP-level retries for 429/5xx/network only. Not transaction retries. */
  maxRetries: z.number().int().min(0).max(10),
  /**
   * Re-request an access token this long before its stated expiry. The refresh
   * token itself is long-lived; this only covers clock skew on the access token.
   */
  tokenRefreshSkewMs: z.number().int().min(0),
});
export type GmailApiConfig = z.infer<typeof gmailApiConfigSchema>;

/**
 * How an automation obtains an MFA code.
 *
 * This is the seam the two carrier PoCs were designed around: the provider is
 * environment configuration, exactly like queue.provider, so the same
 * automation prompts a developer on a terminal in dev and reads a Gmail label
 * unattended in production without a line of automation code changing.
 */
export const mfaConfigSchema = z.strictObject({
  /**
   *   manual        - prompts on stdin. Requires a TTY, so it fails fast in an
   *                   unattended run rather than hanging forever.
   *   gmail-cdp     - attaches over the DevTools protocol to a Chrome that is
   *                   already signed in. Note Chrome 136+ refuses to debug the
   *                   DEFAULT profile, so this cannot reuse an everyday
   *                   browser session - only a dedicated --user-data-dir. That
   *                   makes it near-equivalent to gmail-profile; prefer that
   *                   unless such a browser is already running.
   *   gmail-profile - a dedicated persistent profile signed in once by a human.
   *                   A bridge with a shelf life; the session expires.
   *   gmail-api     - Gmail REST API with a refresh token. The production
   *                   target: headless-safe and the only one that does not
   *                   depend on Gmail's markup.
   */
  provider: z.enum(['manual', 'gmail-cdp', 'gmail-profile', 'gmail-api']),

  /**
   * Where `gmail-cdp` looks for Chrome's DevTools endpoint.
   *
   * Loopback only, and not negotiable: a DevTools port is full control of the
   * browser and its signed-in sessions, so exposing it off-host would hand over
   * the mailbox.
   */
  cdpEndpoint: z.string().regex(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'must be a loopback http URL'),

  /**
   * Profile directory for 'gmail-profile', relative to the repo root.
   *
   * CREDENTIAL-EQUIVALENT: it holds a live Google session. Gitignored, and
   * never copied off the machine. Seeded by `rpa mfa seed-profile`.
   */
  profileDir: z.string().min(1),

  /** How often to re-check the label while waiting. */
  pollIntervalMs: z.number().int().min(1_000),

  gmail: gmailApiConfigSchema,
});
export type MfaConfig = z.infer<typeof mfaConfigSchema>;

const platformConfigObjectSchema = z.strictObject({
  logLevel: logLevelSchema,
  logPretty: z.boolean(),

  artifactsDir: z.string().min(1),
  dataDir: z.string().min(1),
  keepArtifactsOnSuccess: z.boolean(),

  /** REFramework's MaxRetryNumber. Applies to System exceptions only. */
  maxRetries: z.number().int().min(0).max(10),
  retryBackoffMs: z.number().int().min(0),
  retryBackoffFactor: z.number().min(1),
  retryBackoffMaxMs: z.number().int().min(0),

  /**
   * Circuit breaker. If this many transactions fail with System exceptions
   * back to back, the target system is down and the remaining queue would just
   * be converted into failures. Stop instead, and let the queue be re-run.
   */
  maxConsecutiveSystemExceptions: z.number().int().min(1),
  transactionTimeoutMs: z.number().int().min(1_000),

  browser: browserConfigSchema,

  /** Where MFA codes come from. See mfaConfigSchema. */
  mfa: mfaConfigSchema,

  queue: queueConfigSchema,
  /** Required when queue.provider is 'orchestrator'; absent otherwise. */
  orchestrator: orchestratorConfigSchema.optional(),
});

/**
 * Cross-field rules. These exist because the individually-valid combinations
 * that are jointly wrong are the ones that cause real damage in production.
 */
export const platformConfigSchema = platformConfigObjectSchema.superRefine((config, ctx) => {
  if (config.queue.provider !== 'orchestrator') return;

  if (config.orchestrator === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['orchestrator'],
      message: 'queue.provider is "orchestrator" but no orchestrator config block was supplied',
    });
    return;
  }

  if (config.orchestrator.folderId === undefined && config.orchestrator.folderPath === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['orchestrator', 'folderId'],
      message: 'one of orchestrator.folderId or orchestrator.folderPath is required for folder scoping',
    });
  }

  if (config.queue.mode === 'robot') {
    if (config.queue.robotIdentifierEnv === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['queue', 'robotIdentifierEnv'],
        message: 'queue.mode "robot" requires queue.robotIdentifierEnv (the NAME of the env var holding the robot key)',
      });
    }

    /**
     * The double-retry guard.
     *
     * In robot mode a System exception is reported as an ApplicationException
     * and ORCHESTRATOR owns the retry. If the runner also retried, the two
     * multiply: 3 local attempts x 3 Orchestrator retries is 9 real
     * submissions to a carrier. UiPath's own guidance for REFramework against
     * an Auto-Retry queue is MaxRetryNumber = 0; this makes that a hard error
     * instead of something you are expected to remember.
     */
    if (config.maxRetries > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxRetries'],
        message:
          `maxRetries is ${config.maxRetries} but queue.mode is "robot", where Orchestrator owns retries. ` +
          'Local and Orchestrator retries multiply. Set maxRetries to 0, or use queue.mode "odata".',
      });
    }
  }
});

export type PlatformConfig = z.infer<typeof platformConfigObjectSchema>;

/**
 * Layer 1 of 5. Declared as a plain typed constant rather than via Zod
 * `.default()` on purpose: Zod 3 and Zod 4 disagree about whether `.default()`
 * takes the input or the output type, and a config loader that breaks on a
 * dependency bump would break all 100+ automations at once.
 */
export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  logLevel: 'info',
  logPretty: false,

  artifactsDir: 'artifacts',
  dataDir: 'data',
  keepArtifactsOnSuccess: false,

  maxRetries: 2,
  retryBackoffMs: 1_500,
  retryBackoffFactor: 2,
  retryBackoffMaxMs: 30_000,

  maxConsecutiveSystemExceptions: 5,
  transactionTimeoutMs: 120_000,

  browser: {
    headless: true,
    slowMoMs: 0,
    navigationTimeoutMs: 30_000,
    actionTimeoutMs: 15_000,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Denver',
    noSandbox: false,
    args: [],
    tracing: true,
    recordVideo: false,
  },

  /**
   * Manual by default, deliberately. A misconfigured environment then stops
   * and asks a human instead of silently reaching into a mailbox, and the
   * Gmail providers have to be opted into per environment.
   */
  mfa: {
    provider: 'manual',
    cdpEndpoint: 'http://127.0.0.1:9222',
    profileDir: 'data/profiles/gmail-mfa',
    pollIntervalMs: 5_000,
    gmail: {
      clientIdEnv: 'GMAIL_CLIENT_ID',
      clientSecretEnv: 'GMAIL_CLIENT_SECRET',
      refreshTokenEnv: 'GMAIL_REFRESH_TOKEN',
      requestTimeoutMs: 30_000,
      maxRetries: 3,
      tokenRefreshSkewMs: 60_000,
    },
  },

  /**
   * Local by default. An environment opts in to Orchestrator explicitly, so a
   * misconfigured run fails closed against a local JSON file rather than
   * open against a production queue.
   */
  queue: {
    provider: 'local',
    mode: 'robot',
    specificContentEncoding: 'json-encoded',
  },
};

/** The fully resolved configuration handed to an automation. */
export interface ResolvedConfig<TAutomation> extends PlatformConfig {
  readonly env: string;
  /** This automation's own settings, validated by its own schema. */
  readonly automation: TAutomation;
  /** Which layers actually contributed, in order. Logged at startup. */
  readonly sources: readonly string[];
}
