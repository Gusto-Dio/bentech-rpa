import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnyAutomationDefinition } from './contracts/IAutomation.ts';
import { SystemException } from './errors.ts';
import {
  automationManifestSchema,
  checkManifestLocation,
  type AutomationManifest,
  type ManifestIssue,
} from './manifest.ts';
import { assertProbeSet, type ProbeSet } from './sentinel/probe.ts';

/**
 * Discovery is a filesystem walk over automation.json manifests, not a
 * generated registry file. At 100+ automations a committed, generated index
 * would be a permanent merge-conflict magnet - every new automation would touch
 * the same lines. A directory walk costs milliseconds and cannot conflict.
 */

export const AUTOMATIONS_DIR = 'automations';
export const MANIFEST_FILENAME = 'automation.json';
/** Folders starting with _ are shared code for a domain, not automations. */
const SHARED_PREFIX = '_';

export interface DiscoveredAutomation {
  manifest: AutomationManifest;
  /** Absolute path to the automation folder. */
  dir: string;
  /** Path relative to the repo root, e.g. automations/group-submission/foo. */
  relDir: string;
  manifestFile: string;
  /** Location cross-checks: id/domain must match the folder they live in. */
  issues: ManifestIssue[];
}

export interface DiscoveryFailure {
  file: string;
  message: string;
}

export interface DiscoveryResult {
  automations: DiscoveredAutomation[];
  /** Manifests that could not be read at all. Reported together so one bad file does not hide the rest. */
  failures: DiscoveryFailure[];
}

/**
 * Walks up looking for pnpm-workspace.yaml. Everything else resolves from this
 * one anchor, so no code needs an absolute path and the tree can be cloned
 * anywhere on either platform. RPA_REPO_ROOT overrides it for odd deployments.
 */
export function findRepoRoot(startDir: string = import.meta.dirname): string {
  const override = process.env['RPA_REPO_ROOT'];
  if (override !== undefined && override !== '') return path.resolve(override);

  let current = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new SystemException(
        'Could not locate the repository root (no pnpm-workspace.yaml found in any parent directory)',
      );
    }
    current = parent;
  }
}

