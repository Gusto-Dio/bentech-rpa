import { fingerprintMarker } from './fingerprint.ts';
import type { Redactor } from './redact.ts';
import { GOTCHA_HINTS, resolveRules } from './rule-map.ts';
import type { ScoredDriftLogRow } from './drift-log.ts';
import type { TriageResult } from './triage.ts';
import type { ProbeEvidence } from './types.ts';

/**
 * Rendering the issue a human or a repair session actually reads.
 *
 * ── THE ORDERING IS THE DESIGN ──────────────────────────────────────────────
 * The freeze warning comes FIRST, before the diagnosis, because the most
 * expensive mistake available to a reader of this issue is to verify a fix by
 * running the automation - which creates a real account and a real quote on a
 * production carrier portal. Putting that after the interesting part is putting
 * it where an impatient reader will not see it.
 *
 * Then: what happened, the runtime facts (roughly half of all causes are
 * runtime causes), the delta, where the evidence is, how to reproduce it, the
 * rules, the prior art, and how to close it.
 *
 * ── NO IMAGES, NO PATHS TO ANYTHING SECRET ──────────────────────────────────
 * Evidence is referenced by host path and never uploaded. A signed-in screen
 * from this portal carries a licensed producer's name and an agency code, and
 * rule 2 applies to an issue body exactly as it applies to a tracked file.
 * `renderIssueBody` therefore refuses to return a body that still contains a
 * known secret value - see `IssueBodyLeak`.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface IssueBodyInput {
  evidence: ProbeEvidence;
  triage: TriageResult;
  /** Top few rows from the drift log, already scored. */
  priorArt: readonly ScoredDriftLogRow[];
  /** Repo-relative directory holding this run's evidence, on the sentinel host. */
  evidenceDir: string;
  /** The command that reproduces this, verbatim, and permitted under the freeze. */
  reproduceCommand: string;
  /** Container form of the same command, when there is one. */
  reproduceInContainer?: string;
  /** How many times this fingerprint has been seen, when it is not the first. */
  occurrences?: number;
  /** Where the drift-log rows came from, for the citation. */
  driftLogPath: string;
}

/** Thrown rather than returned, because rule 2 is not a warning. */
export class IssueBodyLeak extends Error {
  constructor(readonly where: string) {
    super(
      `Refusing to render an issue body: a known secret value survived redaction (${where}). ` +
        'Fix the redactor rather than the assertion - this check is the last thing between a ' +
        "producer's name and a GitHub issue.",
    );
    this.name = 'IssueBodyLeak';
  }
}

export function renderIssueTitle(input: IssueBodyInput): string {
  const { evidence, triage } = input;

  /**
   * No fingerprint in the title. Dedup reads the marker in the BODY precisely
   * so a human can retitle an issue without orphaning it.
   */
  const where =
    evidence.failedStep !== undefined
      ? `${evidence.failedGate ?? 'step'} failed on "${evidence.failedStep}"`
      : triage.ruleId === 'pass-unknown-screen'
        ? `an unmapped screen: ${firstUnbaselined(evidence) ?? 'unknown'}`
        : triage.ruleId === 'pass-drift'
          ? `drift on ${firstDrifted(evidence) ?? 'a screen'}`
          : triage.ruleId;

  return `[sentinel] ${evidence.probeId}: ${where}`;
}

export function renderIssueBody(input: IssueBodyInput, redactor: Redactor): string {
  const body = build(input);

  const leak = firstLeakingLine(body, redactor);
  if (leak !== undefined) throw new IssueBodyLeak(leak);

  return body;
}

