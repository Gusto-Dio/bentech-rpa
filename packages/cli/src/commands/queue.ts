import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LocalQueueProvider,
  createLogger,
  createQueueProvider,
  findAutomation,
  findRepoRoot,
  SecretResolver,
  loadConfig,
  readLocalQueueStats,
  type Priority,
  type QueueStats,
} from '@rpa/core';
import { flagBool, resolveEnv, type ParsedArgs } from '../args.ts';
import { errorLine, heading, line, style } from '../ui.ts';

/**
 * `rpa queue <id>` - inspect a work queue, re-seed a local one, or dispatch the
 * synthetic seed items into Orchestrator.
 *
 * The mutating flags are deliberately asymmetric:
 *   --reset     local only. Re-seeding a shared Orchestrator queue from a CLI
 *               flag is not a thing this tool will do.
 *   --push-seed orchestrator only. Adding items is additive and safe.
 */
export async function queueCommand(args: ParsedArgs): Promise<number> {
  const automationId = args.positionals[1];
  if (automationId === undefined) {
    errorLine('Usage: rpa queue <automation-id> [--reset | --push-seed] [--env dev]');
    return 2;
  }

  const repoRoot = findRepoRoot();
  const env = resolveEnv(args);
  const automation = await findAutomation(repoRoot, automationId);
  const config = await loadConfig({ repoRoot, automationDir: automation.dir, env });

  const queueName = automation.manifest.queue.name;
  const seedFile = path.join(automation.dir, 'data', 'seed', 'queue.json');
  const isOrchestrator = config.queue.provider === 'orchestrator';

  if (flagBool(args, 'reset')) {
    if (isOrchestrator) {
      errorLine(
        style.red(
          `Refusing to reset "${queueName}": queue.provider is "orchestrator" for APP_ENV="${env}".`,
        ),
      );
      errorLine('Resetting a shared Orchestrator queue is a deliberate operation - do it in Orchestrator.');
      errorLine('To reset the LOCAL queue instead: APP_ENV=dev pnpm rpa queue ' + automationId + ' --reset');
      return 2;
    }

    const provider = new LocalQueueProvider({
      file: localQueueFile(repoRoot, config.dataDir, queueName),
      seedFile,
      queueName,
      logger: createLogger({ level: 'warn', pretty: false, base: {} }),
    });
    const count = await provider.reset();
    await provider.close();
    line(style.green(`Re-seeded local queue "${queueName}" with ${count} synthetic item(s).`));
    return 0;
  }

  if (flagBool(args, 'push-seed')) {
    if (!isOrchestrator) {
      errorLine(
        `--push-seed dispatches into Orchestrator, but queue.provider is "local" for APP_ENV="${env}".`,
      );
      errorLine('Use --env staging|prod, or QUEUE_PROVIDER=orchestrator.');
      return 2;
    }
    return pushSeed({ repoRoot, automationDir: automation.dir, seedFile, queueName, env, automationId });
  }

  // ── Read-only stats ──
  heading(`queue ${queueName}`);
  line(`  provider : ${config.queue.provider}${isOrchestrator ? ` (mode ${config.queue.mode})` : ''}`);

  const stats = isOrchestrator
    ? await orchestratorStats({ repoRoot, automationDir: automation.dir, env, automationId })
    : await readLocalQueueStats(localQueueFile(repoRoot, config.dataDir, queueName));

  if (!isOrchestrator) {
    line(`  file     : ${path.relative(repoRoot, localQueueFile(repoRoot, config.dataDir, queueName))}`);
  }

  if (stats === undefined) {
    line(`  ${style.dim('no state yet - it is created and seeded on the first run')}`);
    return 0;
  }

  printStats(stats);
  line();
  line(
    style.dim(
      isOrchestrator
        ? `Dispatch synthetic items with: pnpm rpa queue ${automationId} --push-seed --env ${env}`
        : `Re-seed with: pnpm rpa queue ${automationId} --reset`,
    ),
  );
  return 0;
}

