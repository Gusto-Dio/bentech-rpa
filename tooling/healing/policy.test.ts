import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  BUDGETS,
  HEALING_MCP_ORIGINS,
  decideBash,
  decideContent,
  decideDiff,
  decideRead,
  decideTool,
  decideWrite,
} from './policy.ts';

/**
 * The regression net that a settings file could not carry.
 *
 * This is the whole argument for expressing the policy as code: every rule
 * below is a specific way an unattended agent could reach something it must
 * not, and each one is now a test rather than a hope.
 */

const AUTO = 'automations/group-submission/anthem-ca-new-plans';

describe('the production freeze', () => {
  /**
   * THE MOST IMPORTANT TEST IN THE REPOSITORY'S HEALING LAYER.
   *
   * Rule 10a: a run creates a real account and a real quote on Anthem's
   * production portal at ANY allowSubmit setting. Every shape below has to be
   * refused, and the compound form is the one a naive prefix allow-list lets
   * straight through.
   */
  const forbidden: readonly string[] = [
    'pnpm rpa run group-submission/anthem-ca-new-plans',
    'pnpm --silent rpa run group-submission/anthem-ca-new-plans',
    'pnpm check; pnpm rpa run group-submission/anthem-ca-new-plans',
    'pnpm check && pnpm rpa run group-submission/anthem-ca-new-plans',
    'pnpm test || pnpm rpa run group-submission/anthem-ca-new-plans',
    'echo go | pnpm rpa run group-submission/anthem-ca-new-plans',
    'node --import tsx packages/cli/src/main.ts run group-submission/anthem-ca-new-plans',
    'pnpm rpa run group-submission/anthem-ca-new-plans --provider local',
    'APP_ENV=dev pnpm rpa run group-submission/anthem-ca-new-plans',
  ];

  for (const command of forbidden) {
    it(`refuses: ${command}`, () => {
      const decision = decideBash(command);
      assert.equal(decision.allowed, false, `MUST be denied: ${command}`);
    });
  }

  /** And the reason must name the rule, so the agent escalates rather than retries. */
  it('explains the refusal in terms of rule 10a, not shell syntax', () => {
    const decision = decideBash('pnpm rpa run group-submission/anthem-ca-new-plans');
    assert.match(decision.reason, /rule 10a/);
    assert.match(decision.reason, /real account and a real quote/);
    assert.match(decision.reason, /cannot verify a fix this way/);
  });

  it('refuses the second carrier too', () => {
    assert.equal(decideBash('pnpm rpa run group-submission/uhc-np-new-plans').allowed, false);
  });

  /** The demo automation writes to saucedemo, which is safe, and is a real ladder rung. */
  it('permits the reference automation on saucedemo', () => {
    assert.equal(decideBash('pnpm rpa run group-submission/carrier-portal-submission-demo').allowed, true);
  });
});

describe('decideBash - the structural gate', () => {
  /**
   * An allow-list on the first verb says nothing about the second. This is the
   * bypass that makes prefix matching unsafe, and the message has to say so or
   * the agent will simply drop the semicolon and try again.
   */
  it('refuses any compound command', () => {
    for (const command of ['pnpm check; ls', 'pnpm check && ls', 'ls | wc -l', 'ls > out.txt', 'echo `ls`', 'echo $(ls)']) {
      assert.equal(decideBash(command).allowed, false, `must be denied: ${command}`);
    }
  });

  it('explains WHY a compound command is refused', () => {
    const decision = decideBash('pnpm check; pnpm typecheck');
    assert.equal(decision.ruleId, 'bash.compound');
    assert.match(decision.reason, /more than one command/);
    assert.match(decision.reason, /Run the steps one at a time/);
  });

  /** The one documented pipeline, because AGENTS.md names it as the orphan sweep. */
  it('permits the documented orphan-browser sweep verbatim', () => {
    const sweep = `ps -Ao pid=,command= | grep "user-data-dir=.*data/profiles" | awk '{print $1}' | xargs kill`;
    assert.equal(decideBash(sweep).allowed, true);
  });

  it('does not permit a variant of that pipeline', () => {
    assert.equal(
      decideBash(`ps -Ao pid=,command= | grep "user-data-dir=.*data/profiles" | awk '{print $1}' | xargs rm`).allowed,
      false,
    );
  });

  it('denies an unknown command rather than assuming it is safe', () => {
    const decision = decideBash('some-new-tool --do-a-thing');
    assert.equal(decision.allowed, false);
    assert.equal(decision.ruleId, 'bash.unknown');
    assert.match(decision.reason, /escalate rather than looking for a variant/);
  });
});

