import {
  decideBash,
  decideContent,
  decideRead,
  decideTool,
  decideWrite,
  type PolicyDecision,
} from './policy.ts';
import type { Transcript } from './transcript.ts';

/**
 * The gate every tool call passes through.
 *
 * ── THIS IS THE SECOND GATE, NOT THE ONLY ONE ───────────────────────────────
 * The handler only fires when the agent CHOOSES to ask. If the agent-side
 * configuration already permits a tool, no permission request is emitted and
 * nothing here runs. That is why `.claude/healing-permissions.json` carries the
 * same deny rules as an inner layer, and why `probe-self-test.ts` refuses to
 * start a heal until it has watched this handler actually deny something.
 *
 * Believing permissions are wired is not the same as measuring it - the same
 * distinction `check-portal-access.ts` draws when it says `rpa doctor` proves
 * Chromium starts, not that the carrier accepts it.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** The shape a permission request arrives in, reduced to what the policy needs. */
export interface PermissionRequest {
  toolName: string;
  /** Free-form tool input. Only the fields relevant to each tool are read. */
  input: Record<string, unknown>;
}

export interface PermissionOutcome {
  allowed: boolean;
  reason: string;
  ruleId: string;
  /**
   * Always `allow_once`, never `allow_always`.
   *
   * A one-line decision with a large blast radius: `allow_always` would let a
   * single approval silently widen for the remainder of the session, which
   * defeats the point of deciding per call.
   */
  grant: 'allow_once' | 'deny';
}

export interface HandlerOptions {
  transcript: Transcript;
  /** Repo root, so absolute tool paths can be made repo-relative. */
  repoRoot: string;
}

export function createPermissionHandler(
  options: HandlerOptions,
): (request: PermissionRequest) => Promise<PermissionOutcome> {
  return async (request: PermissionRequest): Promise<PermissionOutcome> => {
    const decision = evaluate(request, options.repoRoot);

    await options.transcript.record({
      kind: 'permission',
      tool: request.toolName,
      decision: decision.allowed ? 'allow' : 'deny',
      ruleId: decision.ruleId,
      reason: decision.reason,
      /** Handed over as an OBJECT: the transcript scrubs it structurally. */
      input: request.input,
    });

    return {
      allowed: decision.allowed,
      reason: decision.reason,
      ruleId: decision.ruleId,
      grant: decision.allowed ? 'allow_once' : 'deny',
    };
  };
}

/**
 * Pure, so it can be tested without a transcript or an agent.
 *
 * The tool-name gate runs first, then whatever the specific tool needs. An
 * `Edit` has to clear the path rule AND the content rule, because a path being
 * writable says nothing about `allowSubmit: true` appearing in it.
 */
export function evaluate(request: PermissionRequest, repoRoot: string): PolicyDecision {
  const tool = decideTool(request.toolName);
  if (!tool.allowed) return tool;

  const relative = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value === '') return undefined;
    const normalized = value.startsWith(repoRoot)
      ? value.slice(repoRoot.length).replace(/^\//, '')
      : value;
    return normalized.replace(/^\.\//, '');
  };

  switch (request.toolName) {
    case 'Bash': {
      const command = request.input['command'];
      if (typeof command !== 'string') {
        return { allowed: false, ruleId: 'bash.malformed', reason: 'a Bash call with no command string' };
      }
      return decideBash(command);
    }

    case 'Read': {
      const file = relative(request.input['file_path']);
      return file === undefined
        ? { allowed: false, ruleId: 'read.malformed', reason: 'a Read call with no file_path' }
        : decideRead(file);
    }

    case 'Write':
    case 'Edit': {
      const file = relative(request.input['file_path']);
      if (file === undefined) {
        return { allowed: false, ruleId: 'write.malformed', reason: `an ${request.toolName} call with no file_path` };
      }

      const write = decideWrite(file);
      if (!write.allowed) return write;

      /**
       * The PROPOSED text, not the file on disk. `allowSubmit: true` never
       * reaching the working tree is worth more than detecting it afterwards:
       * a tree containing it is one command away from a real signed
       * application.
       */
      const proposed = [
        request.input['content'],
        request.input['new_string'],
        request.input['new_str'],
      ]
        .filter((value): value is string => typeof value === 'string')
        .join('\n');

      return proposed === '' ? write : decideContent(file, proposed);
    }

    /**
     * Grep, Glob, TodoWrite, Task and the read-only browser verbs need nothing
     * beyond the tool gate: they cannot write to a file or to the portal, and
     * the browser's reach is fenced by `playwright-mcp.healing.json` rather
     * than by this handler.
     */
    default:
      return tool;
  }
}
