import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverAutomations, findRepoRoot } from '@rpa/core';
import { chromium } from 'playwright';
import type { ParsedArgs } from '../args.ts';
import { heading, line, style } from '../ui.ts';

type Level = 'pass' | 'warn' | 'fail';

interface Check {
  name: string;
  level: Level;
  detail: string;
}

/**
 * `rpa doctor` - answers "will this machine actually run an automation?"
 *
 * Exists because the two environments fail in different ways: a Mac usually has
 * no browsers downloaded, and a fresh Ubuntu box usually has browsers but is
 * missing system libraries. Both look like an opaque Playwright launch error at
 * 3am otherwise.
 */
export async function doctorCommand(_args: ParsedArgs): Promise<number> {
  const repoRoot = findRepoRoot();
  const checks: Check[] = [];

  checks.push(await checkNodeVersion(repoRoot));
  checks.push({
    name: 'platform',
    level: 'pass',
    detail: `${process.platform}/${process.arch} (runtime target is linux/x64, headless)`,
  });
  checks.push(checkChromium());
  checks.push(checkEnvFile(repoRoot));
  checks.push(checkHeadless());
  checks.push(await checkWritable(repoRoot, 'data'));
  checks.push(await checkWritable(repoRoot, 'artifacts'));
  checks.push(await checkAutomations(repoRoot));

  heading('rpa doctor');
  for (const check of checks) {
    const mark =
      check.level === 'pass'
        ? style.green('ok  ')
        : check.level === 'warn'
          ? style.yellow('warn')
          : style.red('fail');
    line(`  ${mark}  ${check.name.padEnd(14)} ${check.detail}`);
  }

  const failures = checks.filter((c) => c.level === 'fail');
  line();
  if (failures.length > 0) {
    line(style.red(`${failures.length} check(s) failed.`));
    return 1;
  }
  line(style.green('Environment looks runnable.'));
  return 0;
}

async function checkNodeVersion(repoRoot: string): Promise<Check> {
  const expected = await readEngines(repoRoot);
  const major = Number(process.versions.node.split('.')[0]);
  const ok = expected === undefined || expected === major;
  return {
    name: 'node',
    level: ok ? 'pass' : 'fail',
    detail: ok
      ? `v${process.versions.node}`
      : `v${process.versions.node} but this repo pins Node ${expected} (.nvmrc / engines). Run: mise install`,
  };
}

async function readEngines(repoRoot: string): Promise<number | undefined> {
  try {
    const nvmrc = await readFile(path.join(repoRoot, '.nvmrc'), 'utf8');
    const major = Number(nvmrc.trim());
    return Number.isInteger(major) ? major : undefined;
  } catch {
    return undefined;
  }
}

function checkChromium(): Check {
  const browsersPath = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  let executable: string | undefined;
  try {
    executable = chromium.executablePath();
  } catch {
    executable = undefined;
  }

  if (executable !== undefined && existsSync(executable)) {
    return {
      name: 'chromium',
      level: 'pass',
      detail: browsersPath === undefined ? executable : `${executable} (PLAYWRIGHT_BROWSERS_PATH=${browsersPath})`,
    };
  }

  return {
    name: 'chromium',
    level: 'fail',
    detail:
      process.platform === 'linux'
        ? 'not found. On Ubuntu run: pnpm exec playwright install --with-deps chromium'
        : 'not found. Run: pnpm exec playwright install chromium',
  };
}

function checkEnvFile(repoRoot: string): Check {
  if (existsSync(path.join(repoRoot, '.env'))) {
    return { name: 'credentials', level: 'pass', detail: '.env present (values are never logged)' };
  }
  return {
    name: 'credentials',
    level: 'warn',
    detail: 'no .env file. Copy .env.example and fill it in, or provide the variables another way',
  };
}

/**
 * Whether a headed run can actually get a browser on screen HERE.
 *
 * `HEADLESS=false` is not a developer-only setting any more: Anthem's portal
 * serves `Access Denied` to headless Chromium, so the automation that most needs
 * to run unattended is the one that must run headed. What decides whether that
 * works is not the flag, it is whether this machine can give Chromium a display
 * - a real one on a laptop, or xvfb on a server.
 *
 * The old version of this check just warned that HEADLESS=false "would fail on a
 * headless server", which was true and unhelpful: it named the symptom and not
 * the fix, on the one setting a carrier forces.
 */
export function checkHeadless(): Check {
  const headless = process.env['HEADLESS'];

  if (headless === undefined || headless === '') {
    return { name: 'headless', level: 'pass', detail: 'default (true) - safe for a server with no display' };
  }
  if (headless !== 'false') {
    return { name: 'headless', level: 'pass', detail: `HEADLESS=${headless}` };
  }

  // macOS and Windows always have a window server; only Linux can be displayless.
  if (process.platform !== 'linux') {
    return {
      name: 'headless',
      level: 'pass',
      detail: `HEADLESS=false on ${process.platform} - this machine has a display`,
    };
  }

  const display = process.env['DISPLAY'];
  if (display !== undefined && display !== '') {
    return { name: 'headless', level: 'pass', detail: `HEADLESS=false with DISPLAY=${display}` };
  }

  /**
   * A PATH lookup, because that is how the thing which actually starts the
   * display finds it: `with-display.sh` uses `command -v xvfb-run`. Two
   * hardcoded paths answered the same question differently, so on a runtime
   * with xvfb-run somewhere else on PATH doctor said `fail` ("Chromium cannot
   * start") about a machine that starts it fine.
   */
  const hasXvfb = (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '')
    .some((dir) => existsSync(path.join(dir, 'xvfb-run')));
  if (hasXvfb) {
    return {
      name: 'headless',
      level: 'pass',
      detail: 'HEADLESS=false, no DISPLAY, but xvfb-run is available - the entrypoint will supply one',
    };
  }

  return {
    name: 'headless',
    level: 'fail',
    detail:
      'HEADLESS=false on Linux with no DISPLAY and no xvfb-run: Chromium cannot start. ' +
      'Install xvfb (the image in tooling/docker/Dockerfile does), or run headless.',
  };
}

async function checkWritable(repoRoot: string, dirname: string): Promise<Check> {
  const dir = path.join(repoRoot, dirname);
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, 'probe', 'utf8');
    await rm(probe);
    return { name: dirname, level: 'pass', detail: `${dir} is writable` };
  } catch (thrown) {
    return {
      name: dirname,
      level: 'fail',
      detail: `${dir} is not writable: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    };
  }
}

async function checkAutomations(repoRoot: string): Promise<Check> {
  const { automations, failures } = await discoverAutomations(repoRoot);
  if (failures.length > 0) {
    return {
      name: 'registry',
      level: 'fail',
      detail: `${automations.length} automation(s) found, ${failures.length} unreadable manifest(s). Run: pnpm rpa validate`,
    };
  }
  return {
    name: 'registry',
    level: automations.length > 0 ? 'pass' : 'warn',
    detail: `${automations.length} automation(s) discovered`,
  };
}
