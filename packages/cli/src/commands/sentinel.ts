import path from 'node:path';
import {
  BaselineStore,
  EvidenceStore,
  GitHubIssuesClient,
  LABEL_DEFINITIONS,
  LockHeldError,
  PortalLock,
  StateStore,
  breakStreaks,
  bumpDaily,
  causesFor,
  decideFiling,
  chromiumLaunchOptions,
  createRedactor,
  createRunId,
  dailyCount,
  decideMfaBudget,
  discoverAutomations,
  findRepoRoot,
  loadConfig,
  loadProbeSet,
  parseDriftLog,
  readRuntimeFacts,
  recordSighting,
  recurrenceComment,
  renderIssueBody,
  renderIssueTitle,
  runProbe,
  SENTINEL_LABELS,
  scoreDriftLogRows,
  driftLogTerms,
  stormIssue,
  triage,
  SecretResolver,
  createLogger,
  type Probe,
  type ProbeEvidence,
  type IssueRef,
  type ProbeSetName,
  type Redactor,
  type SentinelState,
  type TriageResult,
} from '@rpa/core';
import { chromium } from 'playwright';
import type { ParsedArgs } from '../args.ts';
import { flagString } from '../args.ts';
import { heading, line, style } from '../ui.ts';

/**
 * `rpa sentinel` - watch a carrier portal for FAILURE and for DRIFT.
 *
 * Modelled on `rpa doctor`: collect typed results, print a table, return a
 * number. The number is the contract with whatever schedules this, so it has
 * its own taxonomy rather than reusing the runner's - `EXIT_CODES` in
 * `summary.ts` is typed to a `RunSummary` and means different things.
 *
 * ── TWO THINGS THIS COMMAND WILL NOT DO ─────────────────────────────────────
 * It will not run an automation. The positional argument is a PROBE id, and a
 * probe id that looks like an automation id is rejected at load time - because
 * `rpa sentinel group-submission/anthem-ca-new-plans` is one keystroke from the
 * forbidden `rpa run group-submission/anthem-ca-new-plans`, and rule 10a says a
 * run creates a real account and a real quote at any `allowSubmit` setting.
 *
 * It will not file an issue unless asked. `--dry-run` is the default, so a hand
 * run or a first container run prints what it would file and files nothing.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const SENTINEL_EXIT = {
  /** Every probe passed and every screen matched its baseline. */
  ok: 0,
  /** A probe failed, and triage says our code is the likely cause. */
  healable: 1,
  /** A probe failed for a reason healing cannot fix. */
  needsHuman: 2,
  /** Everything passed, but a screen moved. Nothing is broken yet. */
  drift: 3,
  /**
   * The sentinel could not LOOK - the lock was held, the MFA budget was spent,
   * config was invalid. Distinct from 1 on purpose: "we could not look"
   * reported as "the portal is broken" is how a monitor loses its audience.
   */
  inconclusive: 4,
  /** The kill switch is on. Distinct from 4: a monitor must tell "off" from "wedged". */
  disabled: 5,
} as const;

const SETS: readonly ProbeSetName[] = ['access', 'session', 'navigation'];

interface DiscoveredProbe {
  probe: Probe;
  automationId: string;
  automationDir: string;
}

