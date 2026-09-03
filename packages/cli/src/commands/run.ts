import { formatSummary, runAutomation } from '@rpa/core';
import { flagInt, flagString, resolveEnv, type ParsedArgs } from '../args.ts';
import { errorLine, line, style } from '../ui.ts';

/** `rpa run <automation-id>` - the production entrypoint. */
export async function runCommand(args: ParsedArgs): Promise<number> {
  const automationId = args.positionals[1];
  if (automationId === undefined) {
    errorLine('Usage: rpa run <automation-id> [--env dev] [--max-items N] [--provider local|orchestrator]');
    errorLine('       rpa list   to see the available ids');
    return 2;
  }

  const provider = flagString(args, 'provider');
  if (provider !== undefined && provider !== 'local' && provider !== 'orchestrator') {
    errorLine(`--provider must be "local" or "orchestrator", received "${provider}"`);
    return 2;
  }

  /**
   * --provider rides the existing layer-5 env override rather than a separate
   * code path, so the flag and the QUEUE_PROVIDER environment variable behave
   * identically. process.env is copied, not mutated.
   */
  const processEnv =
    provider === undefined ? process.env : { ...process.env, QUEUE_PROVIDER: provider };

  const maxItems = flagInt(args, 'max-items');
  const { summary, exitCode } = await runAutomation({
    automationId,
    env: resolveEnv(args),
    processEnv,
    ...(maxItems === undefined ? {} : { maxItems }),
  });

  line();
  line(style.bold('Run summary'));
  line(formatSummary(summary));
  line();

  if (exitCode === 0) {
    line(style.green('Completed with no system failures.'));
  } else {
    line(style.yellow(`Completed with exit code ${exitCode}. Evidence run id: ${summary.runId}`));
  }

  return exitCode;
}
