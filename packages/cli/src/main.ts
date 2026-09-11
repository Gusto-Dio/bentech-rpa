import { parseArgs, type ParsedArgs } from './args.ts';
import { doctorCommand } from './commands/doctor.ts';
import { listCommand } from './commands/list.ts';
import { mfaCommand } from './commands/mfa.ts';
import { newCommand } from './commands/new.ts';
import { orchestratorCommand } from './commands/orchestrator.ts';
import { queueCommand } from './commands/queue.ts';
import { runCommand } from './commands/run.ts';
import { sentinelCommand } from './commands/sentinel.ts';
import { validateCommand } from './commands/validate.ts';
import { errorLine, line, style } from './ui.ts';

/**
 * Loads .env if present. Uses Node's built-in loader rather than a dotenv
 * dependency, and swallows the "missing file" case so a container that gets its
 * configuration from real environment variables stays quiet.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file. Expected in every deployed environment.
  }
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<number>> = {
  run: runCommand,
  list: listCommand,
  validate: validateCommand,
  new: newCommand,
  queue: queueCommand,
  doctor: doctorCommand,
  mfa: mfaCommand,
  orchestrator: orchestratorCommand,
  sentinel: sentinelCommand,
};

function usage(): void {
  line(`${style.bold('rpa')} - run and manage automations in this platform repo`);
  line();
  line(style.bold('Commands'));
  line('  run <id> [--provider local|orchestrator]  Run one automation (the production entrypoint)');
  line('  list [--domain d] [--json]             List automations discovered from their manifests');
  line('  validate [--env dev]                   Manifests, import boundaries, config, loadability');
  line('  queue <id> [--reset]                   Inspect or re-seed an automation queue');
  line('  new automation --id d/n --owner @team  Scaffold an automation from a template');
  line('  new domain --name d --owner @team      Scaffold a new process-type domain');
  line('  doctor                                 Check that this machine can actually run one');
  line('  mfa seed-profile | check               Set up or verify the Gmail profile that supplies MFA codes');
  line('  orchestrator check [--automation <id>] Verify Orchestrator auth, scopes, folder and queue');
  line('  sentinel --list | <probe-id> | --set s  Watch a carrier portal for failure AND for drift');
  line();
  line(style.bold('rpa sentinel'));
  line('  --list                          What probes exist, and what each one costs to run');
  line('  <probe-id>...                   Run named probes. A PROBE id, never an automation id');
  line('  --set access|session|navigation The scheduled cadences');
  line('  --file-issues                   Actually file. Dry run is the DEFAULT');
  line('  --bless --note "<why>"          Record the current screens as the new baseline');
  line();
  line(style.bold('Environment'));
  line('  APP_ENV   dev | staging | prod   selects config/environments/<APP_ENV>.json');
  line('  HEADLESS  false                  show the browser (developer machines only)');
  line('  LOG_PRETTY true                  human-readable logs instead of JSON');
  line('  QUEUE_PROVIDER local | orchestrator  which queue backend to use');
  line();
  line(style.dim('All variables are documented in .env.example.'));
}

async function main(): Promise<number> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0];

  if (command === undefined || args.flags.has('help') || args.flags.has('h')) {
    usage();
    return command === undefined ? 1 : 0;
  }

  const handler = COMMANDS[command];
  if (handler === undefined) {
    errorLine(`Unknown command "${command}".`);
    line();
    usage();
    return 2;
  }

  return handler(args);
}

/**
 * Sets process.exitCode rather than calling process.exit(): pino's pretty
 * transport writes from a worker thread, and a hard exit would truncate the
 * last lines of the run - including the summary someone is reading to find out
 * what happened.
 */
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((thrown: unknown) => {
    errorLine('');
    errorLine(style.red(thrown instanceof Error ? thrown.message : String(thrown)));
    if (thrown instanceof Error && thrown.stack !== undefined && process.env['RPA_DEBUG'] === 'true') {
      errorLine(thrown.stack);
    }
    process.exitCode = 1;
  });
