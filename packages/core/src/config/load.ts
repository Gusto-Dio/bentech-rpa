import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import { SystemException } from '../errors.ts';
import {
  DEFAULT_PLATFORM_CONFIG,
  platformConfigSchema,
  type PlatformConfig,
  type ResolvedConfig,
} from './schema.ts';

/**
 * Resolution order, lowest precedence first:
 *
 *   1. DEFAULT_PLATFORM_CONFIG            (code)
 *   2. config/platform.json               (platform-wide)
 *   3. config/environments/<APP_ENV>.json (per environment)
 *   4. <automation>/config/config.<APP_ENV>.json
 *   5. environment variables              (per run / per container)
 *
 * Layer 5 exists so the same image runs in every environment with nothing but
 * env differences, which is what makes the Mac-to-Ubuntu promise hold.
 */
export interface LoadConfigOptions<TAutomation> {
  repoRoot: string;
  automationDir: string;
  env: string;
  automationSchema?: ZodType<TAutomation> | undefined;
  processEnv?: NodeJS.ProcessEnv;
}

/** Env vars that override config, and what they map onto. Documented in .env.example. */
export const ENV_OVERRIDES: Readonly<Record<string, string>> = {
  LOG_LEVEL: 'logLevel',
  LOG_PRETTY: 'logPretty',
  ARTIFACTS_DIR: 'artifactsDir',
  DATA_DIR: 'dataDir',
  MAX_RETRIES: 'maxRetries',
  TRANSACTION_TIMEOUT_MS: 'transactionTimeoutMs',
  QUEUE_PROVIDER: 'queue.provider',
  QUEUE_MODE: 'queue.mode',
  HEADLESS: 'browser.headless',
  SLOW_MO_MS: 'browser.slowMoMs',
  CHROMIUM_NO_SANDBOX: 'browser.noSandbox',
  RECORD_VIDEO: 'browser.recordVideo',
};

export async function loadConfig<TAutomation = Record<string, unknown>>(
  options: LoadConfigOptions<TAutomation>,
): Promise<ResolvedConfig<TAutomation>> {
  const processEnv = options.processEnv ?? process.env;
  const sources: string[] = ['defaults'];

  let merged: Record<string, unknown> = structuredClone(
    DEFAULT_PLATFORM_CONFIG,
  ) as unknown as Record<string, unknown>;

  const platformFile = path.join(options.repoRoot, 'config', 'platform.json');
  merged = deepMerge(merged, await readJsonObject(platformFile, { required: true }));
  sources.push(path.relative(options.repoRoot, platformFile));

  const envFile = path.join(options.repoRoot, 'config', 'environments', `${options.env}.json`);
  const envLayer = await readJsonObject(envFile, { required: true });
  merged = deepMerge(merged, envLayer);
  sources.push(path.relative(options.repoRoot, envFile));

  const automationFile = path.join(options.automationDir, 'config', `config.${options.env}.json`);
  const automationLayer = await readJsonObject(automationFile, { required: false });
  if (automationLayer !== undefined) {
    merged = deepMerge(merged, automationLayer);
    sources.push(path.relative(options.repoRoot, automationFile));
  }

  const envPatch = buildEnvPatch(processEnv);
  if (Object.keys(envPatch).length > 0) {
    merged = deepMerge(merged, envPatch);
    sources.push('env');
  }

  const { automation: automationRaw, ...platformRaw } = merged;

  const platformResult = platformConfigSchema.safeParse(platformRaw);
  if (!platformResult.success) {
    throw new SystemException(
      `Invalid platform configuration for APP_ENV="${options.env}":\n${formatIssues(platformResult.error)}`,
      { details: { sources } },
    );
  }
  const platform: PlatformConfig = platformResult.data;

  const automation = validateAutomationConfig(
    automationRaw,
    options.automationSchema,
    options.env,
    sources,
  );

  return { ...platform, env: options.env, automation, sources };
}

function validateAutomationConfig<TAutomation>(
  raw: unknown,
  schema: ZodType<TAutomation> | undefined,
  env: string,
  sources: readonly string[],
): TAutomation {
  if (schema === undefined) {
    // No schema declared: pass the subtree through untouched. Automations get
    // validation - and typed access - by declaring `configSchema`.
    return (raw ?? {}) as TAutomation;
  }

  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    throw new SystemException(
      `Invalid automation configuration ("automation" key) for APP_ENV="${env}":\n${formatIssues(result.error)}`,
      { details: { sources } },
    );
  }
  return result.data;
}

/**
 * Zod 3 types issue paths as (string|number)[] and Zod 4 as PropertyKey[], and
 * the pretty-printing helpers were renamed between majors. Reading `.issues`
 * through this minimal shape is the one formulation that survives both.
 */
interface MinimalIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

function formatIssues(error: { issues: readonly unknown[] }): string {
  const issues = error.issues as readonly MinimalIssue[];
  return issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>';
      return `  - ${at}: ${issue.message}`;
    })
    .join('\n');
}

async function readJsonObject(
  file: string,
  options: { required: boolean },
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if (options.required) {
      throw new SystemException(`Required config file is missing: ${file}`, { cause });
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SystemException(`Config file is not valid JSON: ${file}`, { cause });
  }

  if (!isPlainObject(parsed)) {
    throw new SystemException(`Config file must contain a JSON object: ${file}`);
  }

  return stripAnnotations(parsed);
}

/**
 * Drops "$comment"-style keys so the JSON layers can document themselves while
 * the schemas stay strict. Strict validation is what turns a misspelled setting
 * into a startup error instead of a silently ignored line.
 */
function stripAnnotations(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) continue;
    out[key] = isPlainObject(child) ? stripAnnotations(child) : child;
  }
  return out;
}

function buildEnvPatch(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const [envName, configPath] of Object.entries(ENV_OVERRIDES)) {
    const raw = env[envName];
    if (raw === undefined || raw === '') continue;
    setPath(patch, configPath.split('.'), coerceEnvValue(envName, configPath, raw));
  }

  return patch;
}

function coerceEnvValue(envName: string, configPath: string, raw: string): unknown {
  const leaf = configPath.slice(configPath.lastIndexOf('.') + 1);

  if (BOOLEAN_KEYS.has(leaf)) return parseBoolean(envName, raw);
  if (NUMBER_KEYS.has(leaf)) return parseInteger(envName, raw);
  return raw;
}

const BOOLEAN_KEYS = new Set([
  'logPretty',
  'headless',
  'noSandbox',
  'keepArtifactsOnSuccess',
  'recordVideo',
]);
const NUMBER_KEYS = new Set(['maxRetries', 'transactionTimeoutMs', 'slowMoMs']);

function parseBoolean(envName: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new SystemException(
    `Environment variable ${envName} must be a boolean ("true" or "false"), received "${raw}"`,
  );
}

function parseInteger(envName: string, raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) {
    throw new SystemException(
      `Environment variable ${envName} must be an integer, received "${raw}"`,
    );
  }
  return value;
}

function setPath(target: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i] as string;
    const next = cursor[key];
    if (!isPlainObject(next)) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  cursor[segments[segments.length - 1] as string] = value;
}

/** Arrays replace rather than concatenate - otherwise browser.args could never be narrowed by a layer. */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = out[key];
    out[key] =
      isPlainObject(baseValue) && isPlainObject(patchValue)
        ? deepMerge(baseValue, patchValue)
        : patchValue;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
