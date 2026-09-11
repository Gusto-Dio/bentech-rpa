import type { Redactor } from './redact.ts';
import type { FieldKind, ScreenSignature } from './types.ts';

/**
 * Turns a raw screen reading into a signature that is stable across two
 * readings of an unchanged screen, and PII-free enough to commit.
 *
 * The input shape is structural rather than imported: this package must not
 * depend on an automation (rule 4), and every carrier's reader produces the
 * same six things even where the selectors differ.
 */
export interface RawScreenInput {
  url: string;
  alerts: readonly string[];
  wizardStep: readonly string[];
  fields: readonly { label: string; value: string | null }[];
  buttons: readonly string[];
  modal: string | null;
}

export interface SignatureOptions {
  screenId: string;
  redactor: Redactor;
  /**
   * Alerts that are informational rather than complaints.
   *
   * Not optional in practice. Anthem's dashboard carries "We've redesigned your
   * dashboard!" in the very same alert region as its validation errors, so
   * without this the access probe reports drift forever from the day it is
   * switched on.
   *
   * Pass the carrier's own classifier - `isPortalComplaint` inverted - rather
   * than a fresh list of strings. Re-deriving "is this a complaint?" is how the
   * two answers drift apart.
   */
  isInformationalAlert?: (text: string) => boolean;
}

export const SIGNATURE_VERSION = 1 as const;

export function buildSignature(raw: RawScreenInput, options: SignatureOptions): ScreenSignature {
  const { redactor } = options;
  const informational = options.isInformationalAlert ?? ((): boolean => false);

  const alerts = tidy(
    raw.alerts.filter((text) => !informational(text)).map((text) => truncate(redactor.text(text), 200)),
  );
  const railLabels = tidy(raw.wizardStep.map((entry) => stripRailStatus(redactor.text(entry))));
  const buttons = tidy(raw.buttons.map((text) => truncate(redactor.text(text), 120)));

  /**
   * Sorted by label so two readings agree regardless of DOM order, which the
   * Vlocity wizard changes as it reveals branches. Labels are deduped on the
   * pair, not the label alone, so two same-named fields of different kinds
   * still both appear.
   */
  const fields = raw.fields
    .map((field) => ({
      label: truncate(redactor.text(field.label), 60),
      kind: classifyValue(field.value),
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind))
    .filter(
      (field, index, all) =>
        index === 0 || field.label !== all[index - 1]?.label || field.kind !== all[index - 1]?.kind,
    );

  return {
    version: SIGNATURE_VERSION,
    screenId: options.screenId,
    location: parseLocation(raw.url),
    alerts,
    railLabels,
    fields,
    buttons,
    modal: {
      present: raw.modal !== null,
      text: raw.modal === null ? '' : truncate(redactor.text(raw.modal), 300),
    },
    counts: {
      alerts: alerts.length,
      fields: fields.length,
      buttons: buttons.length,
      rail: railLabels.length,
    },
  };
}

/**
 * Host, path, and the NAMES of the query parameters.
 *
 * Parsed, never pattern-matched, for the reason `isPortalUrl` documents at
 * length: on this portal the OAuth hosts quote each other inside query strings,
 * so a substring test identifies the wrong screen in both directions.
 *
 * Query values are dropped rather than redacted. A quote id and a Salesforce
 * record id are per-transaction by nature, and the presence of the KEY is the
 * structural fact worth comparing - `?c__ContextId=` appearing where it did not
 * before is a real change; its value changing is not.
 */
function parseLocation(url: string): ScreenSignature['location'] {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.host,
      path: parsed.pathname,
      queryKeys: [...new Set([...parsed.searchParams.keys()])].sort(),
    };
  } catch {
    return { host: '(unparseable)', path: '', queryKeys: [] };
  }
}

/**
 * Removes the volatile status word from a wizard-rail entry.
 *
 * The rail was measured reading `Untouched` on a screen the automation had
 * already reached - it lags the work by up to a minute. Comparing the status
 * would report drift on a screen that had not changed, while comparing the
 * LABEL catches the thing that matters: a wizard step appearing or vanishing.
 */
function stripRailStatus(entry: string): string {
  return entry.replace(/\s*\b(?:Untouched|In Progress|Completed)\b\s*/g, ' ').trim();
}

/**
 * What shape was the value, without recording it.
 *
 * Recorded but NOT compared by default. It is here so a reviewer reading a
 * baseline can tell a date field from a free-text one, which makes the file
 * legible; promoting it into the comparison would make a pre-filled readonly
 * combobox look like drift the first time it renders empty.
 */
function classifyValue(value: string | null): FieldKind {
  const text = (value ?? '').trim();
  if (text === '') return 'empty';
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(text)) return 'email';
  if (/^\$?\s?\d[\d,]*(?:\.\d{2})?$/.test(text) && text.includes('$')) return 'money';
  if (/^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}$/.test(text)) return 'phone';
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text) || /^\d{4}-\d{2}-\d{2}/.test(text)) return 'date';
  if (/^[\d\s.,-]+$/.test(text)) return 'digits';
  return 'text';
}

/** Sorted and deduped, so a signature is a set rather than a rendering order. */
function tidy(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value !== ''))].sort();
}

function truncate(value: string, max: number): string {
  const squashed = value.replace(/\s+/g, ' ').trim();
  return squashed.length <= max ? squashed : squashed.slice(0, max);
}

/**
 * The fail-closed check every writer runs.
 *
 * Returns the offending JSON path when a known secret value survived
 * normalization, so the caller can refuse to write the file and say which field
 * leaked. Rule 2 is not a thing to warn about and continue past.
 */
export function findLeak(signature: ScreenSignature, redactor: Redactor): string | undefined {
  const walk = (value: unknown, path: string): string | undefined => {
    if (typeof value === 'string') return redactor.leaks(value) ? path : undefined;
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        const found = walk(entry, `${path}[${index}]`);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        const found = walk(entry, path === '' ? key : `${path}.${key}`);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  return walk(signature, '');
}
