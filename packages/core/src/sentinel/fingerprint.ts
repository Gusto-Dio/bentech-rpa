import { createHash } from 'node:crypto';
import type { ProbeEvidence } from './types.ts';

/**
 * The identity of a finding, so the same problem is filed once.
 *
 * A monitor running every fifteen minutes will see one broken screen ninety-six
 * times a day. Without a stable identity that is ninety-six GitHub issues, and
 * the monitor is then worse than nothing, because nobody reads it any more.
 *
 * ── WHAT IS IN IT, AND WHY ──────────────────────────────────────────────────
 * Everything here is a property of the PROBLEM. Nothing here is a property of
 * the RUN. A run id, a timestamp, an elapsed duration or an alert's exact
 * wording would each make every cycle a new finding.
 *
 * `deltaShape` in particular is counts, not values: a portal that rewords a
 * button between two readings must not mint a new fingerprint for what is
 * plainly the same drift.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type FindingKind = 'failure' | 'drift' | 'unknown-screen' | 'infra' | 'human';

export interface FindingFingerprint {
  /**
   * Bumping this deliberately re-files EVERYTHING currently open.
   *
   * It is the escape hatch for "the identity rule itself was wrong", and it
   * deserves to be treated as an incident-scale change rather than a tidy-up.
   */
  version: 1;
  probeId: string;
  kind: FindingKind;
  screenId: string | undefined;
  step: string | undefined;
  gate: 'precondition' | 'postcondition' | undefined;
  /** `BusinessException` | `SystemException` | `TimeoutError` | ... */
  errorClass: string | undefined;
  /** Id from the known-cause catalog, when one matched. */
  causeId: string | undefined;
  deltaShape: string | undefined;
  /** First 12 hex of a sha256 over the canonical encoding of the fields above. */
  hash: string;
}

export interface FingerprintInput {
  probeId: string;
  kind: FindingKind;
  screenId?: string;
  step?: string;
  gate?: 'precondition' | 'postcondition';
  errorClass?: string;
  causeId?: string;
  deltaShape?: string;
}

const FINGERPRINT_VERSION = 1 as const;

/**
 * Length-prefixed, rather than joined on a separator.
 *
 * Step names and alert wordings contain commas, colons and pipes, so any
 * printable separator can also occur inside a field - and then two different
 * findings collide: `step="a:b"` with `gate="c"` joins identically to
 * `step="a"` with `gate="b:c"`. Prefixing each part with its length makes the
 * encoding unambiguous whatever the content, which a separator cannot promise.
 */
function canonical(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}

export function fingerprint(input: FingerprintInput): FindingFingerprint {
  const parts: readonly string[] = [
    `v${FINGERPRINT_VERSION}`,
    input.probeId,
    input.kind,
    input.screenId ?? '-',
    input.step ?? '-',
    input.gate ?? '-',
    input.errorClass ?? '-',
    input.causeId ?? '-',
    input.deltaShape ?? '-',
  ];

  const hash = createHash('sha256').update(canonical(parts)).digest('hex').slice(0, 12);

  return {
    version: FINGERPRINT_VERSION,
    probeId: input.probeId,
    kind: input.kind,
    screenId: input.screenId,
    step: input.step,
    gate: input.gate,
    errorClass: input.errorClass,
    causeId: input.causeId,
    deltaShape: input.deltaShape,
    hash,
  };
}

/**
 * The marker embedded in an issue body, and the only thing dedup looks for.
 *
 * An HTML comment, because GitHub hides it - the body a human reads is not
 * cluttered by the machinery that keeps it unique. In the BODY rather than the
 * title, so retitling an issue (a reasonable thing for a human to do) cannot
 * orphan it and cause a duplicate to be filed alongside.
 */
export function fingerprintMarker(value: FindingFingerprint): string {
  return `<!-- sentinel-fingerprint: v${value.version}:${value.hash} -->`;
}

/** Recovers a fingerprint hash from an issue body, for dedup. */
export function readFingerprintMarker(body: string): { version: number; hash: string } | undefined {
  const match = /<!--\s*sentinel-fingerprint:\s*v(\d+):([0-9a-f]{12})\s*-->/.exec(body);
  if (match === null) return undefined;
  return { version: Number(match[1]), hash: match[2] ?? '' };
}

/**
 * Derives the evidence-shaped parts of a fingerprint.
 *
 * `kind` and `causeId` are deliberately absent: they are judgements, and the
 * triage table owns them. Deriving them here too would put one decision in two
 * places, which is how a printed reason and a filed issue come to disagree.
 */
export function fingerprintPartsFrom(evidence: ProbeEvidence): Omit<FingerprintInput, 'kind'> {
  /**
   * The screen that actually went wrong, preferred over the first one visited.
   * A probe passes through several screens on the way; the drifted or
   * unbaselined one is the finding.
   */
  const drifted = evidence.screens.find((screen) => screen.delta?.meaningful === true);
  const unbaselined = evidence.screens.find((screen) => screen.baseline === 'absent');
  const screen = drifted ?? unbaselined ?? evidence.screens.at(-1);
  const shape = screen?.delta?.shape;

  return {
    probeId: evidence.probeId,
    screenId: screen?.screenId,
    step: evidence.failedStep,
    gate: evidence.failedGate,
    errorClass: evidence.error?.name,
    deltaShape: shape === undefined || shape === '' ? undefined : shape,
  };
}