function build(input: IssueBodyInput): string {
  const { evidence, triage } = input;
  const sections: string[] = [];

  // ── 1. The warning, first. ──
  sections.push(
    [
      '## ⛔ Before you touch anything',
      '',
      '**Anthem production is frozen to signing in and navigating** (AGENTS.md rule 10a).',
      '',
      '`pnpm rpa run group-submission/anthem-ca-new-plans` is **forbidden at any `allowSubmit`',
      'setting** — a run at `false` still creates a real account and a real quote. You cannot',
      'verify a fix by running the automation.',
      '',
      'Permitted against this portal:',
      '',
      '- `pnpm tsx tooling/scripts/check-portal-access.ts` — credential-free, creates nothing',
      '- `pnpm tsx tooling/scripts/check-portal-navigation.ts` — signs in, creates nothing',
      '- the read-only recon harness (`anthem-serve.ts` + `anthem-do.ts`), navigation only',
      '- `pnpm rpa sentinel <probe-id>`',
    ].join('\n'),
  );

  // ── 2. What happened. ──
  const what: string[] = [
    '## What happened',
    '',
    `| | |`,
    `|---|---|`,
    `| Probe | \`${evidence.probeId}\` |`,
    `| Verdict | **${evidence.verdict}** |`,
    `| Triage rule | \`${triage.ruleId}\` |`,
    `| Run | \`${evidence.runId}\` at ${evidence.startedAt} |`,
  ];
  if (evidence.failedStep !== undefined) {
    what.push(`| Failed step | \`${evidence.failedStep}\` |`);
  }
  if (evidence.failedGate !== undefined) what.push(`| Gate | ${evidence.failedGate} |`);
  if (evidence.error !== undefined) {
    what.push(`| Error | \`${evidence.error.name}\` (${evidence.error.reason}) |`);
  }
  if (input.occurrences !== undefined && input.occurrences > 1) {
    what.push(`| Occurrences | ${input.occurrences} |`);
  }
  what.push('', `**Why this was filed.** ${triage.rationale}`);

  if (evidence.error !== undefined) {
    what.push('', '```', evidence.error.message, '```');
  }

  /**
   * The portal's own wording, and what the repo's own classifier made of it.
   * Quoted because it is the highest-value sentence on any failing screen, and
   * labelled because "is this a complaint?" is the question that decides
   * whether this is a bug at all.
   */
  if (evidence.portalMessage !== undefined) {
    what.push(
      '',
      `**The portal said** (\`isPortalComplaint\` → \`${evidence.portalMessage.isComplaint}\`):`,
      '',
      `> ${evidence.portalMessage.text}`,
    );
  }

  if (triage.cause !== undefined) {
    what.push(
      '',
      `**Known cause: \`${triage.cause.id}\`** — ${triage.cause.title}`,
      '',
      `${triage.cause.remedy}`,
      '',
      `_Reference: ${triage.cause.reference}_`,
    );
  }

  const hint = GOTCHA_HINTS[triage.ruleId];
  if (hint !== undefined) what.push('', `**Where to start.** ${hint}`);

  sections.push(what.join('\n'));

  // ── 3. Runtime. Half the causes are runtime causes. ──
  sections.push(
    [
      '## Runtime',
      '',
      '| | |',
      '|---|---|',
      `| headless | ${evidence.runtime.headless} |`,
      `| DISPLAY | ${evidence.runtime.display ?? '(none)'} |`,
      `| platform | ${evidence.runtime.platform} |`,
      `| in container | ${evidence.runtime.inContainer} |`,
      `| node | ${evidence.runtime.nodeVersion} |`,
      `| commit | ${evidence.runtime.gitCommit ?? '(unknown)'} |`,
      `| host | ${evidence.runtime.hostname} |`,
      '',
      '**Session** — ' +
        `stored: ${evidence.session.storedSessionPresent}, ` +
        `liveness: ${evidence.session.liveness}, ` +
        `signed in via: ${evidence.session.signedInVia}, ` +
        `SAML re-auth: ${evidence.session.samlReauthenticated}, ` +
        `**MFA code spent: ${evidence.session.mfaCodeSpent}**`,
    ].join('\n'),
  );

  // ── 4. The delta. ──
  sections.push(renderScreens(evidence));

  // ── 5. Evidence, by path. Nothing uploaded. ──
  sections.push(
    [
      '## Evidence',
      '',
      `On the sentinel host, under \`${input.evidenceDir}\`:`,
      '',
      '- `evidence.json` — the full record this issue was rendered from',
      '- `screen.<screenId>.json` — the redacted screen reading',
      '- `signature.<screenId>.json` — the normalized signature that was compared',
      '- `screenshot.<screenId>.masked.png` — masked capture, where one was taken',
      '',
      '_Paths only. Nothing is uploaded: a signed-in screen from this portal carries a real',
      "producer's name and agency code, and rule 2 applies to an issue body too._",
    ].join('\n'),
  );

  // ── 6. Reproduce. ──
  const reproduce = ['## Reproduce', '', '```bash', input.reproduceCommand, '```'];
  if (input.reproduceInContainer !== undefined) {
    reproduce.push(
      '',
      'As the servers run it — note `--entrypoint`, because overriding it outright loses the',
      'virtual display and then produces the very bot-block the probe exists to rule out:',
      '',
      '```bash',
      input.reproduceInContainer,
      '```',
    );
  }
  sections.push(reproduce.join('\n'));

  // ── 7. The rules. ──
  const rules = resolveRules(triage.rules);
  if (rules.length > 0) {
    sections.push(
      [
        '## Rules that apply',
        '',
        ...rules.flatMap((rule) => [`**Rule ${rule.id} — ${rule.title}.** ${rule.gist}`, '']),
      ]
        .join('\n')
        .trimEnd(),
    );
  }

  // ── 8. Prior art. ──
  sections.push(renderPriorArt(input));

  // ── 9. How to close it. ──
  sections.push(
    [
      '## How to close this',
      '',
      'Two legitimate outcomes, and choosing the wrong one is how code gets contorted to match a',
      'stale baseline:',
      '',
      '1. **The automation is wrong.** Fix the page object (or the step), prove it with the',
      '   verification ladder, add a drift-log row, and open a draft PR.',
      '2. **The portal genuinely changed and we are fine with it.** Re-bless the baseline —',
      `   \`pnpm rpa sentinel ${evidence.probeId} --bless --note "<why>"\` — and add a drift-log row`,
      '   saying what moved. A note is required; a baseline blessed without one is',
      '   indistinguishable from one blessed to make a check go green.',
      '',
      'Either way the drift log gets a row. An entry that only says "fixed the locator" is not an',
      'entry: column 3 must say what the **portal** does.',
    ].join('\n'),
  );

  sections.push(fingerprintMarker(triage.fingerprint));

  return `${sections.join('\n\n')}\n`;
}

