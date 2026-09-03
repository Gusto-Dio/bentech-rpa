import {
  BucketClient,
  EnvSecretProvider,
  OrchestratorClient,
  SecretResolver,
  createLogger,
  discoverAutomations,
  findAutomation,
  findRepoRoot,
  loadConfig,
} from '@rpa/core';
import { flagString, resolveEnv, type ParsedArgs } from '../args.ts';
import { errorLine, heading, line, style } from '../ui.ts';

/**
 * `rpa orchestrator check` - the first thing to run against a sandbox.
 *
 * Every `TODO(orchestrator):` marker in the codebase is a behaviour that varies
 * by Orchestrator version. This command settles them in one pass: it
 * authenticates, reports what scopes were actually granted, proves folder
 * access, resolves a queue by name, and reports whether a robot identity is
 * present - which is what decides between robot and odata mode.
 */

type Level = 'pass' | 'warn' | 'fail';

interface Check {
  name: string;
  level: Level;
  detail: string;
}

export async function orchestratorCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1] ?? 'check';
  if (sub !== 'check') {
    errorLine('Usage: rpa orchestrator check [--automation <domain>/<name>] [--env dev] [--bucket <name>]');
    return 2;
  }

  const repoRoot = findRepoRoot();
  const env = resolveEnv(args);
  const automationId = flagString(args, 'automation');

  // Layer 4 is optional, so a repo-root automationDir simply contributes nothing.
  const automationDir =
    automationId === undefined ? repoRoot : (await findAutomation(repoRoot, automationId)).dir;

  const config = await loadConfig({ repoRoot, automationDir, env });
  const checks: Check[] = [];

  heading('rpa orchestrator check');
  line(`  APP_ENV        : ${env}`);
  line(`  queue.provider : ${config.queue.provider}`);
  line(`  queue.mode     : ${config.queue.mode}`);

  if (config.orchestrator === undefined) {
    line();
    errorLine(
      style.red(
        `No orchestrator config block for APP_ENV="${env}". ` +
          'Add one to config/environments/' + env + '.json (see README).',
      ),
    );
    return 1;
  }

  const logger = createLogger({ level: 'warn', pretty: false, base: {} });
  const secrets = new SecretResolver(new EnvSecretProvider());
  const client = new OrchestratorClient({ config: config.orchestrator, secrets, logger });

  line(`  api root       : ${client.apiRoot}`);
  line(`  token url      : ${client.tokenUrl}`);
  line(
    `  folder         : ${
      config.orchestrator.folderId !== undefined
        ? `X-UIPATH-OrganizationUnitId ${config.orchestrator.folderId}`
        : `X-UIPATH-FolderPath-Encoded ${config.orchestrator.folderPath ?? '(none)'}`
    }`,
  );

  // ── Credentials present? ──
  const clientIdSet = (await secrets.optional(config.orchestrator.clientIdEnv)) !== undefined;
  const clientSecretSet = (await secrets.optional(config.orchestrator.clientSecretEnv)) !== undefined;
  checks.push({
    name: 'credentials',
    level: clientIdSet && clientSecretSet ? 'pass' : 'fail',
    detail:
      clientIdSet && clientSecretSet
        ? `${config.orchestrator.clientIdEnv} and ${config.orchestrator.clientSecretEnv} are set`
        : `missing ${[
            clientIdSet ? undefined : config.orchestrator.clientIdEnv,
            clientSecretSet ? undefined : config.orchestrator.clientSecretEnv,
          ]
            .filter(Boolean)
            .join(', ')}`,
  });

  if (!clientIdSet || !clientSecretSet) {
    report(checks);
    return 1;
  }

  // ── Authenticate ──
  try {
    const token = await client.tokenInfo();
    checks.push({
      name: 'authenticate',
      level: 'pass',
      detail: `token valid for ${Math.round(token.expiresInMs / 1000)}s`,
    });

    const requested = new Set(config.orchestrator.scopes);
    const granted = new Set(token.grantedScopes);
    const missing = [...requested].filter((scope) => !granted.has(scope));
    checks.push({
      name: 'scopes',
      level: missing.length === 0 ? 'pass' : 'warn',
      detail:
        missing.length === 0
          ? [...granted].join(' ')
          : `granted: ${[...granted].join(' ')} | NOT granted: ${missing.join(' ')}`,
    });
  } catch (thrown) {
    checks.push({ name: 'authenticate', level: 'fail', detail: message(thrown) });
    report(checks);
    return 1;
  }

  // ── Folder access ──
  try {
    const folders = await client.odataGet<{ value?: unknown[] }>('/QueueDefinitions', { $top: 1 });
    checks.push({
      name: 'folder access',
      level: 'pass',
      detail: `QueueDefinitions readable (${(folders.value ?? []).length} sampled)`,
    });
  } catch (thrown) {
    checks.push({
      name: 'folder access',
      level: 'fail',
      detail: `${message(thrown)} - check folderId and the OR.Queues scope`,
    });
  }

  // ── Robot identity: decides robot vs odata mode ──
  const robotEnv = config.queue.robotIdentifierEnv;
  const robotIdentifier = robotEnv === undefined ? undefined : await secrets.optional(robotEnv);
  checks.push({
    name: 'robot identity',
    level: robotIdentifier !== undefined ? 'pass' : config.queue.mode === 'robot' ? 'fail' : 'warn',
    detail:
      robotIdentifier !== undefined
        ? `${robotEnv ?? '(unset)'} is set - "robot" mode is available`
        : config.queue.mode === 'robot'
          ? `queue.mode is "robot" but ${robotEnv ?? 'queue.robotIdentifierEnv'} is not set`
          : 'no robot identity; "odata" mode only (single-worker, no atomic claim)',
  });

  // ── Queue resolution, when an automation was named ──
  if (automationId !== undefined) {
    const { manifest } = await findAutomation(repoRoot, automationId);
    try {
      const escaped = manifest.queue.name.replace(/'/g, "''");
      const page = await client.odataGet<{ value?: Array<{ Id: number; Name: string }> }>(
        '/QueueDefinitions',
        { $filter: `Name eq '${escaped}'`, $top: 1 },
      );
      const definition = (page.value ?? [])[0];
      checks.push({
        name: 'queue',
        level: definition === undefined ? 'fail' : 'pass',
        detail:
          definition === undefined
            ? `"${manifest.queue.name}" not found in this folder`
            : `"${definition.Name}" resolved to Id ${definition.Id}`,
      });
    } catch (thrown) {
      checks.push({ name: 'queue', level: 'fail', detail: message(thrown) });
    }
  } else {
    const { automations } = await discoverAutomations(repoRoot);
    checks.push({
      name: 'queue',
      level: 'warn',
      detail: `not checked. Re-run with --automation <${automations[0]?.manifest.id ?? 'domain/name'}>`,
    });
  }

  // ── Buckets, only when asked: needs OR.Administration ──
  const bucket = flagString(args, 'bucket');
  if (bucket !== undefined) {
    try {
      const id = await new BucketClient({ client, logger }).resolveBucketId(bucket);
      checks.push({ name: 'bucket', level: 'pass', detail: `"${bucket}" resolved to Id ${id}` });
    } catch (thrown) {
      checks.push({
        name: 'bucket',
        level: 'fail',
        detail: `${message(thrown)} - writes need the OR.Administration scope`,
      });
    }
  }

  report(checks);
  await client.close();
  return checks.some((check) => check.level === 'fail') ? 1 : 0;
}

function report(checks: readonly Check[]): void {
  heading('Results');
  for (const check of checks) {
    const mark =
      check.level === 'pass'
        ? style.green('ok  ')
        : check.level === 'warn'
          ? style.yellow('warn')
          : style.red('fail');
    line(`  ${mark}  ${check.name.padEnd(16)} ${check.detail}`);
  }

  const failed = checks.filter((check) => check.level === 'fail').length;
  line();
  line(
    failed > 0
      ? style.red(`${failed} check(s) failed.`)
      : style.green('Orchestrator is reachable and correctly scoped.'),
  );
  line(style.dim('Next: grep -rn "TODO(orchestrator)" to see what else to confirm against this tenant.'));
}

function message(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message.split('\n')[0] ?? thrown.message : String(thrown);
}