export async function discoverAutomations(repoRoot: string): Promise<DiscoveryResult> {
  const automationsRoot = path.join(repoRoot, AUTOMATIONS_DIR);
  const automations: DiscoveredAutomation[] = [];
  const failures: DiscoveryFailure[] = [];

  const domains = await listDirectories(automationsRoot);

  for (const domain of domains) {
    if (domain.startsWith(SHARED_PREFIX) || domain.startsWith('.')) continue;

    const domainDir = path.join(automationsRoot, domain);
    for (const name of await listDirectories(domainDir)) {
      if (name.startsWith(SHARED_PREFIX) || name.startsWith('.')) continue;

      const dir = path.join(domainDir, name);
      const manifestFile = path.join(dir, MANIFEST_FILENAME);
      if (!existsSync(manifestFile)) continue;

      try {
        const manifest = await readManifest(manifestFile);
        automations.push({
          manifest,
          dir,
          relDir: path.join(AUTOMATIONS_DIR, domain, name),
          manifestFile,
          issues: checkManifestLocation(manifest, { domainDir: domain, automationDir: name }),
        });
      } catch (cause) {
        failures.push({
          file: path.relative(repoRoot, manifestFile),
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  automations.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return { automations, failures };
}

export async function findAutomation(repoRoot: string, id: string): Promise<DiscoveredAutomation> {
  const { automations } = await discoverAutomations(repoRoot);
  const found = automations.find((candidate) => candidate.manifest.id === id);
  if (found !== undefined) return found;

  const available = automations.map((candidate) => `  ${candidate.manifest.id}`).join('\n');
  throw new SystemException(
    `Unknown automation "${id}".\nAvailable automations:\n${available || '  (none found)'}`,
  );
}

async function readManifest(manifestFile: string): Promise<AutomationManifest> {
  const text = await readFile(manifestFile, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SystemException(`${MANIFEST_FILENAME} is not valid JSON`, { cause });
  }

  /**
   * Strip "$comment"-style keys before validating, exactly as the config loader
   * does. The schema stays strict - a typo like "nmae" is still rejected - but a
   * manifest can carry a note for the next reader without failing. Having the
   * two JSON families behave differently was just surprising.
   */
  const result = automationManifestSchema.safeParse(stripAnnotations(parsed));
  if (!result.success) {
    const issues = (result.error.issues as readonly { path: readonly PropertyKey[]; message: string }[])
      .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new SystemException(`${MANIFEST_FILENAME} is invalid - ${issues}`);
  }

  return result.data;
}

/**
 * Loads the automation's module and returns its default export.
 *
 * The cast is the one place in the codebase where the two context flavours
 * (plain and web) are unified. It is contained here on purpose: automations
 * themselves never cast, because defineAutomation / defineWebAutomation give
 * them precise types, and the runner guarantees a page exists whenever
 * sessionKind is "browser".
 */
export async function loadAutomationDefinition(
  automation: DiscoveredAutomation,
): Promise<AnyAutomationDefinition> {
  const entryFile = path.join(automation.dir, automation.manifest.entry);
  if (!existsSync(entryFile)) {
    throw new SystemException(
      `Automation "${automation.manifest.id}" declares entry "${automation.manifest.entry}" but ${entryFile} does not exist`,
    );
  }

  const imported: unknown = await import(pathToFileURL(entryFile).href);
  const candidate = (imported as { default?: unknown }).default;

  assertAutomationShape(candidate, automation.manifest.id);
  return candidate as AnyAutomationDefinition;
}

/**
 * Loads an automation's probe set, through the same seam as its definition.
 *
 * ── WHY THIS IS BOUNDARY-LEGAL ──────────────────────────────────────────────
 * `packages/` may not import `automations/` - `boundaries.ts` rejects any
 * literal specifier containing `automations/` or `@auto/`, because the engine
 * must not depend on its consumers. This does not violate that: the path is
 * COMPUTED at runtime from the manifest, exactly as `loadAutomationDefinition`
 * already computes the entry path. The dependency direction is unchanged - core
 * still knows nothing about any particular carrier, it just knows how to load
 * whatever a manifest points at.
 *
 * That seam is what lets probes live beside the automation they monitor, which
 * is what keeps this arrangement workable at a hundred automations owned by
 * five teams.
 */
export async function loadProbeSet(automation: DiscoveredAutomation): Promise<ProbeSet> {
  const declared = automation.manifest.sentinel?.probes;
  if (declared === undefined) {
    throw new SystemException(
      `Automation "${automation.manifest.id}" declares no sentinel probes. Add ` +
        '`"sentinel": { "probes": "src/sentinel/probes.ts" }` to its automation.json.',
    );
  }

  const entryFile = path.join(automation.dir, declared);
  if (!existsSync(entryFile)) {
    throw new SystemException(
      `Automation "${automation.manifest.id}" declares sentinel probes "${declared}" but ` +
        `${entryFile} does not exist`,
    );
  }

  const imported: unknown = await import(pathToFileURL(entryFile).href);
  const candidate = (imported as { default?: unknown }).default;

  assertProbeSet(candidate, `${automation.manifest.id} (${declared})`);
  return candidate;
}

const REQUIRED_METHODS = ['parsePayload', 'initialize', 'processTransaction', 'endProcess'] as const;

function assertAutomationShape(candidate: unknown, id: string): void {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new SystemException(
      `Automation "${id}" must default-export the result of defineAutomation()/defineWebAutomation()`,
    );
  }

  const record = candidate as Record<string, unknown>;
  const missing = REQUIRED_METHODS.filter((method) => typeof record[method] !== 'function');
  if (missing.length > 0) {
    throw new SystemException(
      `Automation "${id}" is missing required ${missing.length === 1 ? 'method' : 'methods'}: ${missing.join(', ')}`,
    );
  }
}

function stripAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (typeof value !== 'object' || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) continue;
    out[key] = stripAnnotations(child);
  }
  return out;
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