interface SeedFile {
  items?: Array<{ reference?: string; priority?: Priority; payload?: unknown }>;
}

async function pushSeed(input: {
  repoRoot: string;
  automationDir: string;
  seedFile: string;
  queueName: string;
  env: string;
  automationId: string;
}): Promise<number> {
  let seed: SeedFile;
  try {
    seed = JSON.parse(await readFile(input.seedFile, 'utf8')) as SeedFile;
  } catch (thrown) {
    errorLine(`Could not read seed file ${input.seedFile}: ${describe(thrown)}`);
    return 1;
  }

  const items = seed.items ?? [];
  if (items.length === 0) {
    errorLine('Seed file contains no items.');
    return 1;
  }

  const bundle = await buildBundle(input.repoRoot, input.automationDir, input.env, input.automationId);
  if (bundle.orchestratorQueue === undefined) {
    errorLine('Expected the Orchestrator queue provider but got the local one.');
    return 1;
  }

  await bundle.queue.init();

  let added = 0;
  let duplicates = 0;

  for (const item of items) {
    if (item.reference === undefined) {
      errorLine(style.yellow('  skipped an item with no reference'));
      continue;
    }
    try {
      const created = await bundle.orchestratorQueue.add({
        reference: item.reference,
        ...(item.priority === undefined ? {} : { priority: item.priority }),
        payload: item.payload ?? {},
      });
      line(`  ${style.green('added')}  ${item.reference} -> Id ${created.id}`);
      added += 1;
    } catch (thrown) {
      // A duplicate reference is a BusinessException by design - it means the
      // item is already queued, which for a re-run is the expected outcome.
      const message = describe(thrown);
      if (message.toLowerCase().includes('reference already exists')) {
        line(`  ${style.yellow('exists')} ${item.reference} (already queued)`);
        duplicates += 1;
        continue;
      }
      errorLine(`  ${style.red('failed')} ${item.reference}: ${message}`);
      await bundle.queue.close();
      return 1;
    }
  }

  await bundle.queue.close();
  line();
  line(style.green(`Dispatched ${added} item(s) to "${input.queueName}"${duplicates > 0 ? `, ${duplicates} already present` : ''}.`));
  return 0;
}

async function orchestratorStats(input: {
  repoRoot: string;
  automationDir: string;
  env: string;
  automationId: string;
}): Promise<QueueStats | undefined> {
  const bundle = await buildBundle(input.repoRoot, input.automationDir, input.env, input.automationId);
  try {
    await bundle.queue.init();
    return await bundle.queue.stats();
  } finally {
    await bundle.queue.close();
  }
}

async function buildBundle(
  repoRoot: string,
  automationDir: string,
  env: string,
  automationId: string,
): Promise<Awaited<ReturnType<typeof createQueueProvider>>> {
  const automation = await findAutomation(repoRoot, automationId);
  const config = await loadConfig({ repoRoot, automationDir, env });
  const logger = createLogger({ level: 'warn', pretty: false, base: {} });

  return createQueueProvider({
    config,
    manifest: automation.manifest,
    automationDir,
    dataDir: path.resolve(repoRoot, config.dataDir),
    secrets: new SecretResolver(),
    logger,
  });
}

function localQueueFile(repoRoot: string, dataDir: string, queueName: string): string {
  return path.join(path.resolve(repoRoot, dataDir), `queue.${queueName}.json`);
}

function printStats(stats: QueueStats): void {
  line(`  total       : ${stats.total}`);
  line(`  new         : ${stats.new}`);
  line(`  inProgress  : ${stats.inProgress}`);
  line(`  success     : ${style.green(String(stats.success))}`);
  line(`  failed      : ${stats.failed > 0 ? style.red(String(stats.failed)) : '0'}`);
  line(`  abandoned   : ${stats.abandoned > 0 ? style.yellow(String(stats.abandoned)) : '0'}`);
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