describe('decideBash - the rest of the boundary', () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ['pnpm check', true],
    ['pnpm test', true],
    ['pnpm typecheck', true],
    ['pnpm rpa validate', true],
    ['pnpm rpa sentinel --list', true],
    ['pnpm rpa sentinel anthem-ca/portal-access', true],
    ['pnpm tsx tooling/scripts/check-portal-access.ts', true],
    ['pnpm tsx tooling/scripts/check-portal-navigation.ts', true],
    ['pkill -f anthem-serve', true],
    ['git status', true],
    ['git diff', true],
    ['gh issue view 412 --json body', true],

    // Never.
    ['gh pr merge 9', false],
    ['gh pr ready 9', false],
    ['git push --force origin heal/412-x', false],
    ['git push -u origin main', false],
    ['git rebase -i HEAD~3', false],
    ['curl https://example.com', false],
    ['base64 .env', false],
    ['cat .env', false],
    ['cat data/sessions/anthem-ca.json', false],
    ['sudo rm -rf /', false],
    ['docker compose run --rm rpa echo hi', false],
    ['pnpm add some-package', false],
    ['npx playwright codegen', false],
    ['pnpm rpa mfa probe --label "Access Token (Anthem)"', false],
    ['pnpm rpa mfa seed-profile --account x@y.com', false],
    ['pnpm tsx automations/group-submission/anthem-ca-new-plans/reach-signature.ts', false],
    ['pkill -f chromium', false],
  ];

  for (const [command, expected] of cases) {
    it(`${expected ? 'permits' : 'refuses'}: ${command}`, () => {
      assert.equal(decideBash(command).allowed, expected);
    });
  }

  /** A commit message travels by file so no shell metacharacter can reach it. */
  it('permits a commit only with a message file', () => {
    assert.equal(decideBash('git commit -F .tmp/heal/commit-msg.txt').allowed, true);
    assert.equal(decideBash('git commit -m "fix"').allowed, false);
  });

  it('permits only a draft pull request', () => {
    const draft =
      'gh pr create --draft --base main --head heal/412-county-picker --title "Anthem: re-map the county picker" -F .tmp/heal/pr-body.md --label autoheal';
    assert.equal(decideBash(draft).allowed, true);

    const notDraft = draft.replace('--draft ', '');
    assert.equal(decideBash(notDraft).allowed, false);
  });
});

describe('decideTool', () => {
  it('permits the read-only browser verbs', () => {
    for (const tool of [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_snapshot',
      'mcp__playwright__browser_take_screenshot',
    ]) {
      assert.equal(decideTool(tool).allowed, true, tool);
    }
  });

  /**
   * A click is a write as far as a production carrier portal is concerned, and
   * this browser holds a live session under a real licensed producer's licence.
   */
  it('refuses every browser verb that mutates', () => {
    for (const tool of [
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_type',
      'mcp__playwright__browser_fill_form',
      'mcp__playwright__browser_press_key',
      'mcp__playwright__browser_select_option',
      'mcp__playwright__browser_file_upload',
      'mcp__playwright__browser_handle_dialog',
      'mcp__playwright__browser_evaluate',
      'mcp__playwright__browser_run_code_unsafe',
    ]) {
      assert.equal(decideTool(tool).allowed, false, tool);
    }
  });

  it('refuses egress tools outright', () => {
    assert.equal(decideTool('WebFetch').allowed, false);
    assert.equal(decideTool('WebSearch').allowed, false);
    assert.match(decideTool('WebFetch').reason, /no egress/);
  });

  /** A new MCP server on the host must not silently widen what an agent can reach. */
  it('denies an unknown tool', () => {
    const decision = decideTool('mcp__something__new_verb');
    assert.equal(decision.allowed, false);
    assert.equal(decision.ruleId, 'tool.unknown');
  });
});

