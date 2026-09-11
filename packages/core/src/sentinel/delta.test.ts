import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffSignatures } from './delta.ts';
import type { ScreenSignature } from './types.ts';

function signature(overrides: Partial<ScreenSignature> = {}): ScreenSignature {
  return {
    version: 1,
    screenId: 'group-setup',
    location: { host: 'portal.example', path: '/broker/s/createquote', queryKeys: [] },
    alerts: [],
    railLabels: ['Group Setup', 'Portfolios'],
    fields: [
      { label: 'Group Name', kind: 'text' },
      { label: 'Employer Tax ID', kind: 'digits' },
    ],
    buttons: ['Continue', 'Back'],
    modal: { present: false, text: '' },
    counts: { alerts: 0, fields: 2, buttons: 2, rail: 2 },
    ...overrides,
  };
}

/** Only the changes the heuristic judged meaningful. */
function meaningful(delta: ReturnType<typeof diffSignatures>): readonly string[] {
  return delta.changes.filter((change) => change.meaningful).map((change) => change.value);
}

describe('diffSignatures - an unchanged screen', () => {
  it('reports no changes at all', () => {
    const delta = diffSignatures(signature(), signature());
    assert.deepEqual(delta.changes, []);
    assert.equal(delta.meaningful, false);
    assert.equal(delta.shape, '');
  });
});

describe('diffSignatures - the changes that break an automation', () => {
  /**
   * THE CLASS OF CHANGE THAT ACTUALLY HAPPENED HERE. The whole quote flow moved
   * from Producer Toolbox to a Salesforce host mid-PoC. Nothing else in a
   * signature would have caught it.
   */
  it('flags a host move', () => {
    const delta = diffSignatures(
      signature(),
      signature({ location: { host: 'other.example', path: '/broker/s/createquote', queryKeys: [] } }),
    );

    assert.equal(delta.meaningful, true);
    assert.deepEqual(meaningful(delta), ['host portal.example -> other.example']);
  });

  it('flags a path move', () => {
    const delta = diffSignatures(
      signature(),
      signature({ location: { host: 'portal.example', path: '/broker/s/inprogressapplication', queryKeys: [] } }),
    );
    assert.equal(delta.meaningful, true);
  });

  /** A field the automation fills, gone: the fill will time out next run. */
  it('flags a removed field', () => {
    const delta = diffSignatures(
      signature(),
      signature({ fields: [{ label: 'Group Name', kind: 'text' }] }),
    );
    assert.deepEqual(meaningful(delta), ['Employer Tax ID']);
  });

  /** A new question is usually required, and stands in the flow's way. */
  it('flags an added field', () => {
    const delta = diffSignatures(
      signature(),
      signature({
        fields: [
          { label: 'Group Name', kind: 'text' },
          { label: 'Employer Tax ID', kind: 'digits' },
          { label: 'Group County', kind: 'text' },
        ],
      }),
    );
    assert.deepEqual(meaningful(delta), ['Group County']);
  });

  it('flags a new wizard step and a vanished one', () => {
    const added = diffSignatures(
      signature(),
      signature({ railLabels: ['Group Setup', 'Portfolios', 'Attestation'] }),
    );
    assert.deepEqual(meaningful(added), ['Attestation']);

    const removed = diffSignatures(signature(), signature({ railLabels: ['Group Setup'] }));
    assert.deepEqual(meaningful(removed), ['Portfolios']);
  });

  it('flags a removed button', () => {
    const delta = diffSignatures(signature(), signature({ buttons: ['Back'] }));
    assert.deepEqual(meaningful(delta), ['Continue']);
  });

  /**
   * A modal intercepts pointer events page-wide, which is what produces a click
   * that "does nothing" on a screen a human would say looked fine.
   */
  it('flags a modal appearing', () => {
    const delta = diffSignatures(
      signature(),
      signature({ modal: { present: true, text: 'Please accept the updated terms' } }),
    );
    assert.deepEqual(meaningful(delta), ['Please accept the updated terms']);
  });

  it('flags a new query parameter the screen now carries', () => {
    const delta = diffSignatures(
      signature(),
      signature({
        location: { host: 'portal.example', path: '/broker/s/createquote', queryKeys: ['c__ContextId'] },
      }),
    );
    assert.deepEqual(meaningful(delta), ['?c__ContextId']);
  });

  /** Alerts that survive the signature are complaints - informational ones were dropped. */
  it('flags a new complaint', () => {
    const delta = diffSignatures(signature(), signature({ alerts: ["That SIC code isn't valid."] }));
    assert.deepEqual(meaningful(delta), ["That SIC code isn't valid."]);
  });
});

