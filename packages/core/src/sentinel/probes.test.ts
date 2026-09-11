import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertProbeSet } from './probe.ts';

/**
 * The probe contract's own guard rails.
 *
 * `assertProbeSet` runs at load time against a module resolved from a computed
 * path, in a container, at 02:00. Anything it lets through becomes a runtime
 * TypeError several frames deep, so what it rejects matters more than usual.
 */
describe('assertProbeSet', () => {
  const valid = {
    probes: [
      {
        id: 'anthem-ca/portal-access',
        carrier: 'anthem-ca',
        title: 'x',
        sets: ['access'],
        needsCredentials: false,
        maySpendMfa: false,
        screenIds: ['ptb-login'],
        knownCauses: [],
        run: async (): Promise<void> => {},
        explain: (): readonly string[] => [],
      },
    ],
  };

  it('accepts a well-formed probe set', () => {
    assert.doesNotThrow(() => assertProbeSet(valid, 'test'));
  });

  it('rejects a module with no default export shape', () => {
    assert.throws(() => assertProbeSet(undefined, 'test'), /must default-export a ProbeSet/);
    assert.throws(() => assertProbeSet({}, 'test'), /must default-export \{ probes: Probe\[\] \}/);
  });

  /**
   * THE GUARD THAT MATTERS MOST. `rpa sentinel <id>` takes a probe id
   * positionally, and `rpa sentinel group-submission/anthem-ca-new-plans` is one
   * word away from the forbidden `rpa run group-submission/anthem-ca-new-plans`,
   * which creates a real account and a real quote on a production portal at any
   * allowSubmit setting. Refusing the SHAPE removes the possibility of the
   * confusion rather than relying on nobody making it.
   */
  it('refuses a probe id that reads like an automation id', () => {
    for (const id of [
      'group-submission/anthem-ca-new-plans',
      'group-submission/uhc-np-new-plans',
      'member-submission/roster-file-validation-demo',
    ]) {
      assert.throws(
        () => assertProbeSet({ probes: [{ ...valid.probes[0], id }] }, 'test'),
        /reads like an automation id/,
        `${id} must be refused`,
      );
    }
  });

  it('accepts the carrier-shaped ids that are the intended convention', () => {
    for (const id of ['anthem-ca/portal-access', 'uhc-np/portal-access']) {
      assert.doesNotThrow(() => assertProbeSet({ probes: [{ ...valid.probes[0], id }] }, 'test'));
    }
  });

  /**
   * Declared rather than defaulted. A probe that silently defaulted to "yes, I
   * may spend an MFA code" would be able to burn a one-time code by omission,
   * and a code takes a measured 132-600s to arrive and expires on a countdown.
   */
  it('requires the credential and MFA declarations to be explicit', () => {
    const { needsCredentials: _n, ...withoutCredentials } = valid.probes[0] as Record<string, unknown>;
    assert.throws(
      () => assertProbeSet({ probes: [withoutCredentials] }, 'test'),
      /needsCredentials must be declared explicitly/,
    );

    const { maySpendMfa: _m, ...withoutMfa } = valid.probes[0] as Record<string, unknown>;
    assert.throws(
      () => assertProbeSet({ probes: [withoutMfa] }, 'test'),
      /maySpendMfa must be declared explicitly/,
    );
  });

  it('requires a cadence, a run and an explain', () => {
    assert.throws(
      () => assertProbeSet({ probes: [{ ...valid.probes[0], sets: [] }] }, 'test'),
      /must name at least one cadence/,
    );
    assert.throws(
      () => assertProbeSet({ probes: [{ ...valid.probes[0], run: 'nope' }] }, 'test'),
      /run must be a function/,
    );
    assert.throws(
      () => assertProbeSet({ probes: [{ ...valid.probes[0], explain: undefined }] }, 'test'),
      /explain must be a function/,
    );
  });

  it('names which probe in the set was wrong', () => {
    assert.throws(
      () => assertProbeSet({ probes: [valid.probes[0], { id: '' }] }, 'automation-x (src/p.ts)'),
      /automation-x \(src\/p\.ts\) probes\[1\]/,
    );
  });
});

/**
 * ── THE FREEZE GUARD ────────────────────────────────────────────────────────
 * A probe exists because a run is forbidden. Source-level, because no
 * browserless behavioural test can catch a probe that starts importing the
 * runner - and the repo already uses exactly this technique on
 * `quote-start.page.ts` for the same reason.
 */
describe('no sentinel module can drive an automation', () => {
  const roots = [
    path.join(import.meta.dirname),
    path.join(
      import.meta.dirname, '..', '..', '..', '..',
      'automations', 'group-submission', 'anthem-ca-new-plans', 'src', 'sentinel',
    ),
  ];

  /**
   * The MECHANISMS of execution, not the name of the command.
   *
   * An earlier version of this guard forbade the string
   * `rpa run group-submission/...` and immediately failed on `issue-body.ts`,
   * which contains it as a PROHIBITION in the freeze warning it renders. That
   * was the guard being wrong, not the code: naming the forbidden command in
   * prose is exactly what we want an issue body to do.
   *
   * A sentinel module cannot actually drive an automation without importing the
   * runner or shelling out, so those are what to forbid. `issue-body.test.ts`
   * separately pins that every mention of the command is a prohibition.
   */
  const forbidden: readonly (readonly [RegExp, string])[] = [
    [/\brunAutomation\b/, 'importing the runner would let a probe execute the automation (rule 10a)'],
    [/\bprocessTransaction\b/, 'a transaction writes to the portal'],
    [/\ballowSubmit\s*[:=]\s*true/, 'rule 10: allowSubmit stays false'],
    [/node:child_process|\bexecSync\b|\bexecFileSync\b|\bspawnSync\b|\bspawn\(/,
      'a sentinel module must not shell out - that is the one way it could reach a forbidden command'],
  ];

  it('imports nothing that could write to a portal', async () => {
    const { readdirSync, existsSync } = await import('node:fs');

    for (const root of roots) {
      if (!existsSync(root)) continue;

      for (const file of readdirSync(root)) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;

        const source = readFileSync(path.join(root, file), 'utf8');
        // Comments legitimately discuss the forbidden command; code must not use it.
        const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

        for (const [pattern, why] of forbidden) {
          assert.doesNotMatch(body, pattern, `${file}: ${why}`);
        }
      }
    }
  });
});