describe('decideWrite', () => {
  const allowed: readonly string[] = [
    `${AUTO}/src/pages/group-setup.page.ts`,
    `${AUTO}/src/pages/read-screen.ts`,
    `${AUTO}/src/processTransaction.ts`,
    `${AUTO}/src/initialize.ts`,
    `${AUTO}/src/sentinel/probes.ts`,
    `${AUTO}/sentinel/baselines/ptb-dashboard.json`,
    'docs/poc/anthem-ca-new-plans/drift-log.md',
    'docs/poc/anthem-ca-new-plans/evidence/heal-412/county.before.masked.png',
    '.tmp/heal/pr-body.md',
  ];

  for (const file of allowed) {
    it(`permits ${file}`, () => {
      assert.equal(decideWrite(file).allowed, true, decideWrite(file).reason);
    });
  }

  const denied: readonly string[] = [
    'packages/core/src/steps.ts',
    'config/platform.json',
    `${AUTO}/config/config.dev.json`,
    `${AUTO}/automation.json`,
    '.env',
    '.claude/settings.local.json',
    'AGENTS.md',
    'CODEOWNERS',
    // The sandbox itself. This is the change an agent would make to get past a block.
    '.mcp.json',
    'playwright-mcp.config.json',
    'playwright-mcp.healing.json',
    'tooling/healing/policy.ts',
    'tooling/scripts/anthem-recon.ts',
    'package.json',
    'docker-compose.yml',
    // The net does not get to move.
    `${AUTO}/src/pages/login.page.test.ts`,
    'docs/poc/anthem-ca-new-plans/production-cleanup.md',
  ];

  for (const file of denied) {
    it(`refuses ${file}`, () => {
      assert.equal(decideWrite(file).allowed, false, `must be denied: ${file}`);
    });
  }

  it('refuses a path outside the scope with a pointer to escalation', () => {
    const decision = decideWrite('automations/group-submission/uhc-np-new-plans/src/pages/login.page.ts');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /outside the healing scope/);
    assert.match(decision.reason, /that is an escalation/);
  });

  /** Deny wins over allow, so a new allow pattern cannot accidentally unlock a test file. */
  it('denies a path matching both lists', () => {
    assert.equal(decideWrite(`${AUTO}/src/pages/masks.test.ts`).allowed, false);
  });
});

describe('decideRead', () => {
  it('refuses the files that ARE the credential', () => {
    for (const file of ['.env', '.env.local', 'data/sessions/anthem-ca.json', 'data/profiles/gmail-mfa/Cookies', 'certs/corp.pem']) {
      assert.equal(decideRead(file).allowed, false, file);
    }
  });

  it('permits ordinary source and docs', () => {
    assert.equal(decideRead(`${AUTO}/src/pages/login.page.ts`).allowed, true);
    assert.equal(decideRead('AGENTS.md').allowed, true, 'reading doctrine is encouraged; writing it is not');
  });
});

describe('decideContent - caught before it reaches disk', () => {
  /**
   * Detecting `allowSubmit: true` after the fact is worth much less than it
   * never being written: a working tree containing it is one command away from
   * a real signed application.
   */
  it('refuses flipping allowSubmit, in either syntax', () => {
    for (const text of ['allowSubmit: true', 'allowSubmit = true', 'const x = { allowSubmit:true }']) {
      const decision = decideContent(`${AUTO}/src/processTransaction.ts`, text);
      assert.equal(decision.allowed, false, text);
      assert.match(decision.reason, /rule 10/);
    }
  });

  it('refuses ignoreHTTPSErrors', () => {
    assert.equal(decideContent(`${AUTO}/src/pages/login.page.ts`, 'ignoreHTTPSErrors: true').allowed, false);
  });

  it('refuses XPath', () => {
    assert.equal(decideContent(`${AUTO}/src/pages/x.page.ts`, "page.locator('xpath=//div')").allowed, false);
  });

  /** Rule 9b, and scoped to page objects because isVisible() is fine outside a gate. */
  it('refuses isVisible() in a page object', () => {
    const inPage = decideContent(`${AUTO}/src/pages/x.page.ts`, 'await thing.isVisible()');
    assert.equal(inPage.allowed, false);
    assert.match(inPage.reason, /rule 9b/);

    const elsewhere = decideContent(`${AUTO}/src/processTransaction.ts`, 'await thing.isVisible()');
    assert.equal(elsewhere.allowed, true);
  });

  it('refuses re-tuning the MFA timeouts', () => {
    const decision = decideContent(`${AUTO}/src/pages/login.page.ts`, 'mfaTimeoutMs: 900_000');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /tuned twice against a broken reader/);
  });

  it('permits an ordinary locator change', () => {
    assert.equal(
      decideContent(`${AUTO}/src/pages/x.page.ts`, "page.getByRole('button', { name: 'Continue' })").allowed,
      true,
    );
  });
});