describe('diffSignatures - what it deliberately calls noise', () => {
  /** "It does not break because the portal grew a banner." */
  it('does not flag a new button that blocks nothing', () => {
    const delta = diffSignatures(
      signature(),
      signature({ buttons: ['Continue', 'Back', 'Download Member-Rated PDF'] }),
    );

    assert.equal(delta.meaningful, false);
    assert.equal(delta.changes.length, 1, 'it is still REPORTED, just not meaningful');
    assert.match(delta.changes[0]?.noiseReason ?? '', /interstitial/);
  });

  /**
   * The exception, and the reason the rule is not simply "added buttons are
   * noise": a new consent gate is what makes a working step start timing out.
   */
  it('DOES flag a new button that reads like an interstitial', () => {
    for (const label of ['Accept All', 'I Agree', 'Got it', 'Dismiss', 'OK']) {
      const delta = diffSignatures(signature(), signature({ buttons: ['Continue', 'Back', label] }));
      assert.equal(delta.meaningful, true, `${label} should be meaningful`);
    }
  });

  it('does not flag an alert clearing, which is the portal working', () => {
    const delta = diffSignatures(signature({ alerts: ['old complaint'] }), signature());
    assert.equal(delta.meaningful, false);
    assert.match(delta.changes[0]?.noiseReason ?? '', /portal working/);
  });

  it('does not flag a modal closing', () => {
    const delta = diffSignatures(
      signature({ modal: { present: true, text: 'terms' } }),
      signature(),
    );
    assert.equal(delta.meaningful, false);
  });

  /** The baseline may simply have been blessed on an instance carrying it. */
  it('does not flag a query parameter disappearing', () => {
    const delta = diffSignatures(
      signature({
        location: { host: 'portal.example', path: '/broker/s/createquote', queryKeys: ['c__opt'] },
      }),
      signature(),
    );
    assert.equal(delta.meaningful, false);
  });

  /**
   * Kinds are recorded so a baseline is legible, not compared. A readonly
   * pre-filled combobox rendering empty once would otherwise look like drift.
   */
  it('does not compare field kinds', () => {
    const delta = diffSignatures(
      signature(),
      signature({
        fields: [
          { label: 'Group Name', kind: 'text' },
          { label: 'Employer Tax ID', kind: 'empty' },
        ],
      }),
    );
    assert.deepEqual(delta.changes, []);
  });

  it('does not compare the counts, which are there for the reader', () => {
    const delta = diffSignatures(
      signature(),
      signature({ counts: { alerts: 9, fields: 9, buttons: 9, rail: 9 } }),
    );
    assert.deepEqual(delta.changes, []);
  });
});

describe('diffSignatures - shape', () => {
  it('summarises meaningful changes by key and direction', () => {
    const delta = diffSignatures(
      signature(),
      signature({
        fields: [
          { label: 'Group Name', kind: 'text' },
          { label: 'Group County', kind: 'text' },
          { label: 'Group SIC', kind: 'digits' },
        ],
        buttons: ['Back'],
      }),
    );

    // Employer Tax ID removed; County and SIC added; Continue removed.
    assert.equal(delta.shape, 'buttons:-1,fields:+2-1');
  });

  /**
   * The fingerprint is built from the shape, so a reworded button must not
   * mint a new one and re-file the same finding.
   */
  it('is stable when only the values of noise changes differ', () => {
    const first = diffSignatures(signature(), signature({ buttons: ['Continue', 'Back', 'Print'] }));
    const second = diffSignatures(signature(), signature({ buttons: ['Continue', 'Back', 'Export'] }));
    assert.equal(first.shape, second.shape);
    assert.equal(first.shape, '');
  });

  it('is stable when a meaningful change keeps its shape but changes its wording', () => {
    const first = diffSignatures(signature(), signature({ alerts: ['first wording'] }));
    const second = diffSignatures(signature(), signature({ alerts: ['second wording'] }));
    assert.equal(first.shape, second.shape);
    assert.equal(first.shape, 'alerts:+1');
  });
});
