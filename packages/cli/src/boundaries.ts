import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Import-boundary enforcement.
 *
 * At ~30 automations an unenforced dependency graph becomes a ball of mud:
 * someone imports a helper from a neighbouring automation, that automation gets
 * rewritten, and two teams are now coupled through a file neither of them
 * considers public. The rules are therefore mechanical:
 *
 *   automations/<domain>/<name>/src  may import  @rpa/core, its OWN
 *                                    @auto/<domain>-shared, node:*, zod,
 *                                    playwright, and relative paths inside
 *                                    itself.
 *   automations/<domain>/_shared/src may import  @rpa/core, node:*, zod,
 *                                    playwright, and itself.
 *   packages/**                      may NOT import any automation.
 *
 * Deep imports into @rpa/core internals are rejected too, so the platform team
 * can restructure core without a 100-automation migration.
 *
 * This is a source scan, not a full parse. It reads static import/export/from
 * specifiers and dynamic import("...") literals, which covers every real case;
 * a computed specifier would slip through, and that is an acceptable trade for
 * having zero dependencies and running in milliseconds.
 */

export interface BoundaryViolation {
  file: string;
  specifier: string;
  reason: string;
}

/**
 * playwright and zod are needed for types and schemas; exceljs is needed by the
 * census transforms (pure JS, no native build, so it survives the
 * arm64 -> amd64 hop); @rpa/testkit only ever appears in *.test.ts files and is
 * a devDependency, so it never reaches the runtime image.
 */
const ALWAYS_ALLOWED = new Set(['zod', 'playwright', '@rpa/testkit', 'exceljs']);

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export async function checkBoundaries(repoRoot: string): Promise<BoundaryViolation[]> {
  const violations: BoundaryViolation[] = [];
  const automationsRoot = path.join(repoRoot, 'automations');

  for (const domain of await listDirs(automationsRoot)) {
    if (domain.startsWith('.')) continue;
    const domainDir = path.join(automationsRoot, domain);

    for (const entry of await listDirs(domainDir)) {
      if (entry.startsWith('.')) continue;
      const entryDir = path.join(domainDir, entry);
      const isShared = entry.startsWith('_');

      const allowedBare = new Set<string>(['@rpa/core', ...ALWAYS_ALLOWED]);
      if (!isShared) allowedBare.add(`@auto/${domain}-shared`);

      for (const file of await listTypeScriptFiles(entryDir)) {
        for (const specifier of extractSpecifiers(await readText(file))) {
          const violation = judge({
            specifier,
            file,
            repoRoot,
            allowedBare,
            selfRoot: entryDir,
            domain,
            isShared,
          });
          if (violation !== undefined) violations.push(violation);
        }
      }
    }
  }

  // Core must never depend on an automation: that would invert the whole
  // dependency direction and make the engine unshippable.
  for (const file of await listTypeScriptFiles(path.join(repoRoot, 'packages'))) {
    for (const specifier of extractSpecifiers(await readText(file))) {
      if (specifier.startsWith('@auto/') || specifier.includes('automations/')) {
        violations.push({
          file: path.relative(repoRoot, file),
          specifier,
          reason: 'packages/ must not import from automations/ - the core cannot depend on its consumers',
        });
      }
    }
  }

  return violations;
}

interface JudgeInput {
  specifier: string;
  file: string;
  repoRoot: string;
  allowedBare: ReadonlySet<string>;
  selfRoot: string;
  domain: string;
  isShared: boolean;
}

function judge(input: JudgeInput): BoundaryViolation | undefined {
  const { specifier } = input;
  const relFile = path.relative(input.repoRoot, input.file);

  if (specifier.startsWith('node:')) return undefined;

  if (specifier.startsWith('.')) {
    const resolved = path.resolve(path.dirname(input.file), specifier);
    if (isInside(input.selfRoot, resolved)) return undefined;
    return {
      file: relFile,
      specifier,
      reason: `relative import escapes ${path.relative(input.repoRoot, input.selfRoot)}; use a package import instead`,
    };
  }

  if (specifier.startsWith('@rpa/core/')) {
    return {
      file: relFile,
      specifier,
      reason: 'deep import into @rpa/core internals; import from "@rpa/core" only',
    };
  }

  if (input.allowedBare.has(specifier)) return undefined;

  if (specifier.startsWith('@auto/')) {
    return {
      file: relFile,
      specifier,
      reason: input.isShared
        ? 'a domain _shared package must not depend on another domain'
        : `cross-domain import; "${input.domain}" automations may only use @auto/${input.domain}-shared`,
    };
  }

  return {
    file: relFile,
    specifier,
    reason: `"${specifier}" is not on the allow-list for automations (@rpa/core, @auto/<own-domain>-shared, node:*, zod, playwright)`,
  };
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function extractSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    // Patterns carry /g, so lastIndex must be reset between files.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found];
}

async function readText(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8');
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTypeScriptFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