describe('decideDiff - the autohealer pathologies', () => {
  it('refuses removing a precondition', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '-      precondition: () => visible(thing),'].join('\n');
    const decision = decideDiff(diff);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /do not "fix" a failing precondition by deleting it/);
  });

  it('refuses adding alwaysRun', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '+      alwaysRun: true,'].join('\n');
    assert.equal(decideDiff(diff).allowed, false);
  });

  it('refuses raising a timeout', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '-      timeoutMs: 20_000,', '+      timeoutMs: 300_000,'].join('\n');
    const decision = decideDiff(diff);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /hides the broken thing/);
  });

  it('permits LOWERING a timeout, which hides nothing', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '-      timeoutMs: 300_000,', '+      timeoutMs: 20_000,'].join('\n');
    assert.equal(decideDiff(diff).allowed, true);
  });

  it('refuses deleting a test file', () => {
    const diff = ['--- a/x.test.ts', '+++ /dev/null'].join('\n');
    assert.equal(decideDiff(diff).allowed, false);
  });

  /** Rule 1 is the contract everything hinges on; a change to it needs a human. */
  it('refuses changing an exception classification in either direction', () => {
    const toBusiness = ['-    throw new SystemException(msg);', '+    throw new BusinessException(msg);'].join('\n');
    const toSystem = ['-    throw new BusinessException(msg);', '+    throw new SystemException(msg);'].join('\n');

    assert.equal(decideDiff(toBusiness).allowed, false);
    assert.equal(decideDiff(toSystem).allowed, false);
    assert.match(decideDiff(toBusiness).reason, /rule 1 is the contract/);
  });

  it('permits an ordinary locator diff', () => {
    const diff = [
      '--- a/x.page.ts',
      '+++ b/x.page.ts',
      "-    return page.getByLabel('Group County');",
      "+    return page.getByRole('combobox', { name: 'Group County' });",
    ].join('\n');
    assert.equal(decideDiff(diff).allowed, true);
  });
});

describe('MCP containment', () => {
  /**
   * Narrower than the repo's own fence: the three Anthem hosts, and not
   * saucedemo. A repair session has no business on the demo portal.
   */
  it('lists exactly the three Anthem hosts', () => {
    assert.deepEqual([...HEALING_MCP_ORIGINS], [
      'https://brokerportal.anthem.com',
      'https://login.broker.anthem.com',
      'https://elevancehealthfulcrum.my.site.com',
    ]);
  });

  it('is a subset of the repository fence, never wider', () => {
    const repoRoot = path.join(import.meta.dirname, '..', '..');
    const config = JSON.parse(readFileSync(path.join(repoRoot, 'playwright-mcp.config.json'), 'utf8')) as {
      network: { allowedOrigins: string[] };
    };

    for (const origin of HEALING_MCP_ORIGINS) {
      assert.ok(
        config.network.allowedOrigins.includes(origin),
        `${origin} must also be allowed by the repository fence, or the healing config is WIDER ` +
          'than the thing it is supposed to narrow',
      );
    }
  });
});

describe('budgets', () => {
  it('caps the blast radius of a single heal', () => {
    assert.ok(BUDGETS.maxEditedFiles <= 10);
    assert.ok(BUDGETS.maxDiffLines <= 500);
    assert.ok(BUDGETS.wallClockMs <= 2 * 60 * 60_000);
  });

  /** Three fights with the wall is an escalation, not persistence. */
  it('turns repeated denials into an escalation rather than a loop', () => {
    assert.ok(BUDGETS.maxDeniedInARow >= 2 && BUDGETS.maxDeniedInARow <= 5);
  });
});
