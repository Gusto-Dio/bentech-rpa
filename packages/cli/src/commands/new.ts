import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AUTOMATION_ID_PATTERN, SEGMENT_PATTERN, findRepoRoot } from '@rpa/core';
import { flagString, type ParsedArgs } from '../args.ts';
import { errorLine, line, style } from '../ui.ts';

/**
 * `rpa new` - the reason templates exist.
 *
 * Automation number 101 must be created by a generator, not by copying a
 * sibling and editing it. Copying is how manifests end up with the wrong id,
 * how a stale queue name gets shared between two automations, and how a
 * deprecated pattern outlives its deprecation.
 */
export async function newCommand(args: ParsedArgs): Promise<number> {
  const kind = args.positionals[1];

  if (kind === 'automation') return newAutomation(args);
  if (kind === 'domain') return newDomain(args);

  errorLine('Usage:');
  errorLine('  rpa new automation --id <domain>/<name> [--title "..."] --owner @team [--kind browser|api]');
  errorLine('  rpa new domain     --name <domain> --owner @team');
  return 2;
}

async function newAutomation(args: ParsedArgs): Promise<number> {
  const repoRoot = findRepoRoot();

  const id = flagString(args, 'id');
  const owner = flagString(args, 'owner');
  const kind = flagString(args, 'kind') ?? 'browser';

  if (id === undefined || owner === undefined) {
    errorLine('Both --id <domain>/<name> and --owner <@team> are required.');
    return 2;
  }
  if (!AUTOMATION_ID_PATTERN.test(id)) {
    errorLine(`--id "${id}" must be "<domain>/<name>" in kebab-case, e.g. group-submission/carrier-sync`);
    return 2;
  }
  if (kind !== 'browser' && kind !== 'api') {
    errorLine('--kind must be "browser" (drives a UI) or "api" (no browser).');
    return 2;
  }

  const [domain, slug] = id.split('/') as [string, string];
  const domainDir = path.join(repoRoot, 'automations', domain);
  if (!existsSync(domainDir)) {
    errorLine(`Domain "${domain}" does not exist yet. Create it first:`);
    errorLine(`  pnpm rpa new domain --name ${domain} --owner ${owner}`);
    return 2;
  }

  const target = path.join(domainDir, slug);
  if (existsSync(target)) {
    errorLine(`${path.relative(repoRoot, target)} already exists.`);
    return 2;
  }

  const templateDir = path.join(repoRoot, 'templates', kind === 'browser' ? 'automation-browser' : 'automation-api');
  const title = flagString(args, 'title') ?? titleCase(slug);

  const tokens: Record<string, string> = {
    __AUTOMATION_ID__: id,
    __AUTOMATION_SLUG__: slug,
    __AUTOMATION_NAME__: title,
    __DOMAIN__: domain,
    __DOMAIN_TITLE__: titleCase(domain),
    __DOMAIN_SHARED_PKG__: `@auto/${domain}-shared`,
    __PKG_NAME__: `@auto/${domain}-${slug}`,
    __QUEUE_NAME__: `${domain}.${slug}`,
    __OWNER__: owner,
    __CRITICALITY__: flagString(args, 'criticality') ?? 'medium',
    __DESCRIPTION__: flagString(args, 'description') ?? `${title} (${domain})`,
  };

  const written = await copyTemplate(templateDir, target, tokens);

  line(style.green(`Created ${path.relative(repoRoot, target)} (${written} files)`));
  line();
  line('Next steps:');
  line(`  1. pnpm install                 ${style.dim('# link the new workspace package')}`);
  line(`  2. pnpm rpa validate            ${style.dim('# manifest + boundaries + config')}`);
  line(`  3. pnpm rpa run ${id}`);
  return 0;
}

async function newDomain(args: ParsedArgs): Promise<number> {
  const repoRoot = findRepoRoot();
  const name = flagString(args, 'name');
  const owner = flagString(args, 'owner');

  if (name === undefined || owner === undefined) {
    errorLine('Both --name <domain> and --owner <@team> are required.');
    return 2;
  }
  if (!SEGMENT_PATTERN.test(name)) {
    errorLine(`--name "${name}" must be kebab-case, e.g. member-submission`);
    return 2;
  }

  const target = path.join(repoRoot, 'automations', name);
  if (existsSync(target)) {
    errorLine(`${path.relative(repoRoot, target)} already exists.`);
    return 2;
  }

  const written = await copyTemplate(path.join(repoRoot, 'templates', 'domain'), target, {
    __DOMAIN__: name,
    __DOMAIN_TITLE__: titleCase(name),
    __DOMAIN_SHARED_PKG__: `@auto/${name}-shared`,
    __OWNER__: owner,
  });

  line(style.green(`Created ${path.relative(repoRoot, target)} (${written} files)`));
  line();
  line('Next steps:');
  line(`  1. Add to CODEOWNERS:  /automations/${name}/  ${owner}`);
  line(`  2. pnpm install`);
  line(`  3. pnpm rpa new automation --id ${name}/<name> --owner ${owner}`);
  return 0;
}

/** Substitutes tokens in file contents. Filenames are literal - no templated paths to reason about. */
async function copyTemplate(
  templateDir: string,
  targetDir: string,
  tokens: Readonly<Record<string, string>>,
): Promise<number> {
  if (!existsSync(templateDir)) {
    throw new Error(`Template not found: ${templateDir}`);
  }

  let count = 0;
  const entries = await readdir(templateDir, { withFileTypes: true });
  await mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const from = path.join(templateDir, entry.name);
    const to = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      count += await copyTemplate(from, to, tokens);
      continue;
    }

    const source = await readFile(from, 'utf8');
    await writeFile(to, applyTokens(source, tokens), 'utf8');
    count += 1;
  }

  return count;
}

function applyTokens(source: string, tokens: Readonly<Record<string, string>>): string {
  let out = source;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(value);
  }
  return out;
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join(' ');
}