export async function sentinelCommand(args: ParsedArgs): Promise<number> {
  const repoRoot = findRepoRoot();
  const logger = createLogger({
    level: process.env['LOG_LEVEL'] ?? 'info',
    pretty: process.env['LOG_PRETTY'] === 'true',
    base: {},
  });

  const all = await discoverProbes(repoRoot);

  if (args.flags.get('list') === true) return listProbes(all);

  const setName = flagString(args, 'set');
  if (setName !== undefined && !SETS.includes(setName as ProbeSetName)) {
    errorOut(`Unknown probe set "${setName}". Known sets: ${SETS.join(', ')}.`);
    return SENTINEL_EXIT.inconclusive;
  }

  /**
   * `positionals[0]` is the command name itself - `main.ts` reads it from there
   * to dispatch and does not strip it, which is the convention `run.ts` and
   * `queue.ts` already follow by starting at index 1.
   */
  const wanted = args.positionals.slice(1);
  const selected = select(all, wanted, setName as ProbeSetName | undefined);

  if (selected.length === 0) {
    errorOut(
      wanted.length > 0
        ? `No probe matched ${wanted.map((id) => `"${id}"`).join(', ')}. Try \`rpa sentinel --list\`.`
        : 'Nothing to run. Name a probe id, or pass --set access|session|navigation.',
    );

    /**
     * The specific confusion worth naming out loud, because the two commands
     * differ by one word and one of them creates real records on a production
     * carrier portal.
     */
    if (wanted.some((id) => id.startsWith('group-submission/') || id.startsWith('member-submission/'))) {
      line();
      line('  That looks like an AUTOMATION id. `rpa sentinel` takes a PROBE id - they are');
      line('  deliberately different shapes, because `rpa run group-submission/anthem-ca-new-plans`');
      line('  is forbidden under the production freeze and differs from a sentinel command by one');
      line('  word. Run `rpa sentinel --list` to see the probe ids.');
    }

    return SENTINEL_EXIT.inconclusive;
  }

  /**
   * Config comes from the first selected probe's automation, because the
   * sentinel block lives in `config/platform.json` and is shared - but the
   * loader needs an automation directory to resolve the layered files.
   */
  const first = selected[0];
  if (first === undefined) return SENTINEL_EXIT.inconclusive;

  const config = await loadConfig({ repoRoot, automationDir: first.automationDir, env: resolveEnv() });
  const sentinelConfig = config.sentinel;

  const enabled = process.env['RPA_SENTINEL_ENABLED'] !== 'false' && sentinelConfig.enabled;
  if (!enabled) {
    heading('rpa sentinel');
    line(`  ${style.yellow('off')}   the sentinel is disabled (config, or RPA_SENTINEL_ENABLED=false)`);
    return SENTINEL_EXIT.disabled;
  }

  const runId = createRunId();
  const dataDir = path.resolve(repoRoot, config.dataDir);
  const sentinelDataDir = path.join(dataDir, 'sentinel');

  const lock = new PortalLock({
    dir: sentinelDataDir,
    probeSet: setName ?? selected.map((entry) => entry.probe.id).join(','),
    runId,
    staleAfterMs: sentinelConfig.lockStaleAfterMs,
    logger,
  });

  try {
    await lock.acquire();
  } catch (cause) {
    if (cause instanceof LockHeldError) {
      heading('rpa sentinel');
      line(`  ${style.yellow('skip')}  ${cause.message}`);
      line();
      line(
        '  Two probe runs must never overlap: they fight over the persistent browser profile, and',
      );
      line('  the loser reports "the profile is already in use" instead of anything about the portal.');
      return SENTINEL_EXIT.inconclusive;
    }
    throw cause;
  }

  try {
    return await runSelected({
      selected,
      args,
      repoRoot,
      dataDir,
      sentinelDataDir,
      runId,
      config,
      sentinelConfig,
      logger,
    });
  } finally {
    /** Always. An unreleased lock blocks every later run. */
    await lock.release();
  }
}

interface RunContext {
  selected: readonly DiscoveredProbe[];
  args: ParsedArgs;
  repoRoot: string;
  dataDir: string;
  sentinelDataDir: string;
  runId: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  sentinelConfig: Awaited<ReturnType<typeof loadConfig>>['sentinel'];
  logger: ReturnType<typeof createLogger>;
}

