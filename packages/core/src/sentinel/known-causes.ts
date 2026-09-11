import type { ProbeEvidence, RuntimeFacts } from './types.ts';

/**
 * Causes we already understand, as data.
 *
 * ── WHY DATA AND NOT A CHAIN OF `if`s ───────────────────────────────────────
 * `AGENTS.md`'s "Gotchas that have already cost time" is a 37-row table of
 * failures this team has already diagnosed once. A monitor that files a healing
 * issue for an orphaned browser profile, an untrusted corporate CA, or a
 * deliberately headless run has not saved anyone any work - it has generated
 * some. Each of those has a known remedy that no code change will improve.
 *
 * Holding them as records rather than as branches buys three things: the
 * catalog can be unit-tested against synthetic evidence, a matched cause can
 * put its own `reference` and `remedy` verbatim into the issue, and adding a
 * row is a data change a reviewer can read.
 *
 * ── WHAT BELONGS HERE, AND WHAT BELONGS BESIDE A PROBE ──────────────────────
 * This file is generic. It must not name a carrier host: `packages/core` is
 * shared by every automation, and a hostname here would be a carrier leaking
 * into the engine. Carrier-specific causes live next to the carrier's probes
 * and are concatenated with these.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** What triage should do about a matched cause. */
export type CauseAction =
  /**
   * Record it and file nothing.
   *
   * Not a shrug. It is the correct answer for a documented, self-correcting or
   * operator-caused condition - a headless run against a carrier that blocks
   * headless is a mistake in the invocation, and the remedy is already written
   * down.
   */
  | 'none'
  /** The environment is wrong. No code change fixes it. */
  | 'infra'
  /** A person must act - a locked account, a credential, a cleanup. */
  | 'human'
  /** Our code is wrong in a way an agent could plausibly repair. */
  | 'healable';

export interface KnownCause {
  /** Stable, kebab-case, and part of the fingerprint. Renaming one re-files it. */
  id: string;
  title: string;
  /** Probe ids this applies to, or `'any'`. */
  probes: readonly string[] | 'any';
  match: {
    /** Tested against the error message, the portal wording, and the body sample. */
    text?: readonly RegExp[];
    /**
     * Matched against the PARSED host, never against a whole URL.
     *
     * On this portal the OAuth hosts quote each other inside query strings, so
     * a whole-URL regex identifies the wrong page in both directions. That
     * mistake already cost a debugging pass once.
     */
    host?: readonly string[];
    status?: readonly number[];
    step?: readonly string[];
    env?: (facts: RuntimeFacts) => boolean;
  };
  action: CauseAction;
  /** Where it is written down. Quoted verbatim into the issue. */
  reference: string;
  /** What to actually do. Also quoted verbatim. */
  remedy: string;
}

/**
 * Wording carriers use when they have decided we are a bot.
 *
 * Moved here from `check-portal-access.ts`, where it was a local `REFUSALS`
 * const. That move is the test of whether this catalog does real work: after
 * it, the access probe's bot-block detection IS the catalog rather than a
 * second opinion beside it.
 */
export const BOT_REFUSAL_PATTERNS: readonly RegExp[] = [
  /access denied/i,
  /request (?:was )?blocked/i,
  /unusual traffic/i,
  /are you a (?:human|robot)/i,
  /pardon our interruption/i,
  /reference\s*#\d/i,
];

