import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Rung 0 of the verification ladder: the mistakes this repo has already paid
 * for, as static assertions.
 *
 * ── WHY SOURCE-LEVEL ────────────────────────────────────────────────────────
 * Every one of these is a property of the CODE rather than of a run, and
 * reaching the corresponding failure on the live portal costs a real production
 * quote. `login.page.test.ts` already reads `quote-start.page.ts` as text for
 * exactly this reason, and its comment says it plainly: it is the only way to
 * pin behaviour on a code path that requires creating a real record to
 * exercise.
 *
 * A repair session must pass these before it may open a pull request, and they
 * are also the cheapest possible review of a human's change.
 */

const PAGES_DIR = import.meta.dirname;
const SRC_DIR = path.join(PAGES_DIR, '..');
const REPO_ROOT = path.join(SRC_DIR, '..', '..', '..', '..');

function sourceFiles(dir: string): readonly { name: string; source: string; body: string }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => {
      const source = readFileSync(path.join(dir, name), 'utf8');
      /**
       * Comments stripped. They legitimately DISCUSS the forbidden patterns -
       * rule 9b's explanation names `isVisible()` several times - and a guard
       * that cannot tell a warning from a use is a guard that gets disabled.
       */
      const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      return { name, source, body };
    });
}

describe('rule 5 - selectors and their shape', () => {
  it('uses no XPath anywhere in the page objects', () => {
    for (const file of sourceFiles(PAGES_DIR)) {
      assert.doesNotMatch(file.body, /xpath\s*=/i, `${file.name} uses XPath`);
      assert.doesNotMatch(file.body, /\bpage\.\$x\b/, `${file.name} uses $x`);
    }
  });

  /**
   * Generated ids carry a re-render counter - `vlocity-radio-0-1-110`,
   * `comboboxId-604`, Okta's `input60` - so a locator built on one works until
   * the next render.
   */
  it('does not target a generated id', () => {
    const generated = [/#vlocity-[a-z]+-\d/i, /#comboboxId-\d/, /#input\d{2,}/];
    for (const file of sourceFiles(PAGES_DIR)) {
      for (const pattern of generated) {
        assert.doesNotMatch(file.body, pattern, `${file.name} targets a generated id`);
      }
    }
  });
});

describe('rule 9b - gates must wait', () => {
  /**
   * `isVisible()` is Playwright's one non-waiting assertion. It has already
   * failed a precondition on a dashboard that was still painting "Loading,
   * please wait ..." - the locator was correct; the question was asked wrong.
   *
   * It stays legitimate OUTSIDE a gate, where "right now" is what you want, so
   * this checks the gate positions specifically rather than banning the call.
   */
  it('never asks isVisible() inside a precondition or a postcondition', () => {
    for (const file of sourceFiles(SRC_DIR)) {
      for (const gate of ['precondition', 'postcondition']) {
        const pattern = new RegExp(`${gate}\\s*:\\s*(?:async\\s*)?\\(\\s*\\)\\s*=>[^,\\n]*isVisible\\(`, 'g');
        assert.doesNotMatch(
          file.body,
          pattern,
          `${file.name}: isVisible() inside a ${gate}. Use visible() from @rpa/core - it waits.`,
        );
      }
    }
  });
});

describe('the gate-budget trap', () => {
  /**
   * ── THE GENUINELY NEW GUARD ─────────────────────────────────────────────────
   * `step()` caps EVERY gate at the step's own `timeoutMs`, which defaults to
   * 60s. So `visible(x, 300_000)` inside a step with no `timeoutMs` really waits
   * 60 seconds, silently. That truncation cut Anthem's quote-documents page off
   * mid-render and made the runner retry a transaction **that had already
   * created a real quote**.
   *
   * It is a static property of the pair - a gate budget and its enclosing
   * step's budget - so it is checkable without a browser, which turns a bug
   * that cost a duplicate production record into a test.
   */
  const STEP_DEFAULT_MS = 60_000;

  interface StepBlock {
    file: string;
    name: string;
    stepTimeout: number;
    gateBudgets: readonly number[];
  }

  /**
   * The LAST top-level argument of each gate call, when it is a number.
   *
   * ── WHY THIS IS NOT A REGEX ─────────────────────────────────────────────────
   * A gate call nests: `visible(page.getByRole('heading', { name: 'x' }), 45_000)`.
   * The obvious `visible\([^)]*?,\s*(\d+)\)` cannot cross the inner `)`, so it
   * matches nothing on real source - and the first version of this guard was
   * therefore VACUOUS: it reported zero offenders on a deliberate violation and
   * extracted zero budgets from files that plainly had them. A guard that cannot
   * fail is worse than no guard, because it reads as coverage.
   *
   * So: find the gate name, then walk forward tracking paren depth to the
   * matching close, and split the contents on top-level commas only.
   */
  function gateBudgetsIn(source: string): readonly number[] {
    const budgets: number[] = [];
    const gate = /\b(visible|hidden|valueIs|textVisible)\s*\(/g;

    for (let match = gate.exec(source); match !== null; match = gate.exec(source)) {
      const open = match.index + match[0].length;
      let depth = 1;
      let index = open;

      while (index < source.length && depth > 0) {
        const char = source[index];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        index += 1;
      }
      if (depth !== 0) continue;

      const args = splitTopLevel(source.slice(open, index - 1));
      const last = args.at(-1)?.trim() ?? '';
      const numeric = /^([\d_]+)$/.exec(last);
      if (numeric === null) continue;

      const value = Number((numeric[1] ?? '').replace(/_/g, ''));
      if (Number.isFinite(value) && value > 0) budgets.push(value);
    }

    return budgets;
  }

  /** Commas at depth zero only - braces, brackets and parens all nest here. */
  function splitTopLevel(source: string): readonly string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (const char of source) {
      if ('([{'.includes(char)) depth += 1;
      else if (')]}'.includes(char)) depth -= 1;

      if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += char;
    }

    parts.push(current);
    return parts;
  }

  function parseSteps(body: string, file: string): readonly StepBlock[] {
    const blocks: StepBlock[] = [];

    /**
     * Naive but adequate: find each `step(` call and take the text up to the
     * next one. A step spec is a flat object literal in this codebase, so a
     * brace-matching parser would buy nothing.
     */
    const parts = body.split(/\bstep[<(]/).slice(1);

    for (const part of parts) {
      const nameMatch = /name\s*:\s*[`'"]([^`'"]+)/.exec(part);
      if (nameMatch === null) continue;

      const timeoutMatch = /timeoutMs\s*:\s*([\d_]+)/.exec(part);
      const stepTimeout = timeoutMatch === null ? STEP_DEFAULT_MS : Number(timeoutMatch[1]?.replace(/_/g, ''));

      const gateBudgets = gateBudgetsIn(part);

      blocks.push({ file, name: nameMatch[1] ?? '(unnamed)', stepTimeout, gateBudgets });
    }

    return blocks;
  }

  /**
   * ── THE GUARD'S OWN GUARD ───────────────────────────────────────────────────
   * The first version of the check above was vacuous: its regex could not cross
   * the nested parens in `visible(page.getByRole('heading', { name: 'x' }), 45_000)`,
   * so it extracted no budgets at all and reported every file clean. It passed,
   * and proved nothing.
   *
   * So the parser is tested on a known violation and a known-correct pair. A
   * check that cannot fail is worse than no check, because it reads as coverage
   * in a place where coverage is what everyone is relying on.
   */
  it('detects a violation, and does not flag the corrected form', () => {
    const violation = `
      await step(ctx.steps, {
        name: 'reach the documents page',
        precondition: () => visible(page.getByRole('heading', { name: 'Documents' }), 300_000),
        action: async () => { await thing(); },
        postcondition: () => visible(page.getByText(payload.fein), 20_000),
      });
    `;

    const corrected = violation.replace(
      "name: 'reach the documents page',",
      "name: 'reach the documents page',\n        timeoutMs: 330_000,",
    );

    const offendersIn = (source: string): readonly string[] =>
      parseSteps(source, 'x.ts').flatMap((block) =>
        block.gateBudgets
          .filter((budget) => budget > block.stepTimeout)
          .map((budget) => `${block.name}: ${budget} > ${block.stepTimeout}`),
      );

    const found = offendersIn(violation);
    assert.equal(found.length, 1, `the parser must catch the 300s gate inside a 60s step, got ${JSON.stringify(found)}`);
    assert.match(found[0] ?? '', /300000 > 60000/);

    assert.deepEqual(offendersIn(corrected), [], 'raising the step budget is the correct fix and must pass');
  });

  /** And it must actually be reading the real files, not finding nothing in them. */
  it('extracts gate budgets from the real page objects', () => {
    const budgets = sourceFiles(PAGES_DIR).flatMap((file) =>
      parseSteps(file.body, file.name).flatMap((block) => block.gateBudgets),
    );

    assert.ok(
      budgets.length > 0,
      'the parser found no gate budgets anywhere in src/pages/, which is how the first version of ' +
        'this guard managed to pass while checking nothing',
    );
  });

  it('never gives a gate a longer budget than its enclosing step', () => {
    const offenders: string[] = [];

    for (const dir of [SRC_DIR, PAGES_DIR, path.join(SRC_DIR, 'sentinel')]) {
      let files: readonly { name: string; body: string }[] = [];
      try {
        files = sourceFiles(dir);
      } catch {
        continue;
      }

      for (const file of files) {
        for (const block of parseSteps(file.body, file.name)) {
          for (const budget of block.gateBudgets) {
            if (budget > block.stepTimeout) {
              offenders.push(
                `${file.name} step "${block.name}": a gate waits ${budget}ms inside a step capped ` +
                  `at ${block.stepTimeout}ms, so the gate is silently truncated`,
              );
            }
          }
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `A gate budget above its step's timeoutMs is silently truncated by step().\n${offenders.join('\n')}`,
    );
  });
});

describe('rule 10 - the submit guard', () => {
  /**
   * `allowSubmit` must be READ and guarded, never assigned. A single assignment
   * anywhere in this automation turns a dry run into a real signed application.
   */
  it('never assigns allowSubmit', () => {
    for (const dir of [SRC_DIR, PAGES_DIR]) {
      for (const file of sourceFiles(dir)) {
        assert.doesNotMatch(
          file.body,
          /allowSubmit\s*[:=]\s*true/,
          `${file.name} sets allowSubmit to true`,
        );
      }
    }
  });

  it('guards every submit-fronting method with a BusinessException naming the guard', () => {
    const fronting = ['signature.page.ts', 'post-signature.page.ts', 'employer-application.page.ts'];

    for (const file of sourceFiles(PAGES_DIR)) {
      if (!fronting.includes(file.name)) continue;
      if (!file.body.includes('allowSubmit')) continue;

      assert.match(
        file.body,
        /allowSubmit[\s\S]{0,400}BusinessException/,
        `${file.name} reads allowSubmit but does not raise a BusinessException naming the guard`,
      );
    }
  });
});

describe('deliberately absent things stay absent', () => {
  it('never uses ignoreHTTPSErrors', () => {
    for (const dir of [SRC_DIR, PAGES_DIR]) {
      for (const file of sourceFiles(dir)) {
        assert.doesNotMatch(
          file.body,
          /ignoreHTTPSErrors/,
          `${file.name}: it disables certificate validation for runs that sign in with real credentials`,
        );
      }
    }
  });
});

describe('the verification scripts are read-only by construction', () => {
  /**
   * A promise in a comment is not a guarantee when an autonomous agent is the
   * caller. These scripts attach to a browser holding a live production broker
   * session, so a single mutating call is a write to a real carrier portal.
   */
  const readOnlyScripts = ['anthem-verify-locators.ts', 'anthem-verify-checklist.ts', 'screen-baseline.ts', 'capture-masked-pair.ts'];

  const mutating = [
    /\.click\(/,
    /\.fill\(/,
    /\.check\(/,
    /\.uncheck\(/,
    /\.press\(/,
    /\.selectOption\(/,
    /\.setInputFiles\(/,
    /\.type\(/,
    /\.dblclick\(/,
    /\.tap\(/,
  ];

  for (const script of readOnlyScripts) {
    it(`${script} performs no mutating browser call`, () => {
      const file = path.join(REPO_ROOT, 'tooling', 'scripts', script);

      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        // Not every script exists in every checkout; the ones that do must hold.
        return;
      }

      const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const pattern of mutating) {
        assert.doesNotMatch(body, pattern, `${script} calls ${String(pattern)} on a live production page`);
      }
    });
  }
});
