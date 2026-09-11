/**
 * The labels the sentinel and the repair half agree on.
 *
 * This repository starts with only GitHub's nine defaults, so every one of
 * these has to be created. They are defined as data rather than documented as a
 * setup step, because a documented setup step is one that gets skipped on the
 * day it matters and the failure mode is silent: `POST /issues` with an unknown
 * label simply creates the issue without it, and the dedup query then never
 * finds it again.
 *
 * ── THE ONE THAT IS NOT COSMETIC ────────────────────────────────────────────
 * `portal-sentinel` is the dedup search key. Every sentinel-filed issue carries
 * it, and `listOpen` filters on it. Renaming it orphans every open finding.
 */

export interface LabelDefinition {
  name: string;
  /** Six hex digits, no `#` - GitHub's own format. */
  color: string;
  description: string;
}

export const SENTINEL_LABELS = {
  /** On every sentinel-filed issue. The dedup key. */
  all: 'portal-sentinel',
  /** Selector or flow drift. A repair session should act. */
  healable: 'sentinel:healable',
  /** Still passing, but a screen moved. Pre-emptive. */
  drift: 'sentinel:drift',
  /** The environment is wrong. No code change fixes it. */
  infra: 'sentinel:infra',
  /** A person must act - a lockout, a credential, a cleanup. */
  human: 'sentinel:human',
  /** The anti-storm valve fired. */
  storm: 'sentinel:storm',
  /** A repair session has claimed this. The sentinel then comments no further. */
  healingInProgress: 'sentinel:healing-in-progress',
  /** The handoff contract to the repair half: only ever with `healable`. */
  agentReady: 'agent-ready',
  /**
   * A standing warning on every Anthem issue.
   *
   * Not decoration. Whoever picks the issue up - human or agent - arrives
   * without the context that a run creates a real account and a real quote, and
   * the label is visible in a list view where the body is not.
   */
  frozen: 'frozen:anthem-prod',
} as const;

export const LABEL_DEFINITIONS: readonly LabelDefinition[] = [
  { name: SENTINEL_LABELS.all, color: '6e7781', description: 'Filed by the portal sentinel' },
  {
    name: SENTINEL_LABELS.healable,
    color: 'd73a4a',
    description: 'Selector or flow drift - a repair session can act on this',
  },
  {
    name: SENTINEL_LABELS.drift,
    color: 'fbca04',
    description: 'The probe still passes, but the screen changed. Nothing is broken yet',
  },
  {
    name: SENTINEL_LABELS.infra,
    color: '0075ca',
    description: 'Environment, not code. No page-object change will fix it',
  },
  {
    name: SENTINEL_LABELS.human,
    color: 'd93f0b',
    description: 'A person must act - a lockout, a credential, a cleanup',
  },
  {
    name: SENTINEL_LABELS.storm,
    color: '5319e7',
    description: 'The sentinel hit its own rate limit and is reporting that rather than staying silent',
  },
  {
    name: SENTINEL_LABELS.healingInProgress,
    color: 'c2e0c6',
    description: 'A repair session has claimed this issue; the sentinel will not comment further',
  },
  {
    name: SENTINEL_LABELS.agentReady,
    color: '0e8a16',
    description: 'Carries everything a repair session needs to start: run id, screen URL, artifacts',
  },
  {
    name: SENTINEL_LABELS.frozen,
    color: '000000',
    description: 'Anthem production is frozen to login and navigation - never run the automation',
  },
];

/** Probe labels are bounded (one per probe), so they are derived rather than listed. */
export function probeLabel(probeId: string): string {
  const [, probe = probeId] = probeId.split('/');
  return `probe:${probe}`;
}

export function carrierLabel(carrier: string): string {
  return `carrier:${carrier}`;
}