export const GENERIC_CAUSES: readonly KnownCause[] = [
  /**
   * FIRST, and the order matters. A headless run against a carrier that blocks
   * headless is an invocation mistake with a documented fix, so it must be
   * recognised before the generic bot-block row turns it into an infra issue
   * somebody has to triage.
   */
  {
    id: 'headless-blocked',
    title: 'The carrier refused a headless browser',
    probes: 'any',
    match: { text: BOT_REFUSAL_PATTERNS, env: (facts) => facts.headless },
    action: 'none',
    reference: 'AGENTS.md gotchas: `Access Denied` from brokerportal.anthem.com',
    remedy:
      'Expected. This carrier serves a bot-block page to headless Chromium and loads normally headed. ' +
      'Run with HEADLESS=false; in the container use `--entrypoint tooling/docker/with-display.sh` ' +
      'so xvfb supplies a virtual display. Nothing to fix in code.',
  },
  {
    id: 'carrier-bot-block',
    title: 'The carrier is refusing this runtime as a bot',
    probes: 'any',
    match: { text: BOT_REFUSAL_PATTERNS },
    action: 'infra',
    reference: 'AGENTS.md gotchas: `Access Denied` from brokerportal.anthem.com',
    remedy:
      'The browser was headed and the carrier still refused it, so this is not the headless block. ' +
      'Capture the page, record it in the drift log, and check whether the egress IP or the ' +
      'user-agent changed. Do not retry in a loop - that is what escalates a block.',
  },
  {
    id: 'no-display',
    title: 'A headed browser was asked for with no display available',
    probes: 'any',
    match: {
      env: (facts) =>
        !facts.headless && facts.platform.startsWith('linux') && facts.display === undefined,
    },
    action: 'infra',
    reference: 'tooling/docker/with-display.sh',
    remedy:
      'HEADLESS=false on Linux with no DISPLAY. Overriding the container entrypoint outright loses ' +
      'the virtual display, which then produces the very bot-block this probe exists to rule out. ' +
      'Use `--entrypoint tooling/docker/with-display.sh`.',
  },
  {
    id: 'corporate-ca',
    title: 'TLS interception - the corporate CA is not trusted here',
    probes: 'any',
    match: { text: [/ERR_CERT_AUTHORITY_INVALID/i, /unable to verify the first certificate/i] },
    action: 'infra',
    reference: 'AGENTS.md gotchas: ERR_CERT_AUTHORITY_INVALID in the container but not on macOS',
    remedy:
      'Run ./tooling/scripts/export-corporate-ca.sh then rebuild the image. THREE trust stores are ' +
      'involved: the system one, Node via NODE_EXTRA_CA_CERTS, and Chromium’s NSS store at ' +
      '~/.pki/nssdb via certutil - not /etc/ssl/certs. `openssl s_client` reporting ' +
      '"Verify return code: 0" while the browser still fails is the trap. Never "fix" this with ' +
      'ignoreHTTPSErrors: it disables certificate validation for runs that sign in to carrier ' +
      'portals with real credentials.',
  },
  {
    id: 'orphan-profile-lock',
    title: 'An orphaned browser is still holding the persistent profile',
    probes: 'any',
    match: {
      text: [
        /profile is already in use/i,
        /Opening in existing browser session/i,
        /SingletonLock/i,
      ],
    },
    action: 'infra',
    reference: 'AGENTS.md gotchas: launchPersistentContext / the profile is already in use',
    remedy:
      'A run that aborted left its browser alive. Twenty accumulated once, and every later run then ' +
      'failed for THIS reason instead of its own. Clear with: ps -Ao pid=,command= | ' +
      'grep "user-data-dir=.*data/profiles" | awk \'{print $1}\' | xargs kill',
  },
  {
    id: 'session-file-unreadable',
    title: 'The stored session file could not be parsed',
    probes: 'any',
    match: { text: [/not a storageState document/i, /Stored session file is unreadable/i] },
    action: 'none',
    reference: 'automations/group-submission/_shared/src/carrier-portal-session.ts',
    remedy:
      'Self-correcting: a corrupt session file is treated as "no session", so the cost is one extra ' +
      'sign-in rather than a wedged run. Worth an issue only if it recurs, which would mean ' +
      'something is writing the file badly rather than the file simply being stale.',
  },
  {
    id: 'mfa-code-never-arrived',
    title: 'The one-time code did not arrive inside its budget',
    probes: 'any',
    match: { text: [/no mfa code/i, /code did not arrive/i, /mfa.*timed out/i] },
    action: 'infra',
    reference: 'AGENTS.md rule 10b and docs/poc/mfa-gmail.md',
    remedy:
      'Check the mailbox first with `pnpm rpa mfa check`. Do NOT raise mfaTimeoutMs: it was tuned ' +
      'twice against a broken reader and both readings were wrong. Measured delivery is 132-600s ' +
      'through the forward, and a code that arrives after its countdown has expired is useless ' +
      'however long you wait. If none arrives, something is broken - a longer timeout hides it.',
  },
];

export interface CauseMatch {
  cause: KnownCause;
  /** Which field matched, for the report. */
  matchedOn: string;
}

/**
 * First match wins, so catalog ORDER is part of the behaviour.
 *
 * Specific rows must precede general ones - `headless-blocked` before
 * `carrier-bot-block` - and a test pins that, because reordering the array is
 * an easy and silent way to change what gets filed.
 */
export function matchKnownCause(
  evidence: ProbeEvidence,
  causes: readonly KnownCause[],
): CauseMatch | undefined {
  const haystack = [
    evidence.error?.message ?? '',
    evidence.portalMessage?.text ?? '',
    ...evidence.screens.flatMap((screen) => screen.signature.alerts),
    evidence.screens.at(-1)?.signature.modal.text ?? '',
  ]
    .filter((entry) => entry !== '')
    .join('\n');

  const hosts = evidence.screens.map((screen) => screen.signature.location.host);

  for (const cause of causes) {
    if (cause.probes !== 'any' && !cause.probes.includes(evidence.probeId)) continue;

    /**
     * Every declared criterion must hold. A cause listing both `text` and `env`
     * means "this wording, in this environment" - which is exactly what
     * separates `headless-blocked` from `carrier-bot-block`, the two rows whose
     * confusion would file the most useless issues.
     */
    const criteria: readonly (boolean | undefined)[] = [
      cause.match.text === undefined
        ? undefined
        : cause.match.text.some((pattern) => pattern.test(haystack)),
      cause.match.host === undefined
        ? undefined
        : hosts.some((host) => cause.match.host?.includes(host) === true),
      cause.match.step === undefined
        ? undefined
        : evidence.failedStep !== undefined && cause.match.step.includes(evidence.failedStep),
      cause.match.env?.(evidence.runtime),
      cause.match.status === undefined
        ? undefined
        : evidence.httpStatus !== undefined && cause.match.status.includes(evidence.httpStatus),
    ];

    const declared = criteria.filter((value) => value !== undefined);
    if (declared.length === 0) continue;
    if (!declared.every(Boolean)) continue;

    return { cause, matchedOn: describeMatch(cause) };
  }

  return undefined;
}

function describeMatch(cause: KnownCause): string {
  return Object.entries(cause.match)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .join('+');
}