async function runSelected(ctx: RunContext): Promise<number> {
  const { selected, config, sentinelConfig, logger, runId } = ctx;

  const blessing = ctx.args.flags.get('bless') === true;
  const secrets = new SecretResolver();
  const redactor = createRedactor({ values: await resolveSecretValues(secrets) });

  const stateStore = new StateStore({ dir: ctx.sentinelDataDir, logger });
  const state = await stateStore.read();

  const runtime = readRuntimeFacts({ headless: config.browser.headless });
  const evidenceStore = new EvidenceStore({
    artifactsDir: path.resolve(ctx.repoRoot, config.artifactsDir),
    runId,
    logger,
  });

  heading('rpa sentinel');
  line(`  run      : ${runId}`);
  line(`  headless : ${runtime.headless}`);
  line(`  display  : ${runtime.display ?? '(none)'}`);
  line(`  probes   : ${selected.map((entry) => entry.probe.id).join(', ')}`);
  line(`  filing   : ${filingEnabled(ctx.args, sentinelConfig) ? 'ENABLED' : 'dry run (nothing will be filed)'}`);
  line();

  const browser = await chromium.launch(chromiumLaunchOptions(config.browser));
  const results: { probe: Probe; evidence: ProbeEvidence; triage: TriageResult }[] = [];

  try {
    for (const entry of selected) {
      const { probe } = entry;
      const baselines = new BaselineStore({
        dir: path.join(entry.automationDir, 'sentinel', 'baselines'),
        logger,
      });

      const mfaBudget = decideMfaBudget({
        probe,
        /**
         * Conservative on purpose. Without a preceding session probe in this
         * run we do not know the liveness, and treating "unknown" as lapsed
         * would authorise spending a code to find out. `not-probed` therefore
         * does NOT unlock the budget unless the cap allows it - see
         * `decideMfaBudget`.
         */
        liveness: 'not-probed',
        spentToday: dailyCount(state, 'mfaCodes'),
        maxPerDay: sentinelConfig.maxMfaPerDay,
      });

      const readScreen = await loadScreenReader(entry);

      const { evidence, readings } = await runProbe({
        probe,
        browser,
        runId,
        secrets,
        logger: logger.child({ probe: probe.id }),
        redactor,
        evidence: evidenceStore,
        baselines,
        paths: { repoRoot: ctx.repoRoot, dataDir: ctx.dataDir },
        runtime,
        mfaBudget,
        readScreen,
      });

      if (evidence.session.mfaCodeSpent) bumpDaily(state, 'mfaCodes');

      const verdict = triage(evidence, { causes: causesFor(probe) });
      results.push({ probe, evidence, triage: verdict });

      printProbe(probe, evidence, verdict);

      if (blessing) {
        await blessBaselines(ctx, entry, evidence, baselines);
        continue;
      }

      /**
       * Evidence is written for findings, not for healthy passes. Ninety-six
       * clean access runs a day, each leaving a directory, would turn
       * `artifacts/` into the append-only audit store AGENTS.md lists as
       * deliberately absent - by accident, and without anyone deciding to build
       * one.
       */
      if (verdict.action !== 'none') {
        const written = await evidenceStore.write(evidence, readings, redactor);
        line(`         evidence: ${path.relative(ctx.repoRoot, written.dir)}`);
      }

      recordSighting(state, verdict.fingerprint.hash);
    }
  } finally {
    await browser.close().catch((cause: unknown) => {
      logger.warn({ err: cause }, 'Could not close the sentinel browser');
    });
  }

  breakStreaks(state, results.map((entry) => entry.triage.fingerprint.hash));

  if (!blessing && filingEnabled(ctx.args, sentinelConfig)) {
    await fileFindings({ ctx, results, state, redactor, evidenceStore });
  }

  await evidenceStore.prune(sentinelConfig.evidenceRetentionDays);
  await stateStore.write(state);

  return report(results, state, ctx);
}

/**
 * Puts findings in front of a person.
 *
 * ── ONE LIST CALL FOR THE WHOLE RUN ────────────────────────────────────────
 * Open issues are fetched once and reused for every decision. That is not just
 * an optimisation: filing an issue and then re-listing would race with GitHub's
 * own consistency, and two findings in one run could each conclude they were
 * first. The locally-appended `openIssues` array is the authority within a run.
 */
