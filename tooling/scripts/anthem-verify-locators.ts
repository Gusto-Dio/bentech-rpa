import type { Locator, Page } from 'playwright';
import { dump } from './anthem-recon.ts';
import { attachToReconBrowser, detach } from './heal-attach.ts';

/**
 * Proves a locator resolves on the LIVE screen, read-only.
 *
 *   pnpm tsx tooling/scripts/anthem-verify-locators.ts --probe "Group County"
 *   pnpm tsx tooling/scripts/anthem-verify-locators.ts --role combobox --name "Group County"
 *   pnpm tsx tooling/scripts/anthem-verify-locators.ts --css "input.hidden-file-input"
 *
 * ── WHY THIS RUNG EXISTS, AND WHAT IT CARRIES ───────────────────────────────
 * Anthem production is frozen to signing in and navigating, and a run creates a
 * real account and a real quote at any `allowSubmit` setting. So a repair
 * cannot be proven by running the automation, and static analysis plus unit
 * tests prove only that the code compiles and does not repeat a known mistake -
 * neither of them proves a single locator resolves on the real portal.
 *
 * This does. It is generalised from `anthem-verify-checklist.ts`, which already
 * did exactly this for one page object and whose header states the standard:
 * *"Every assertion below is a read. Nothing is clicked, nothing is uploaded and
 * `Submit` is never pressed."*
 *
 * ── READ-ONLY BY CONSTRUCTION, NOT BY PROMISE ───────────────────────────────
 * The only Playwright methods called below are `count`, `all`, `boundingBox`,
 * `getAttribute`, `inputValue`, `textContent` and `isVisible`. A source-level
 * test in `healing-guards.test.ts` asserts this file contains no `.click(`,
 * `.fill(`, `.check(`, `.press(`, `.selectOption(` or `.setInputFiles(` - because
 * a promise in a comment is not a guarantee when an autonomous agent is the
 * caller.
 * ────────────────────────────────────────────────────────────────────────────
 */

interface Probe {
  describe: string;
  locator: (page: Page) => Locator;
}

