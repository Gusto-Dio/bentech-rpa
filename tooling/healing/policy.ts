/**
 * What an unattended repair session is allowed to do.
 *
 * ── WHY THIS IS CODE AND NOT A SETTINGS FILE ────────────────────────────────
 * `.claude/settings.local.json` is gitignored: per-machine, invisible to review,
 * and prone to silent widening on an always-on host. The failure mode of
 * settings-based permissions is that they get broader and nobody notices.
 *
 * As a function, the policy gets what everything else load-bearing in this repo
 * gets - a regression test. `policy.test.ts` asserts that
 * `pnpm check; pnpm rpa run group-submission/anthem-ca-new-plans` is denied.
 * A JSON allow-list cannot carry that assertion, and this is a repo where one
 * forbidden command creates a real account and a real quote on a production
 * carrier portal.
 *
 * ── THE POSTURE ─────────────────────────────────────────────────────────────
 * Deny wins. Unknown is deny. Every decision carries a reason, and the reason
 * is returned to the agent on a denial - an agent that does not know WHY it was
 * blocked will try three variants of the same forbidden thing, and
 * `maxDeniedInARow` then turns that into an escalation rather than a loop.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface PolicyDecision {
  allowed: boolean;
  /** Returned to the agent verbatim on a denial, so it can escalate honestly. */
  reason: string;
  /** Which rule decided, for the transcript. */
  ruleId: string;
}

const allow = (ruleId: string, reason = 'permitted'): PolicyDecision => ({ allowed: true, reason, ruleId });
const deny = (ruleId: string, reason: string): PolicyDecision => ({ allowed: false, reason, ruleId });

/** The one automation a heal is scoped to. Everything path-shaped is relative to it. */
export const HEALING_SCOPE = {
  automationId: 'group-submission/anthem-ca-new-plans',
  automationDir: 'automations/group-submission/anthem-ca-new-plans',
} as const;

// ── Tools ───────────────────────────────────────────────────────────────────

/**
 * MCP verbs that READ. Navigation is allowed; everything that mutates is not.
 *
 * Rule 10a permits signing in and navigating, and the browser this drives holds
 * a live production broker session under a real licensed producer's licence. A
 * click is a write as far as that portal is concerned.
 */
export const ALLOWED_TOOLS: readonly string[] = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite', 'Task',
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_network_requests',
  'mcp__playwright__browser_wait_for',
  'mcp__playwright__browser_find',
  'mcp__playwright__browser_resize',
  'mcp__playwright__browser_tabs',
];

/**
 * Named explicitly rather than left to fall through the allow-list, so the
 * denial is auditable and a future maintainer adding an MCP verb has to make a
 * decision rather than inherit one.
 */
export const DENIED_TOOLS: readonly (readonly [string, string])[] = [
  ['mcp__playwright__browser_click', 'a click is a write on a production portal (rule 10a)'],
  ['mcp__playwright__browser_type', 'typing into a live form is a write'],
  ['mcp__playwright__browser_fill_form', 'filling a live form is a write'],
  ['mcp__playwright__browser_press_key', 'Enter submits'],
  ['mcp__playwright__browser_select_option', 'selecting changes portal state'],
  ['mcp__playwright__browser_drag', 'a drag is a write'],
  ['mcp__playwright__browser_drop', 'a drop is a write'],
  ['mcp__playwright__browser_hover', 'hover fires the portal\'s own handlers'],
  ['mcp__playwright__browser_file_upload', 'an upload attaches a real document to a real application'],
  ['mcp__playwright__browser_handle_dialog', 'accepting a dialog confirms whatever it was asking'],
  [
    'mcp__playwright__browser_evaluate',
    'arbitrary JavaScript in a signed-in production page can do anything a click can, and more',
  ],
  ['mcp__playwright__browser_run_code_unsafe', 'the name is the argument'],
  ['WebFetch', 'no egress from a session holding live carrier credentials'],
  ['WebSearch', 'no egress from a session holding live carrier credentials'],
  ['NotebookEdit', 'there are no notebooks in this repo'],
];