async function fileFindings(input: {
  ctx: RunContext;
  results: readonly { probe: Probe; evidence: ProbeEvidence; triage: TriageResult }[];
  state: SentinelState;
  redactor: Redactor;
  evidenceStore: EvidenceStore;
}): Promise<void> {
  const { ctx, results, state, redactor, evidenceStore } = input;
  const { sentinelConfig, logger } = ctx;

  const findings = results.filter((entry) => entry.triage.action !== 'none');
  if (findings.length === 0) return;

  const token = await new SecretResolver().optional(sentinelConfig.githubTokenEnv);
  if (token === undefined || token.trim() === '') {
    line();
    line(
      `  ${style.yellow('warn')}  ${sentinelConfig.githubTokenEnv} is not set, so nothing can be filed. ` +
        'Findings are recorded in state and will be filed once it is.',
    );
    return;
  }

  const github = new GitHubIssuesClient({
    repo: sentinelConfig.repo,
    token,
    logger,
  });

  /** Idempotent, and cheap enough to do every run rather than as a setup step. */
  for (const label of LABEL_DEFINITIONS) {
    await github.ensureLabel(label.name, label.color, label.description);
  }

  const openIssues: IssueRef[] = [...(await github.listOpen(SENTINEL_LABELS.all))];
  const driftLog = await readDriftLog(ctx.repoRoot);

  let suppressed = 0;
  const suppressedProbes = new Set<string>();

  heading('Filing');

  for (const finding of findings) {
    const record = state.fingerprints[finding.triage.fingerprint.hash];
    if (record === undefined) continue;

    const decision = decideFiling({
      triage: finding.triage,
      probeId: finding.probe.id,
      carrier: finding.probe.carrier,
      record,
      openIssues,
      newIssuesToday: dailyCount(state, 'newIssues'),
      config: sentinelConfig,
    });

    const evidenceDir = path.relative(ctx.repoRoot, evidenceStore.dirFor(finding.probe.id));

    if (decision.action === 'skip') {
      line(`  ${style.yellow('skip')}  ${finding.probe.id}: ${decision.reason}`);
      if (decision.reason.includes('daily cap')) {
        suppressed += 1;
        suppressedProbes.add(finding.probe.id);
      }
      continue;
    }

    if (decision.action === 'comment') {
      await github.comment(
        decision.issueNumber,
        recurrenceComment({ record, evidenceDir, runId: ctx.runId, reason: decision.reason }),
      );
      state.fingerprints[finding.triage.fingerprint.hash] = {
        ...record,
        issueNumber: decision.issueNumber,
        cooldownUntil: new Date(Date.now() + sentinelConfig.perFingerprintCooldownMs).toISOString(),
      };
      line(`  ${style.green('note')}  ${finding.probe.id}: commented on #${decision.issueNumber}`);
      continue;
    }

    const priorArt = scoreDriftLogRows(
      driftLog.rows,
      driftLogTerms({
        ...(finding.evidence.failedStep === undefined ? {} : { step: finding.evidence.failedStep }),
        ...(finding.triage.fingerprint.screenId === undefined
          ? {}
          : { screenId: finding.triage.fingerprint.screenId }),
        deltaValues: finding.evidence.screens.flatMap(
          (screen) => screen.delta?.changes.filter((c) => c.meaningful).map((c) => c.value) ?? [],
        ),
      }),
    ).slice(0, 3);

    const issueInput = {
      evidence: finding.evidence,
      triage: finding.triage,
      priorArt,
      evidenceDir,
      reproduceCommand: `pnpm rpa sentinel ${finding.probe.id}`,
      reproduceInContainer:
        `docker compose run --rm -e HEADLESS=false \\\n` +
        `  --entrypoint tooling/docker/with-display.sh rpa \\\n` +
        `  pnpm rpa sentinel ${finding.probe.id}`,
      occurrences: record.occurrences,
      driftLogPath: driftLog.path,
    };

    /**
     * `renderIssueBody` THROWS if a known secret value survived redaction.
     * Deliberately not caught here: rule 2 is not a thing to warn about and
     * file anyway, and a leak means the redactor needs fixing before this
     * sentinel files anything at all.
     */
    const created = await github.create({
      title: renderIssueTitle(issueInput),
      body: renderIssueBody(issueInput, redactor),
      labels: decision.labels,
    });

    openIssues.push({
      number: created.number,
      title: created.title,
      body: created.body,
      labels: decision.labels,
      assignees: [],
      hasLinkedPullRequest: false,
    });

    bumpDaily(state, 'newIssues');
    state.fingerprints[finding.triage.fingerprint.hash] = {
      ...record,
      issueNumber: created.number,
      cooldownUntil: new Date(Date.now() + sentinelConfig.perFingerprintCooldownMs).toISOString(),
    };

    line(`  ${style.red('file')}  ${finding.probe.id}: opened #${created.number} (${decision.labels.join(', ')})`);
  }

  /**
   * The cap announces itself. A rate limit that produces silence is
   * indistinguishable from a healthy portal, which is the one failure mode a
   * monitor must not have.
   */
  if (suppressed > 0) {
    const alreadyStormed = openIssues.some((issue) => issue.labels.includes(SENTINEL_LABELS.storm));
    if (!alreadyStormed) {
      const storm = stormIssue({
        suppressed,
        cap: sentinelConfig.maxNewIssuesPer24h,
        probeIds: [...suppressedProbes],
      });
      const created = await github.create(storm);
      line(`  ${style.red('file')}  rate limit: opened #${created.number}`);
    } else {
      line(`  ${style.yellow('skip')}  rate limit: a storm issue is already open`);
    }
  }
}

/**
 * The drift log, for prior art.
 *
 * Best-effort: an issue without prior art is still a useful issue, and a
 * missing or renamed log must not stop a finding being filed.
 */
