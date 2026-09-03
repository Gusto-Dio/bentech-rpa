import { discoverAutomations, findRepoRoot, type DiscoveredAutomation } from '@rpa/core';
import { flagBool, flagString, type ParsedArgs } from '../args.ts';
import { errorLine, heading, line, pad, style } from '../ui.ts';

/** `rpa list` - the human view of the manifest registry. */
export async function listCommand(args: ParsedArgs): Promise<number> {
  const repoRoot = findRepoRoot();
  const { automations, failures } = await discoverAutomations(repoRoot);
  const domainFilter = flagString(args, 'domain');

  const visible =
    domainFilter === undefined
      ? automations
      : automations.filter((a) => a.manifest.domain === domainFilter);

  if (flagBool(args, 'json')) {
    line(JSON.stringify({ automations: visible.map((a) => a.manifest), failures }, null, 2));
    return failures.length > 0 ? 1 : 0;
  }

  if (visible.length === 0) {
    line(
      domainFilter === undefined
        ? 'No automations found under automations/.'
        : `No automations found in domain "${domainFilter}".`,
    );
  }

  const byDomain = new Map<string, DiscoveredAutomation[]>();
  for (const automation of visible) {
    const bucket = byDomain.get(automation.manifest.domain) ?? [];
    bucket.push(automation);
    byDomain.set(automation.manifest.domain, bucket);
  }

  for (const [domain, items] of [...byDomain].sort(([a], [b]) => a.localeCompare(b))) {
    heading(`${domain}  ${style.dim(`(${items.length})`)}`);
    for (const { manifest, issues } of items) {
      const name = manifest.id.slice(domain.length + 1);
      const badges = [
        manifest.sessionKind === 'browser' ? 'browser' : 'no-browser',
        manifest.criticality,
      ];
      if (manifest.schedule !== undefined) badges.push(manifest.schedule.cron);

      const errors = issues.filter((i) => i.level === 'error').length;
      const warnings = issues.filter((i) => i.level === 'warning').length;
      const health =
        errors > 0
          ? style.red(`  ${errors} manifest error(s)`)
          : warnings > 0
            ? style.yellow(`  ${warnings} warning(s)`)
            : '';

      line(`  ${pad(name, 38)} ${style.dim(badges.join(' | '))}${health}`);
      line(`  ${pad('', 38)} ${style.dim(`${manifest.name} - ${manifest.owners.join(', ')}`)}`);
    }
  }

  if (failures.length > 0) {
    heading('Unreadable manifests');
    for (const failure of failures) errorLine(`  ${style.red(failure.file)}: ${failure.message}`);
    return 1;
  }

  line();
  line(style.dim(`${visible.length} automation(s). Run one with: pnpm rpa run <id>`));
  return 0;
}