export function decideTool(name: string): PolicyDecision {
  const denied = DENIED_TOOLS.find(([tool]) => tool === name);
  if (denied !== undefined) return deny('tool.denied', denied[1]);
  if (ALLOWED_TOOLS.includes(name)) return allow('tool.allowed');

  /**
   * Unknown is deny, and the message says so rather than pretending the tool
   * does not exist. A new MCP server appearing on the host must not silently
   * widen what an unattended agent can reach.
   */
  return deny(
    'tool.unknown',
    `"${name}" is not on the healing allow-list. Unknown tools are denied rather than assumed ` +
      'safe. If this tool is genuinely needed, that is an escalation for a human to decide.',
  );
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** These files ARE the credential. Reading one is exfiltration, not research. */
export const READ_DENY: readonly (readonly [RegExp, string])[] = [
  [/^\.env($|\.)/, '.env holds live carrier credentials'],
  [/(^|\/)data\/sessions\//, 'a session file is credential-equivalent: anyone holding it has the account'],
  [/(^|\/)data\/profiles\//, 'a browser profile holds a live signed-in Google session'],
  [/(^|\/)certs\/.*\.(crt|pem|key)$/, 'private key material'],
];

/**
 * Where a repair may write.
 *
 * Page objects AND step/flow definitions, inside ONE automation - plus the
 * learning-loop documents, because a repair that does not record what the
 * portal did is half a repair.
 */
export const WRITE_ALLOW: readonly RegExp[] = [
  new RegExp(`^${HEALING_SCOPE.automationDir}/src/pages/`),
  new RegExp(`^${HEALING_SCOPE.automationDir}/src/sentinel/`),
  new RegExp(`^${HEALING_SCOPE.automationDir}/src/(processTransaction|initialize|endProcess|gate-evidence|derived|payload|session)\\.ts$`),
  new RegExp(`^${HEALING_SCOPE.automationDir}/src/census/`),
  new RegExp(`^${HEALING_SCOPE.automationDir}/sentinel/baselines/`),
  /^docs\/poc\/anthem-ca-new-plans\/(drift-log|process-steps|field-map|open-questions)\.md$/,
  /^docs\/poc\/anthem-ca-new-plans\/evidence\//,
  /^\.tmp\/heal\//,
  /^artifacts\/heal\//,
];

export const WRITE_DENY: readonly (readonly [RegExp, string])[] = [
  // The engine, shared by every automation.
  [/^packages\//, 'packages/ is the shared engine; a repair is scoped to one automation'],
  [/^config\//, 'platform config is not a portal-drift fix'],
  [/^\.env/, 'rule 3: config holds the NAMES of environment variables, never values'],
  [/^\.claude\//, 'the thing that constrains the agent is not the agent\'s to change'],
  [/^AGENTS\.md$/, 'doctrine is proposed in a PR body and applied by a human'],
  [/^CODEOWNERS$/, 'review routing is not the agent\'s to change'],

  // The sandbox itself.
  [/^\.mcp\.json$/, 'that file defines the browser fence the agent runs inside'],
  [/^playwright-mcp.*\.json$/, 'the origin allow-list is a containment boundary'],
  [/^tooling\//, 'the harness, the verification scripts and the recon fence all live here'],
  [/^templates\//, 'a template change propagates to every future automation'],
  [/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json)$/, 'dependency and build changes are a human decision in this repo'],
  [/^(Dockerfile|docker-compose\.yml)$/, 'runtime image changes are a human decision'],

  // The guard rails. The net does not get to move.
  [new RegExp(`^${HEALING_SCOPE.automationDir}/automation\\.json$`), 'the manifest declares the queue and the probe set'],
  [new RegExp(`^${HEALING_SCOPE.automationDir}/config/`), 'automation config holds the credential env-var names and allowSubmit'],
  [new RegExp(`^${HEALING_SCOPE.automationDir}/data/seed/`), 'seed data is the test fixture, not the fix'],
  [/\.test\.ts$/, 'the tests are the regression net that proves the repair; they are not part of it'],

  /**
   * The five supervised live-fire drivers. Each hardcodes `allowSubmit: true`
   * and can file a real application. They are gitignored precisely so nothing
   * that can do that lives in a clone.
   */
  [/(reach-signature|resume-signature|lock-and-look|sig-format|sig-signatory)\.ts$/, 'a supervised live-fire driver that can file a real application'],
  [/^docs\/poc\/anthem-ca-new-plans\/production-cleanup\.md$/, 'the record of what the PoC left on production is not the agent\'s to edit'],
];

export function decideWrite(repoRelativePath: string): PolicyDecision {
  const normalized = repoRelativePath.replace(/^\.\//, '');

  /** Deny first, always. A path matching both lists is denied. */
  const denied = WRITE_DENY.find(([pattern]) => pattern.test(normalized));
  if (denied !== undefined) return deny('write.denied', `${normalized}: ${denied[1]}`);

  if (WRITE_ALLOW.some((pattern) => pattern.test(normalized))) return allow('write.allowed');

  return deny(
    'write.out-of-scope',
    `${normalized} is outside the healing scope (${HEALING_SCOPE.automationDir} plus its drift log). ` +
      'If the fix genuinely belongs there, that is an escalation: comment the diagnosis and the ' +
      'proposed patch on the issue instead of applying it.',
  );
}

export function decideRead(repoRelativePath: string): PolicyDecision {
  const normalized = repoRelativePath.replace(/^\.\//, '');
  const denied = READ_DENY.find(([pattern]) => pattern.test(normalized));
  if (denied !== undefined) return deny('read.denied', `${normalized}: ${denied[1]}`);
  return allow('read.allowed');
}

// ── Content and diff ────────────────────────────────────────────────────────

/**
 * Applied to the PROPOSED text, before it reaches disk.
 *
 * Catching `allowSubmit: true` after the fact is worth much less than it never
 * being written: a working tree with that in it is one `pnpm rpa run` away from
 * a real signed application.
 */
export const CONTENT_DENY: readonly { pattern: RegExp; reason: string; appliesTo?: RegExp }[] = [
  { pattern: /allowSubmit\s*[:=]\s*true/, reason: 'rule 10: allowSubmit stays false. Do not flip it to verify something - ask.' },
  { pattern: /ignoreHTTPSErrors/, reason: 'AGENTS.md lists it as deliberately absent: it disables certificate validation for runs that sign in to carrier portals with real credentials' },
  { pattern: /\/\/\/|xpath=|\bXPath\b/i, reason: 'rule 5: no XPath anywhere' },
  {
    pattern: /\.isVisible\(\)/,
    appliesTo: new RegExp(`^${HEALING_SCOPE.automationDir}/src/pages/`),
    reason: 'rule 9b: isVisible() does not wait. It has already failed a precondition on a dashboard that was still painting. Use visible() from @rpa/core',
  },
  { pattern: /--no-sandbox|dangerously/, reason: 'not a repair' },
  {
    pattern: /mfaTimeoutMs|mfaResendAfterMs|mfaMaxResends/,
    reason: 'the MFA timeouts were tuned twice against a broken reader and both readings were wrong. A code that does not arrive means something is broken; a longer timeout hides it',
  },
  { pattern: /is:unread/, reason: 'rule 10b: `is:unread` matched 0 of 21 labelled messages, because the mailbox filter marks mail read on arrival' },
];

export function decideContent(repoRelativePath: string, proposed: string): PolicyDecision {
  const normalized = repoRelativePath.replace(/^\.\//, '');

  for (const rule of CONTENT_DENY) {
    if (rule.appliesTo !== undefined && !rule.appliesTo.test(normalized)) continue;
    if (rule.pattern.test(proposed)) {
      return deny('content.denied', `${normalized}: ${rule.reason}`);
    }
  }

  return allow('content.allowed');
}

/**
 * Diff-shaped denials.
 *
 * These are the classic autohealer pathologies: the ladder goes green because a
 * check was removed. Each has already caused a worse failure here than the one
 * it hid.
 */
export const DIFF_DENY: readonly { id: string; test: (diff: string) => boolean; reason: string }[] = [
  {
    id: 'removes-a-precondition',
    test: (diff) => /^-\s*precondition\s*:/m.test(diff),
    reason: 'AGENTS.md rule 9: do not "fix" a failing precondition by deleting it. A precondition that fails means we are not on the screen we thought',
  },
  {
    id: 'adds-alwaysRun',
    test: (diff) => /^\+.*alwaysRun\s*:\s*true/m.test(diff),
    reason: 'alwaysRun on the wrong step disables the resume check that makes a re-driven submission safe. A human decides this',
  },
  {
    id: 'raises-a-timeout',
    test: (diff) => {
      const added = [...diff.matchAll(/^\+.*?timeoutMs\s*:\s*(\d[\d_]*)/gm)].map((m) => Number((m[1] ?? '0').replace(/_/g, '')));
      const removed = [...diff.matchAll(/^-.*?timeoutMs\s*:\s*(\d[\d_]*)/gm)].map((m) => Number((m[1] ?? '0').replace(/_/g, '')));
      return added.length > 0 && removed.length > 0 && Math.max(...added) > Math.max(...removed);
    },
    reason: 'raising a timeout to make a check pass hides the broken thing rather than fixing it. If the screen is genuinely slow, say so and escalate',
  },
  {
    id: 'deletes-a-test',
    test: (diff) => /^-{3}\s+a\/.*\.test\.ts$/m.test(diff) && /^\+{3}\s+\/dev\/null$/m.test(diff),
    reason: 'the tests are the regression net that proves the repair',
  },
  {
    id: 'changes-a-classification',
    test: (diff) =>
      /^-.*\bSystemException\b/m.test(diff) && /^\+.*\bBusinessException\b/m.test(diff) ||
      /^-.*\bBusinessException\b/m.test(diff) && /^\+.*\bSystemException\b/m.test(diff),
    reason: 'rule 1 is the contract everything hinges on. Getting it backwards either burns three browser relaunches on a rule that will never change its mind, or silently abandons real work. A classification change needs a stated reason and a human',
  },
];

export function decideDiff(diff: string): PolicyDecision {
  const matched = DIFF_DENY.find((rule) => rule.test(diff));
  if (matched !== undefined) return deny(`diff.${matched.id}`, matched.reason);
  return allow('diff.allowed');
}

// ── Bash ────────────────────────────────────────────────────────────────────

/**
 * ── THE STRUCTURAL GATE, AND WHY IT COMES FIRST ─────────────────────────────
 * A prefix allow-list is trivially bypassed:
 *
 *   pnpm check; pnpm rpa run group-submission/anthem-ca-new-plans
 *
 * starts with an allowed prefix and ends by creating a real account and a real
 * quote on a production carrier portal. So any command containing shell
 * metacharacters is denied OUTRIGHT unless it matches one of the few compound
 * pipelines we explicitly permit, verbatim.
 *
 * This is the single most important function in the file.
 */
export const FORBIDDEN_SHELL_SYNTAX: readonly string[] = [';', '&&', '||', '|', '`', '$(', '>', '>>', '<', '\n', '&'];

/** The only compound commands permitted, matched whole after whitespace normalisation. */
export const EXACT_PIPELINES: readonly string[] = [
  // The documented orphan-browser sweep. Named in AGENTS.md's gotcha table.
  `ps -Ao pid=,command= | grep "user-data-dir=.*data/profiles" | awk '{print $1}' | xargs kill`,
];

export const BASH_ALLOW: readonly RegExp[] = [
  /^pnpm (typecheck|validate|test|check)$/,
  /^pnpm rpa (list|doctor|validate)( --env (dev|staging|prod))?$/,
  /^pnpm rpa sentinel --list$/,
  /^pnpm rpa sentinel [a-z0-9-]+\/[a-z0-9-]+( --dry-run)?$/,
  /^pnpm rpa queue group-submission\/carrier-portal-submission-demo( --reset)?$/,
  // saucedemo. Safe to write to, and the only end-to-end rung available.
  /^pnpm rpa run group-submission\/carrier-portal-submission-demo$/,
  /^pnpm rpa mfa check --label "Access Token \(Anthem\)"( --diagnose)?$/,
  /^pnpm tsx tooling\/scripts\/check-portal-access\.ts$/,
  /^pnpm tsx tooling\/scripts\/check-portal-navigation\.ts$/,
  /^pnpm tsx tooling\/scripts\/anthem-serve\.ts$/,
  /^pnpm tsx tooling\/scripts\/anthem-verify-locators\.ts .{1,200}$/,
  /^pnpm tsx tooling\/scripts\/anthem-verify-checklist\.ts .{0,160}$/,
  /^pnpm tsx tooling\/scripts\/capture-masked-pair\.ts .{1,300}$/,
  /^pnpm tsx tooling\/scripts\/check-masked-evidence\.ts .{1,240}$/,
  /^pnpm tsx tooling\/scripts\/screen-baseline\.ts (write|diff) .{1,200}$/,
  /^pkill -f anthem-serve$/,
  /^git (status|diff|diff --staged|log --oneline -\d{1,3}|show [0-9a-f]{7,40})( -- .{1,200})?$/,
  /^git add -- .{1,300}$/,
  // Message via file: no shell metacharacters can reach a commit message.
  /^git commit -F \.tmp\/heal\/commit-msg\.txt$/,
  /^git switch -c heal\/\d+-[a-z0-9-]{1,60}$/,
  /^git push -u origin heal\/\d+-[a-z0-9-]{1,60}$/,
  /^gh issue view \d+( --json [a-zA-Z,]+)?$/,
  /^gh issue comment \d+ -F \.tmp\/heal\/comment\.md$/,
  /^gh pr create --draft --base main --head heal\/\d+-[a-z0-9-]{1,60} --title .{1,200} -F \.tmp\/heal\/pr-body\.md( --label [a-z:-]+)*$/,
  /^gh pr view \d+( --json [a-zA-Z,]+)?$/,
  // Read-only shapes.
  /^(ls|cat|head|tail|wc|find|rg|grep|sed -n) .{0,300}$/,
];

export const BASH_DENY: readonly (readonly [RegExp, string])[] = [
  [
    /\brpa\s+run\s+group-submission\/anthem-ca-new-plans\b/,
    'AGENTS.md rule 10a: ANTHEM PRODUCTION IS FROZEN since 2026-09-04. A run creates a real account ' +
      'and a real quote at ANY allowSubmit setting. You cannot verify a fix this way - use the ' +
      'verification ladder, and escalate on the issue if it is not enough.',
  ],
  [
    /\brpa\s+run\s+group-submission\/uhc-np-new-plans\b/,
    'the second carrier PoC, also a production portal, where attestation is irreversible',
  ],
  [/\brpa\s+mfa\s+probe\b/, 'mfa probe CONSUMES a real one-time code'],
  [/\brpa\s+mfa\s+seed-profile\b/, 'seed-profile needs a human at a display'],
  [/\bgh\s+pr\s+merge\b/, 'the healer never merges. CODEOWNERS review is the gate'],
  [/\bgh\s+pr\s+ready\b/, 'draft status is part of the human gate'],
  [/--force|--force-with-lease|reset\s+--hard|\brebase\b|filter-branch/, 'history is not the healer\'s to rewrite'],
  [/\bgit\s+push\b.*\b(main|master)\b/, 'main is protected and is not a push target'],
  [/\b(curl|wget|nc|ncat|ssh|scp|rsync|base64|openssl)\b/, 'no egress from a host holding live carrier credentials'],
  [/\b(sudo|su|chmod|chown|eval|export)\b|\b(sh|bash|zsh)\s+-c\b/, 'not a repair'],
  [/\bdocker\b/, 'container parity is a human rung; it is listed in the PR as requiring the reviewer'],
  [/\b(npm|npx|yarn)\b|\bpnpm\s+(add|install|remove|update|dlx)\b/, 'dependency changes are a human decision in this repo'],
  [/\.env\b|data\/sessions|data\/profiles/, 'credential-equivalent: never read, printed, copied or diffed'],
  [/reach-signature|resume-signature|lock-and-look|sig-format|sig-signatory/, 'a supervised live-fire driver that can file a real application'],
  [/\bpkill\b(?!\s+-f\s+anthem-serve$)/, 'only the documented recon-browser kill is permitted'],
];

export function decideBash(command: string): PolicyDecision {
  const normalized = command.trim().replace(/\s+/g, ' ');

  /**
   * ── ORDER, AND WHY THE EXACT LIST IS FIRST ────────────────────────────────
   * `EXACT_PIPELINES` is a whole-string match against a one-entry curated list,
   * so nothing can slip through it - and it has to precede the deny patterns
   * because the documented orphan-browser sweep legitimately MENTIONS
   * `data/profiles` in its grep argument. The credential-path deny rule would
   * otherwise refuse the one cleanup command AGENTS.md tells you to run, which
   * is how a policy gets a reputation for being wrong and then gets widened.
   *
   * The sweep matches process command lines; it never reads a profile.
   */
  if (EXACT_PIPELINES.some((pipeline) => normalized === pipeline.replace(/\s+/g, ' '))) {
    return allow('bash.pipeline', 'the documented orphan-browser sweep');
  }

  /**
   * Deny patterns next, before the structural gate, so the reason a reader gets
   * is the specific one ("rule 10a") rather than the generic "contains a
   * semicolon". An agent told the real reason escalates; an agent told a syntax
   * complaint tries again without the semicolon.
   */
  const denied = BASH_DENY.find(([pattern]) => pattern.test(normalized));
  if (denied !== undefined) return deny('bash.denied', denied[1]);

  const syntax = FORBIDDEN_SHELL_SYNTAX.find((token) => normalized.includes(token));
  if (syntax !== undefined) {
    return deny(
      'bash.compound',
      `the command contains "${syntax}", so it is more than one command. Compound commands are ` +
        'refused because an allow-list on the first verb says nothing about the second: ' +
        '`pnpm check; pnpm rpa run ...` starts with something permitted and ends by creating a ' +
        'real quote on a production portal. Run the steps one at a time.',
    );
  }

  if (BASH_ALLOW.some((pattern) => pattern.test(normalized))) return allow('bash.allowed');

  return deny(
    'bash.unknown',
    `"${normalized}" is not on the healing allow-list. Unknown commands are denied rather than ` +
      'assumed safe. If it is genuinely needed, escalate rather than looking for a variant that ' +
      'slips through.',
  );
}

// ── MCP containment ─────────────────────────────────────────────────────────

/**
 * A NARROWER copy of the repo's origin allow-list: the three Anthem hosts, and
 * not saucedemo. A repair session has no business on the demo portal, and the
 * narrower the fence the less there is to reason about.
 *
 * Asserted against the file at startup - a mismatch aborts the heal, because a
 * widened fence is exactly the change an agent would make to get past a block.
 */
export const HEALING_MCP_ORIGINS: readonly string[] = [
  'https://brokerportal.anthem.com',
  'https://login.broker.anthem.com',
  'https://elevancehealthfulcrum.my.site.com',
];

// ── Budgets ─────────────────────────────────────────────────────────────────

export const BUDGETS = {
  wallClockMs: 90 * 60_000,
  maxPrompts: 60,
  /** Three fights with the wall is an escalation, not persistence. */
  maxDeniedInARow: 3,
  maxEditedFiles: 6,
  maxDiffLines: 300,
  reconBrowserMaxLifetimeMs: 60 * 60_000,
} as const;