async function readDriftLog(repoRoot: string): Promise<{ path: string; rows: ReturnType<typeof parseDriftLog> }> {
  const relative = path.join('docs', 'poc', 'anthem-ca-new-plans', 'drift-log.md');
  const { readFile } = await import('node:fs/promises');

  try {
    const markdown = await readFile(path.join(repoRoot, relative), 'utf8');
    return { path: relative, rows: parseDriftLog(markdown) };
  } catch {
    return { path: relative, rows: [] };
  }
}

function printProbe(probe: Probe, evidence: ProbeEvidence, verdict: TriageResult): void {
  const mark =
    evidence.verdict === 'pass'
      ? verdict.action === 'none'
        ? style.green('ok  ')
        : style.yellow('drift')
      : verdict.action === 'healable-issue'
        ? style.red('fail')
        : style.yellow('warn');

  line(`  ${mark}  ${probe.id.padEnd(30)} ${verdict.ruleId}`);
  for (const explanation of probe.explain(evidence)) line(`       ${explanation}`);
}

function report(
  results: readonly { probe: Probe; evidence: ProbeEvidence; triage: TriageResult }[],
  state: SentinelState,
  ctx: RunContext,
): number {
  const findings = results.filter((entry) => entry.triage.action !== 'none');

  line();
  if (findings.length === 0) {
    line(style.green('Every probe passed, and every screen matched its baseline.'));
    return SENTINEL_EXIT.ok;
  }

  heading(`Findings (${findings.length})`);
  for (const finding of findings) {
    const record = state.fingerprints[finding.triage.fingerprint.hash];
    line(
      `  ${finding.triage.action.padEnd(15)} ${finding.probe.id}  ` +
        `[${finding.triage.fingerprint.hash}]` +
        (record === undefined ? '' : ` seen ${record.occurrences}x, streak ${record.streak}`),
    );
    line(`      ${finding.triage.rationale}`);
  }

  if (!filingEnabled(ctx.args, ctx.sentinelConfig)) {
    line();
    line(
      style.yellow('Dry run: nothing was filed.') +
        ' Pass --file-issues (or set RPA_SENTINEL_FILE_ISSUES=true) to file.',
    );
  }

  /** Worst-of, so one healable finding is not hidden behind three passes. */
  if (findings.some((entry) => entry.triage.action === 'healable-issue')) return SENTINEL_EXIT.healable;
  if (findings.some((entry) => entry.triage.action === 'human-issue' || entry.triage.action === 'infra-issue')) {
    return SENTINEL_EXIT.needsHuman;
  }
  return SENTINEL_EXIT.drift;
}

/**
 * Blessing a baseline is a deliberate, reviewed act.
 *
 * Three refusals, each closing a way a baseline could be created to make a
 * check go green rather than to record a truth:
 *
 *  - never on a failing verdict. You do not record a broken screen as correct.
 *  - never without a note. A baseline with no note is indistinguishable from
 *    one blessed to silence a finding.
 *  - never from a non-TTY unless --yes. This is what stops the SCHEDULED
 *    container from ever blessing anything; without it the monitor could
 *    quietly ratify every change it was built to detect.
 */
async function blessBaselines(
  ctx: RunContext,
  entry: DiscoveredProbe,
  evidence: ProbeEvidence,
  baselines: BaselineStore,
): Promise<void> {
  const note = flagString(ctx.args, 'note');

  if (evidence.verdict !== 'pass') {
    errorOut(`Refusing to bless ${entry.probe.id}: the probe did not pass. Fix it first.`);
    return;
  }
  if (note === undefined || note.trim() === '') {
    errorOut(
      `Refusing to bless ${entry.probe.id}: --note is required. A baseline with no note cannot be ` +
        'told apart from one blessed to make a failing check go green.',
    );
    return;
  }
  if (process.stdout.isTTY !== true && ctx.args.flags.get('yes') !== true) {
    errorOut(
      `Refusing to bless ${entry.probe.id} from a non-interactive session. This is what stops the ` +
        'scheduled container from ratifying the very changes the sentinel exists to detect. ' +
        'Pass --yes if you really mean it.',
    );
    return;
  }

  for (const screen of evidence.screens) {
    const file = await baselines.write(screen.signature, {
      blessedAt: new Date().toISOString(),
      runId: evidence.runId,
      probeId: evidence.probeId,
      signatureVersion: screen.signature.version,
      note: note.trim(),
    });
    line(`  ${style.green('bless')} ${screen.screenId} -> ${path.relative(ctx.repoRoot, file)}`);
  }
}