function renderScreens(evidence: ProbeEvidence): string {
  if (evidence.screens.length === 0) {
    return ['## Screens', '', 'None were read — the probe failed before reaching one.'].join('\n');
  }

  const out: string[] = ['## Screens'];

  for (const screen of evidence.screens) {
    out.push(
      '',
      `### \`${screen.screenId}\` — baseline **${screen.baseline}**`,
      '',
      `\`${screen.signature.location.host}${screen.signature.location.path}\`` +
        (screen.signature.location.queryKeys.length === 0
          ? ''
          : ` (query keys: ${screen.signature.location.queryKeys.map((key) => `\`${key}\``).join(', ')})`),
    );

    if (screen.delta === undefined || screen.delta.changes.length === 0) {
      if (screen.baseline === 'absent') {
        out.push('', 'No baseline exists for this screen, so there is nothing to compare it against.');
      }
      continue;
    }

    out.push(
      '',
      `Shape: \`${screen.delta.shape === '' ? '(no meaningful changes)' : screen.delta.shape}\``,
      '',
      '| | key | change | value |',
      '|---|---|---|---|',
      ...screen.delta.changes.map(
        (change) =>
          `| ${change.meaningful ? '**yes**' : 'no'} | ${change.key} | ${change.direction} | ${cell(change.value)} |`,
      ),
      '',
      '_The first column is whether the change would plausibly break an automation. Everything is',
      'listed either way — the judgement is a heuristic, not a fact._',
    );

    const noise = screen.delta.changes.filter((change) => !change.meaningful && change.noiseReason !== undefined);
    if (noise.length > 0) {
      out.push('', ...noise.map((change) => `- \`${cell(change.value)}\` — ${change.noiseReason}`));
    }
  }

  return out.join('\n');
}

function renderPriorArt(input: IssueBodyInput): string {
  if (input.priorArt.length === 0) {
    return [
      '## Prior art',
      '',
      `Nothing in \`${input.driftLogPath}\` matched this finding. Read the log anyway before`,
      'changing a locator — it holds around a hundred rows of what this portal actually does,',
      'including several that retract an earlier and wrong diagnosis of the same failure.',
    ].join('\n');
  }

  return [
    '## Prior art from the drift log',
    '',
    `The closest rows in \`${input.driftLogPath}\`. **Read these before changing a locator.**`,
    '',
    '| Line | Date | Documented | What the portal actually does | What the automation does now |',
    '|---|---|---|---|---|',
    ...input.priorArt.map(
      (row) =>
        `| ${row.line} | ${row.date} | ${cell(row.documented)} | ${cell(row.actual)} | ${cell(row.now)} |`,
    ),
    '',
    '_This log retracts wrong diagnoses by name — one failure has three successive readings, the',
    'first two explicitly wrong. A retraction is a contribution; a guess presented as a fix is not._',
  ].join('\n');
}

/** Markdown table cells cannot contain a raw pipe or a newline. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Reports the first line that still carries a known secret value.
 *
 * Line-granular rather than whole-body, so the message says where to look.
 */
function firstLeakingLine(body: string, redactor: Redactor): string | undefined {
  for (const [index, line] of body.split('\n').entries()) {
    if (redactor.leaks(line)) return `line ${index + 1}`;
  }
  return undefined;
}

function firstDrifted(evidence: ProbeEvidence): string | undefined {
  return evidence.screens.find((screen) => screen.delta?.meaningful === true)?.screenId;
}

function firstUnbaselined(evidence: ProbeEvidence): string | undefined {
  return evidence.screens.find((screen) => screen.baseline === 'absent')?.screenId;
}
