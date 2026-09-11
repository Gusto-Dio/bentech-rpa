import type { ScreenSignature, SignatureChange, SignatureDelta } from './types.ts';

/**
 * Comparing two signatures, and deciding which differences matter.
 *
 * ── THE HEURISTIC, STATED ONCE SO IT CAN BE ARGUED WITH ─────────────────────
 * An automation breaks when something it addresses goes away, or when something
 * new blocks its path. It does not break because the portal grew a banner.
 *
 * So a removed field is meaningful and an added banner is not; an added button
 * is noise UNLESS it reads like an interstitial standing between us and the
 * next screen. Everything is reported either way, with `meaningful` and a
 * `noiseReason` - a report that silently drops what it judged uninteresting
 * cannot be argued with, and this judgement is a heuristic, not a fact.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Buttons whose ARRIVAL blocks a flow.
 *
 * A new "Continue" or "Accept" is usually an interstitial - a consent gate, a
 * cookie notice, a terms modal - which is exactly the thing that makes a
 * previously-working step time out on a screen a human would say looked fine.
 * A new "Download PDF" is not.
 */
const INTERSTITIAL_BUTTON =
  /^(?:ok|okay|continue|proceed|next|yes|no|accept|accept all|agree|i agree|acknowledge|dismiss|close|got it|confirm)$/i;

export function diffSignatures(
  baseline: ScreenSignature,
  current: ScreenSignature,
): SignatureDelta {
  const changes: SignatureChange[] = [
    ...locationChanges(baseline, current),
    // A field the automation fills, gone. Or a new question in its way.
    ...setChanges('fields', fieldLabels(baseline), fieldLabels(current), {
      added: { meaningful: true },
      removed: { meaningful: true },
    }),
    // A new wizard step, or one that vanished.
    ...setChanges('railLabels', baseline.railLabels, current.railLabels, {
      added: { meaningful: true },
      removed: { meaningful: true },
    }),
    ...setChanges('buttons', baseline.buttons, current.buttons, {
      added: (value) =>
        INTERSTITIAL_BUTTON.test(value)
          ? { meaningful: true }
          : {
              meaningful: false,
              noiseReason: 'a new button that does not read like an interstitial blocks nothing',
            },
      removed: { meaningful: true },
    }),
    /**
     * An alert that survived the signature is already NOT informational - the
     * builder drops those using the carrier's own classifier. So its arrival is
     * the portal complaining about something it did not complain about before.
     *
     * Its departure is not: an error clearing is the portal working.
     */
    ...setChanges('alerts', baseline.alerts, current.alerts, {
      added: { meaningful: true },
      removed: {
        meaningful: false,
        noiseReason: 'an alert clearing is the portal working, not drift',
      },
    }),
    ...modalChanges(baseline, current),
  ];

  return {
    screenId: current.screenId,
    changes,
    meaningful: changes.some((change) => change.meaningful),
    shape: describeShape(changes),
  };
}

/**
 * Host and path changes are the highest-signal drift there is.
 *
 * This is the class of change that actually happened here: the entire quote
 * flow moved from Producer Toolbox to a Salesforce host mid-PoC. Nothing else
 * in a signature would have caught it.
 *
 * A query KEY appearing is meaningful (a screen now needs a context id it did
 * not before); one disappearing is not, because the baseline may simply have
 * been blessed on an instance that carried an optional parameter.
 */
function locationChanges(
  baseline: ScreenSignature,
  current: ScreenSignature,
): readonly SignatureChange[] {
  const changes: SignatureChange[] = [];

  if (baseline.location.host !== current.location.host) {
    changes.push({
      key: 'location',
      direction: 'changed',
      value: `host ${baseline.location.host} -> ${current.location.host}`,
      meaningful: true,
    });
  }
  if (baseline.location.path !== current.location.path) {
    changes.push({
      key: 'location',
      direction: 'changed',
      value: `path ${baseline.location.path} -> ${current.location.path}`,
      meaningful: true,
    });
  }

  for (const key of missing(baseline.location.queryKeys, current.location.queryKeys)) {
    changes.push({
      key: 'location',
      direction: 'added',
      value: `?${key}`,
      meaningful: true,
    });
  }
  for (const key of missing(current.location.queryKeys, baseline.location.queryKeys)) {
    changes.push({
      key: 'location',
      direction: 'removed',
      value: `?${key}`,
      meaningful: false,
      noiseReason: 'the baseline may have been blessed on an instance carrying an optional parameter',
    });
  }

  return changes;
}

/**
 * A modal APPEARING is meaningful: it intercepts pointer events page-wide, and
 * a click that "does nothing" on a screen that looks fine is exactly what that
 * produces. A modal going away is the screen becoming more usable.
 */
function modalChanges(
  baseline: ScreenSignature,
  current: ScreenSignature,
): readonly SignatureChange[] {
  if (baseline.modal.present === current.modal.present) return [];

  return current.modal.present
    ? [
        {
          key: 'modal',
          direction: 'added',
          value: current.modal.text === '' ? '(a modal is now open)' : current.modal.text,
          meaningful: true,
        },
      ]
    : [
        {
          key: 'modal',
          direction: 'removed',
          value: baseline.modal.text === '' ? '(the modal is gone)' : baseline.modal.text,
          meaningful: false,
          noiseReason: 'a modal closing removes an obstacle rather than creating one',
        },
      ];
}

/** Field KINDS are recorded but not compared - see `classifyValue`. */
function fieldLabels(signature: ScreenSignature): readonly string[] {
  return [...new Set(signature.fields.map((field) => field.label))];
}

type Judgement = { meaningful: boolean; noiseReason?: string };
type Judge = Judgement | ((value: string) => Judgement);

function setChanges(
  key: SignatureChange['key'],
  before: readonly string[],
  after: readonly string[],
  judge: { added: Judge; removed: Judge },
): readonly SignatureChange[] {
  const decide = (value: string, which: Judge): Judgement =>
    typeof which === 'function' ? which(value) : which;

  return [
    ...missing(before, after).map((value) => ({
      key,
      direction: 'added' as const,
      value,
      ...decide(value, judge.added),
    })),
    ...missing(after, before).map((value) => ({
      key,
      direction: 'removed' as const,
      value,
      ...decide(value, judge.removed),
    })),
  ];
}

/** Entries of `to` that `from` does not have. */
function missing(from: readonly string[], to: readonly string[]): readonly string[] {
  const known = new Set(from);
  return to.filter((value) => !known.has(value));
}

/**
 * A counts-only summary, e.g. `fields:+2,buttons:-1`.
 *
 * This is what the fingerprint uses. A delta keyed on the VALUES would mint a
 * fresh fingerprint every time a portal reworded a button, and file a new issue
 * for each - the same finding, over and over.
 *
 * Only meaningful changes are counted, so noise cannot shift the shape and
 * re-file a finding that has not actually changed.
 */
function describeShape(changes: readonly SignatureChange[]): string {
  const tally = new Map<string, { added: number; removed: number; changed: number }>();

  for (const change of changes) {
    if (!change.meaningful) continue;
    const entry = tally.get(change.key) ?? { added: 0, removed: 0, changed: 0 };
    entry[change.direction] += 1;
    tally.set(change.key, entry);
  }

  return [...tally.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, counts]) => {
      const parts = [
        counts.added > 0 ? `+${counts.added}` : '',
        counts.removed > 0 ? `-${counts.removed}` : '',
        counts.changed > 0 ? `~${counts.changed}` : '',
      ].filter((part) => part !== '');
      return `${key}:${parts.join('')}`;
    })
    .join(',');
}