async function discoverProbes(repoRoot: string): Promise<readonly DiscoveredProbe[]> {
  const { automations } = await discoverAutomations(repoRoot);
  const found: DiscoveredProbe[] = [];

  for (const automation of automations) {
    if (automation.manifest.sentinel === undefined) continue;
    const { probes } = await loadProbeSet(automation);
    for (const probe of probes) {
      found.push({ probe, automationId: automation.manifest.id, automationDir: automation.dir });
    }
  }

  return found;
}

/**
 * The screen reader lives with the automation, because it is a list of CSS
 * selectors and rule 5 puts those in `src/pages/`. Loaded by convention from
 * `src/pages/read-screen.ts`, through the same computed-path seam the registry
 * already uses - so `packages/` still imports no automation literal.
 */
async function loadScreenReader(entry: DiscoveredProbe): Promise<Parameters<typeof runProbe>[0]['readScreen']> {
  const { pathToFileURL } = await import('node:url');
  const file = path.join(entry.automationDir, 'src', 'pages', 'read-screen.ts');
  const imported: unknown = await import(pathToFileURL(file).href);
  const reader = (imported as { readScreen?: unknown }).readScreen;

  if (typeof reader !== 'function') {
    throw new Error(
      `${entry.automationId} must export readScreen from src/pages/read-screen.ts for the sentinel ` +
        'to read a screen. That reader is shared with gate-evidence.ts on purpose: a drift baseline ' +
        'built from a different reading than the automation sees when it breaks is worse than none.',
    );
  }

  return reader as Parameters<typeof runProbe>[0]['readScreen'];
}

/**
 * The values the redactor must remove.
 *
 * Read by NAME from the environment, and the values are never logged, printed
 * or returned anywhere else. A missing one is fine - it simply cannot appear on
 * screen either.
 */
async function resolveSecretValues(secrets: SecretResolver): Promise<Record<string, string>> {
  const wanted: readonly (readonly [string, string])[] = [
    ['ANTHEM_PORTAL_USERNAME', '<user>'],
    ['ANTHEM_PRODUCER_FIRST_NAME', '<producer.first>'],
    ['ANTHEM_PRODUCER_LAST_NAME', '<producer.last>'],
    ['ANTHEM_PAID_AGENCY_CODE', '<agency.code>'],
    ['UHC_PORTAL_USERNAME', '<user>'],
    ['UHC_PRODUCER_FIRST_NAME', '<producer.first>'],
    ['UHC_PRODUCER_LAST_NAME', '<producer.last>'],
    ['UHC_GENERAL_AGENT_NAME', '<general.agent>'],
    ['UHC_GENERAL_AGENT_FRANCHISE_CODE', '<franchise.code>'],
    ['UHC_PCIS_ID', '<pcis.id>'],
  ];

  const values: Record<string, string> = {};
  for (const [name, token] of wanted) {
    const value = await secrets.optional(name);
    if (value !== undefined && value.trim() !== '') values[value] = token;
  }
  return values;
}

function select(
  all: readonly DiscoveredProbe[],
  positionals: readonly string[],
  setName: ProbeSetName | undefined,
): readonly DiscoveredProbe[] {
  if (positionals.length > 0) {
    return all.filter((entry) => positionals.includes(entry.probe.id));
  }
  if (setName !== undefined) {
    return all.filter((entry) => entry.probe.sets.includes(setName));
  }
  return [];
}

function listProbes(all: readonly DiscoveredProbe[]): number {
  heading('rpa sentinel --list');
  if (all.length === 0) {
    line('  No probes are declared. Add a `sentinel` block to an automation.json.');
    return SENTINEL_EXIT.ok;
  }

  for (const entry of all) {
    line(`  ${entry.probe.id.padEnd(30)} ${entry.probe.title}`);
    line(
      `  ${''.padEnd(30)} sets: ${entry.probe.sets.join(', ')}` +
        `  credentials: ${entry.probe.needsCredentials}` +
        `  may spend MFA: ${entry.probe.maySpendMfa}`,
    );
  }
  return SENTINEL_EXIT.ok;
}

function filingEnabled(args: ParsedArgs, config: { fileIssues: boolean }): boolean {
  if (process.env['RPA_SENTINEL_FILE_ISSUES'] === 'false') return false;
  if (args.flags.get('dry-run') === true) return false;
  return args.flags.get('file-issues') === true || process.env['RPA_SENTINEL_FILE_ISSUES'] === 'true' || config.fileIssues;
}

function resolveEnv(): string {
  return process.env['APP_ENV'] ?? 'dev';
}

function errorOut(message: string): void {
  line(`  ${style.red('fail')}  ${message}`);
}