interface Finding {
  describe: string;
  total: number;
  visible: number;
  /** The visible match's own account of itself, which is what a locator is chosen by. */
  resolved: readonly {
    role: string;
    accessibleName: string;
    tag: string;
    value: string;
    dataValue: string;
  }[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { browser, page } = await attachToReconBrowser();

  try {
    console.log('anthem-verify-locators  (read-only)');
    console.log(`  url : ${page.url()}`);
    console.log();

    if (args.probes.length === 0) {
      console.log('No probe given, so here is the screen instead:');
      console.log();
      await dump(page);
      return;
    }

    const findings: Finding[] = [];
    for (const probe of args.probes) findings.push(await inspect(page, probe));

    for (const finding of findings) report(finding);

    /**
     * The ambiguity list from the recon dump, printed alongside.
     *
     * `count() > 1` tells you a locator is ambiguous; the dump tells you what
     * it is ambiguous WITH, which is what you actually need to scope it. The
     * dump's own heading says it: "AMBIGUOUS (scope these, do not use .first()
     * and hope)".
     */
    if (findings.some((finding) => finding.total > 1)) {
      console.log();
      console.log('Something is ambiguous. The screen dump below names what it collides with -');
      console.log('look for its "AMBIGUOUS (scope these, do not use .first() and hope)" section.');
      console.log();
      await dump(page);
    }

    const broken = findings.filter((finding) => finding.visible !== 1);
    console.log();

    if (broken.length === 0) {
      console.log(`  OK - ${findings.length} locator(s), each resolving to exactly one VISIBLE element.`);
      console.log();
      console.log('  What this proves: the locator resolves, uniquely and visibly, on the real');
      console.log('  production screen. What it does NOT prove: that the action after it lands,');
      console.log('  that the postcondition becomes true, or anything about screens downstream.');
      console.log('  Say so in the PR - the Not verified section is not optional.');
      return;
    }

    for (const finding of broken) {
      console.log(
        `  FAIL  ${finding.describe}: ${finding.total} match(es), ${finding.visible} visible ` +
          `(want exactly 1 visible)`,
      );
    }
    process.exitCode = 1;
  } finally {
    await detach(browser);
  }
}

async function inspect(page: Page, probe: Probe): Promise<Finding> {
  const locator = probe.locator(page);
  const total = await locator.count().catch(() => 0);

  const resolved: Finding['resolved'][number][] = [];
  let visible = 0;

  for (const element of await locator.all()) {
    /**
     * `isVisible()` is legitimate HERE. Rule 9b forbids it inside a gate,
     * where the question is "will this appear?" and the answer must wait. This
     * is a diagnostic asking "what is on screen right now", which is precisely
     * the case the rule carves out.
     */
    const onScreen = await element.isVisible().catch(() => false);
    if (!onScreen) continue;
    visible += 1;

    /**
     * Role, accessible name and `data-value`, because those are the three
     * things this platform lies about. A button reading "Continue" is named
     * `Login`; the checklist's `Submit` is named `documentCheckListSubmit`; and
     * a Vlocity combobox keeps its value on `data-value` while `inputValue()`
     * returns empty.
     */
    const account = await element
      .evaluate((node) => {
        const el = node as unknown as {
          tagName: string;
          getAttribute: (name: string) => string | null;
          textContent: string | null;
          value?: string;
        };
        return {
          role: el.getAttribute('role') ?? '',
          accessibleName:
            el.getAttribute('aria-label') ??
            (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
          tag: el.tagName.toLowerCase(),
          value: el.value ?? '',
          dataValue: el.getAttribute('data-value') ?? '',
        };
      })
      .catch(() => ({ role: '', accessibleName: '(unreadable)', tag: '', value: '', dataValue: '' }));

    resolved.push(account);
  }

  return { describe: probe.describe, total, visible, resolved };
}

function report(finding: Finding): void {
  const mark = finding.visible === 1 ? 'ok  ' : 'FAIL';
  console.log(`  ${mark}  ${finding.describe}`);
  console.log(`         matches: ${finding.total}   visible: ${finding.visible}`);

  for (const element of finding.resolved) {
    console.log(
      `         <${element.tag}>` +
        (element.role === '' ? '' : ` role=${element.role}`) +
        `  name="${element.accessibleName}"` +
        (element.value === '' ? '' : `  value="${element.value}"`) +
        (element.dataValue === '' ? '' : `  data-value="${element.dataValue}"`),
    );
  }

  if (finding.total === 0) {
    console.log('         Nothing matched. Read the ACCESSIBLE NAME off the dump, not the visible');
    console.log('         text - on this portal a button reading "Continue" is named "Login".');
  } else if (finding.total > 1 && finding.visible === 1) {
    console.log('         Ambiguous in the DOM but one visible, which is normal here: the Vlocity');
    console.log('         wizard pre-renders every branch. Scope to the visible one rather than');
    console.log('         using .first() and hoping.');
  } else if (finding.visible > 1) {
    console.log('         More than one VISIBLE match. This one really is ambiguous - scope it to');
    console.log('         the fieldset whose direct-child legend matches (:scope > legend).');
  } else if (finding.visible === 0) {
    console.log('         Present in the DOM but not on screen. Either the wrong branch of the');
    console.log('         wizard, or the screen has not rendered - check the URL first.');
  }
}

interface Args {
  probes: readonly Probe[];
}

function parseArgs(argv: readonly string[]): Args {
  const probes: Probe[] = [];

  for (const [index, token] of argv.entries()) {
    const next = argv[index + 1];
    if (next === undefined) continue;

    switch (token) {
      case '--probe':
        /** Text or accessible name, the two things worth trying first. */
        probes.push({
          describe: `text or name "${next}"`,
          locator: (page) =>
            page.getByText(next, { exact: false }).or(page.getByLabel(next, { exact: false })),
        });
        break;

      case '--role': {
        const nameIndex = argv.indexOf('--name');
        const name = nameIndex === -1 ? undefined : argv[nameIndex + 1];
        probes.push({
          describe: `role "${next}"${name === undefined ? '' : ` name "${name}"`}`,
          locator: (page) =>
            name === undefined
              ? page.getByRole(next as Parameters<Page['getByRole']>[0])
              : page.getByRole(next as Parameters<Page['getByRole']>[0], { name, exact: true }),
        });
        break;
      }

      case '--css':
        probes.push({ describe: `css "${next}"`, locator: (page) => page.locator(next) });
        break;

      case '--label':
        probes.push({
          describe: `label "${next}"`,
          locator: (page) => page.getByLabel(next, { exact: false }),
        });
        break;

      default:
        break;
    }
  }

  return { probes };
}

await main();
