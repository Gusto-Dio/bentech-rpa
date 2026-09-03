import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from '@rpa/core';

/**
 * Keeps templates/ alive.
 *
 * Templates are not workspace packages - they contain placeholder tokens that
 * are not valid TypeScript - so nothing typechecks them, and a template that
 * silently rots is worse than no template: the next person scaffolds from it,
 * gets errors, and concludes the platform is broken.
 *
 * So this scaffolds every template for real, into a throwaway domain inside the
 * workspace, then installs, typechecks, validates and runs it. Slow (it shells
 * out to pnpm) but it is the only check that proves what it claims.
 *
 * Run it in CI on any change under templates/, packages/ or tooling/.
 */

const CHECK_DOMAIN = 'template-check';
const OWNER = '@gusto/benefits-rpa-platform';

const repoRoot = findRepoRoot();
const checkDir = path.join(repoRoot, 'automations', CHECK_DOMAIN);

function run(command: string, args: readonly string[]): void {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, [...args], { cwd: repoRoot, stdio: 'inherit' });
}

function cleanup(): void {
  if (existsSync(checkDir)) rmSync(checkDir, { recursive: true, force: true });
  for (const slug of ['browser-check', 'api-check']) {
    const queueFile = path.join(repoRoot, 'data', `queue.${CHECK_DOMAIN}.${slug}.json`);
    if (existsSync(queueFile)) rmSync(queueFile, { force: true });
  }
}

if (existsSync(checkDir)) {
  process.stderr.write(
    `${path.relative(repoRoot, checkDir)} already exists - a previous run did not clean up. Remove it and retry.\n`,
  );
  process.exit(1);
}

let failed = false;
try {
  run('pnpm', ['rpa', 'new', 'domain', '--name', CHECK_DOMAIN, '--owner', OWNER]);

  run('pnpm', [
    'rpa', 'new', 'automation',
    '--id', `${CHECK_DOMAIN}/browser-check`,
    '--owner', OWNER,
    '--kind', 'browser',
  ]);

  run('pnpm', [
    'rpa', 'new', 'automation',
    '--id', `${CHECK_DOMAIN}/api-check`,
    '--owner', OWNER,
    '--kind', 'api',
  ]);

  // Link the scaffolded workspace packages, then prove they hold up.
  run('pnpm', ['install', '--silent']);
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json']);
  run('pnpm', ['rpa', 'validate']);

  // Only the api template can actually run here: the browser template
  // deliberately points at example.invalid, since a template must not depend on
  // any real system being reachable.
  run('pnpm', ['rpa', 'run', `${CHECK_DOMAIN}/api-check`]);

  process.stdout.write('\nAll templates scaffold, typecheck, validate and run.\n');
} catch (thrown) {
  failed = true;
  process.stderr.write(
    `\nTemplate verification failed: ${thrown instanceof Error ? thrown.message : String(thrown)}\n`,
  );
} finally {
  cleanup();
  try {
    execFileSync('pnpm', ['install', '--silent'], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    process.stderr.write('Could not restore the workspace after cleanup; run `pnpm install`.\n');
  }
}

process.exitCode = failed ? 1 : 0;
