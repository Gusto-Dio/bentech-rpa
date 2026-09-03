import { BusinessException } from '../errors.ts';

/**
 * Translates a POC payload to and from Orchestrator's SpecificContent.
 *
 * SpecificContent is a Dictionary(Of String, Object), and UiPath's guidance is
 * to store only primitives - Number, Boolean, String, DateTime. Nested objects
 * and arrays have to be serialised, or Studio activities and the Orchestrator UI
 * render them unusably.
 *
 * So non-primitive values are JSON-encoded and the encoded keys are recorded in
 * a companion key, making the round-trip lossless on any Orchestrator version:
 *
 *   groupId        : "GRP-8842"                        <- primitive, untouched
 *   contact        : "{\"firstName\":\"Ada\", ...}"    <- JSON-encoded
 *   requestedPlans : "[\"Backpack\",\"Bike Light\"]"   <- JSON-encoded
 *   __jsonFields   : "[\"contact\",\"requestedPlans\"]"
 *
 * A `flattened` alternative (contact_firstName, requestedPlans_0) would be
 * friendlier for existing Studio processes reading SpecificContent("field")
 * directly, but it is lossy for ragged arrays and is deliberately not built.
 * See the README if you need it.
 */

export type SpecificContentEncoding = 'json-encoded';

/** The marker key. Recorded as a JSON array so field names containing commas survive. */
export const JSON_FIELDS_KEY = '__jsonFields';

export type SpecificContentValue = string | number | boolean | null;
export type SpecificContent = Record<string, SpecificContentValue>;

export function toSpecificContent(payload: unknown): SpecificContent {
  if (!isPlainObject(payload)) {
    // A payload that is not an object cannot become a dictionary. That is a
    // data-shape problem, so it is a business failure - no retry would fix it.
    throw new BusinessException(
      `Queue item payload must be an object to map onto SpecificContent, received ${describeType(payload)}`,
    );
  }

  if (JSON_FIELDS_KEY in payload) {
    throw new BusinessException(
      `Queue item payload must not contain the reserved key "${JSON_FIELDS_KEY}"`,
    );
  }

  const content: SpecificContent = {};
  const encodedKeys: string[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;

    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      content[key] = value;
      continue;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new BusinessException(`Field "${key}" is ${String(value)}, which JSON cannot represent`);
      }
      content[key] = value;
      continue;
    }

    // Dates are primitives to Orchestrator, but only in ISO form.
    if (value instanceof Date) {
      content[key] = value.toISOString();
      continue;
    }

    content[key] = JSON.stringify(value);
    encodedKeys.push(key);
  }

  if (encodedKeys.length > 0) content[JSON_FIELDS_KEY] = JSON.stringify(encodedKeys);
  return content;
}

export function fromSpecificContent(content: Record<string, unknown> | null | undefined): unknown {
  if (content === null || content === undefined) return {};

  const encodedKeys = readEncodedKeys(content[JSON_FIELDS_KEY]);
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(content)) {
    if (key === JSON_FIELDS_KEY) continue;

    if (!encodedKeys.has(key)) {
      payload[key] = value;
      continue;
    }

    if (typeof value !== 'string') {
      // The marker says this was encoded but the value is not a string. Trust
      // the value over the marker rather than throwing: the item may have been
      // edited by hand in the Orchestrator UI, and losing the run over it would
      // be worse than passing the value through.
      payload[key] = value;
      continue;
    }

    try {
      payload[key] = JSON.parse(value);
    } catch {
      payload[key] = value;
    }
  }

  return payload;
}

function readEncodedKeys(marker: unknown): ReadonlySet<string> {
  if (typeof marker !== 'string' || marker.length === 0) return new Set();

  try {
    const parsed: unknown = JSON.parse(marker);
    if (Array.isArray(parsed)) return new Set(parsed.filter((key): key is string => typeof key === 'string'));
  } catch {
    // Fall through: tolerate the older comma-separated form, and anything a
    // human might have typed into the field by hand.
  }

  return new Set(marker.split(',').map((key) => key.trim()).filter((key) => key.length > 0));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
