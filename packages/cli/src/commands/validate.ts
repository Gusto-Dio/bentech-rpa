import {
  discoverAutomations,
  findRepoRoot,
  loadAutomationDefinition,
  loadConfig,
  type DiscoveredAutomation,
} from '@rpa/core';
import { resolveEnv, type ParsedArgs } from '../args.ts';
import { checkBoundaries } from '../boundaries.ts';
import { heading, line, style } from '../ui.ts';

/**
 * `rpa validate` - the pre-merge gate.
 *
 * Deliberately does more than a linter would: it loads every automation module
 * and resolves every automation's config, so "it imports cleanly and its
 * settings are complete" is proven in CI rather than discovered at 03:00 by the
 * scheduler.
 */
export async function validateCommand(args: ParsedArgs): Promise<number> {
  const repoRoot = findRepoRoot();
  const env = resolveEnv(args);
  const errors: string[] = [];
  const warnings: string[] = [];

  const { automations, failures } = await discoverAutomations(repoRoot);

  for (const failure of failures) {
    errors.push(`${failure.file}: ${failure.message}`);
  }

  // ── Manifest sanity, including location cross-checks ──
  for (const automation of automations) {
    for (const issue of automation.issues) {
      const message = `${automation.relDir}: ${issue.message}`;
      if (issue.level === 'error') errors.push(message);
      else warnings.push(message);
    }
  }

  // ── Uniqueness. Two automations sharing a queue would silently steal each other's work. ──
  errors.push(...findDuplicates(automations, (a) => a.manifest.id, 'id'));
  errors.push(...findDuplicates(automations, (a) => a.manifest.queue.name, 'queue.name'));

  // ── Import boundaries ──
  const violations = await checkBoundaries(repoRoot);
  for (const violation of violations) {
    errors.push(`${violation.file}: import "${violation.specifier}" - ${violation.reason}`);
  }

  // ── Loadability and config completeness ──
  for (const automation of automations) {
    try {
      const definition = await loadAutomationDefinition(automation);
      await loadConfig({
        repoRoot,
        automationDir: automation.dir,
        env,
        automationSchema: definition.configSchema,
      });
    } catch (thrown) {
      errors.push(
        `${automation.manifest.id}: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      );
    }
  }

  // ── Report ──
  heading('rpa validate');
  line(`  repo        : ${repoRoot}`);
  line(`  APP_ENV     : ${env}`);
  line(`  automations : ${automations.length}`);

  if (warnings.length > 0) {
    heading(`Warnings (${warnings.length})`);
    for (const warning of warnings) line(`  ${style.yellow('warn')}  ${warning}`);
  }

  if (errors.length > 0) {
    heading(`Errors (${errors.length})`);
    for (const error of errors) line(`  ${style.red('fail')}  ${error}`);
    line();
    line(style.red(`Validation failed with ${errors.length} error(s).`));
    return 1;
  }

  line();
  line(style.green('Validation passed.'));
  return 0;
}

function findDuplicates(
  automations: readonly DiscoveredAutomation[],
  select: (automation: DiscoveredAutomation) => string,
  label: string,
): string[] {
  const seen = new Map<string, string>();
  const errors: string[] = [];

  for (const automation of automations) {
    const key = select(automation);
    const previous = seen.get(key);
    if (previous !== undefined) {
      errors.push(`duplicate ${label} "${key}" in ${previous} and ${automation.relDir}`);
    } else {
      seen.set(key, automation.relDir);
    }
  }

  return errors;
}
