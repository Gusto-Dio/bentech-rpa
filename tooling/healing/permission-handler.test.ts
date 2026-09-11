import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createPermissionHandler, evaluate } from './permission-handler.ts';
import { Transcript } from './transcript.ts';

const REPO = '/srv/bentech-rpa';
const AUTO = 'automations/group-submission/anthem-ca-new-plans';

function ask(toolName: string, input: Record<string, unknown>) {
  return evaluate({ toolName, input }, REPO);
}

describe('evaluate - the tool gate runs first', () => {
  it('refuses a denied tool without looking at its input', () => {
    const decision = ask('mcp__playwright__browser_click', { element: 'Continue' });
    assert.equal(decision.allowed, false);
    assert.equal(decision.ruleId, 'tool.denied');
  });

  it('permits a read-only browser verb with no further checks', () => {
    assert.equal(ask('mcp__playwright__browser_snapshot', {}).allowed, true);
  });
});

describe('evaluate - Bash', () => {
  it('refuses the frozen run command', () => {
    const decision = ask('Bash', { command: 'pnpm rpa run group-submission/anthem-ca-new-plans' });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /rule 10a/);
  });

  it('refuses it hidden behind a permitted prefix', () => {
    assert.equal(
      ask('Bash', { command: 'pnpm check; pnpm rpa run group-submission/anthem-ca-new-plans' }).allowed,
      false,
    );
  });

  it('permits the gate', () => {
    assert.equal(ask('Bash', { command: 'pnpm check' }).allowed, true);
  });

  it('refuses a malformed call rather than passing it through', () => {
    const decision = ask('Bash', {});
    assert.equal(decision.allowed, false);
    assert.equal(decision.ruleId, 'bash.malformed');
  });
});

describe('evaluate - Read', () => {
  it('refuses the session file, absolute or relative', () => {
    assert.equal(ask('Read', { file_path: 'data/sessions/anthem-ca.json' }).allowed, false);
    assert.equal(ask('Read', { file_path: `${REPO}/data/sessions/anthem-ca.json` }).allowed, false);
  });

  it('permits reading doctrine', () => {
    assert.equal(ask('Read', { file_path: `${REPO}/AGENTS.md` }).allowed, true);
  });
});

describe('evaluate - Write and Edit', () => {
  it('permits a page-object edit', () => {
    const decision = ask('Edit', {
      file_path: `${REPO}/${AUTO}/src/pages/group-setup.page.ts`,
      new_string: "page.getByRole('combobox', { name: 'Group County' })",
    });
    assert.equal(decision.allowed, true);
  });

  it('refuses a write to the shared engine', () => {
    assert.equal(
      ask('Write', { file_path: `${REPO}/packages/core/src/steps.ts`, content: 'x' }).allowed,
      false,
    );
  });

  /**
   * THE ONE THAT MATTERS MOST. The path is writable and the content is not:
   * a tree containing `allowSubmit: true` is one command away from a real
   * signed application, so it must never reach disk.
   */
  it('refuses allowSubmit: true even in a file it may otherwise write', () => {
    const decision = ask('Edit', {
      file_path: `${REPO}/${AUTO}/src/processTransaction.ts`,
      new_string: 'const config = { allowSubmit: true };',
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.ruleId, 'content.denied');
    assert.match(decision.reason, /rule 10/);
  });

  it('checks every field a proposed edit might arrive in', () => {
    for (const field of ['content', 'new_string', 'new_str']) {
      const decision = ask('Write', {
        file_path: `${REPO}/${AUTO}/src/pages/x.page.ts`,
        [field]: 'allowSubmit = true',
      });
      assert.equal(decision.allowed, false, `${field} must be inspected`);
    }
  });

  it('refuses a malformed call', () => {
    assert.equal(ask('Edit', { new_string: 'x' }).ruleId, 'write.malformed');
  });

  /** Path first: an out-of-scope file is refused before its content is judged. */
  it('reports the path reason, not the content reason, when both would fail', () => {
    const decision = ask('Write', {
      file_path: `${REPO}/config/platform.json`,
      content: 'allowSubmit: true',
    });
    assert.equal(decision.ruleId, 'write.denied');
  });
});

describe('createPermissionHandler', () => {
  async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'heal-transcript-'));
    try {
      return await body(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('records every decision, allowed and denied', async () => {
    await withDir(async (dir) => {
      const transcript = new Transcript({ dir, secretValues: [] });
      const handle = createPermissionHandler({ transcript, repoRoot: REPO });

      await handle({ toolName: 'Bash', input: { command: 'pnpm check' } });
      await handle({ toolName: 'Bash', input: { command: 'pnpm rpa run group-submission/anthem-ca-new-plans' } });

      const lines = (await readFile(path.join(dir, 'transcript.jsonl'), 'utf8')).trim().split('\n');
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

      assert.equal(events.length, 2);
      assert.equal(events[0]?.['decision'], 'allow');
      assert.equal(events[1]?.['decision'], 'deny');
      assert.match(String(events[1]?.['reason']), /rule 10a/);
    });
  });

  /**
   * Never `allow_always`. A single approval widening for the rest of the
   * session defeats the point of deciding per call.
   */
  it('grants once, never always', async () => {
    await withDir(async (dir) => {
      const handle = createPermissionHandler({
        transcript: new Transcript({ dir, secretValues: [] }),
        repoRoot: REPO,
      });

      const outcome = await handle({ toolName: 'Bash', input: { command: 'pnpm check' } });
      assert.equal(outcome.grant, 'allow_once');
    });
  });

  /** Three fights with the wall is an escalation, not persistence. */
  it('tracks a denial streak, and resets it on an allow', async () => {
    await withDir(async (dir) => {
      const transcript = new Transcript({ dir, secretValues: [] });
      const handle = createPermissionHandler({ transcript, repoRoot: REPO });

      await handle({ toolName: 'Bash', input: { command: 'curl https://example.com' } });
      await handle({ toolName: 'Bash', input: { command: 'gh pr merge 1' } });
      assert.equal(transcript.denialStreak, 2);

      await handle({ toolName: 'Bash', input: { command: 'pnpm check' } });
      assert.equal(transcript.denialStreak, 0);
    });
  });

  /** The transcript is an audit artifact; a credential in it is a credential leaked. */
  it('scrubs known secret values out of a recorded tool input', async () => {
    await withDir(async (dir) => {
      const transcript = new Transcript({ dir, secretValues: ['Featherstonehaugh', 'AG7741QX'] });
      const handle = createPermissionHandler({ transcript, repoRoot: REPO });

      await handle({
        toolName: 'Write',
        input: { file_path: `${REPO}/.tmp/heal/note.md`, content: 'Agent Featherstonehaugh at AG7741QX' },
      });

      const raw = await readFile(path.join(dir, 'transcript.jsonl'), 'utf8');
      assert.doesNotMatch(raw, /Featherstonehaugh/);
      assert.doesNotMatch(raw, /AG7741QX/);
      assert.match(raw, /<redacted>/);
    });
  });

  it('scrubs a sensitive field by name, for a JSON-shaped input', async () => {
    await withDir(async (dir) => {
      const transcript = new Transcript({ dir, secretValues: [] });
      const handle = createPermissionHandler({ transcript, repoRoot: REPO });

      await handle({
        toolName: 'Write',
        input: { file_path: `${REPO}/.tmp/heal/x.json`, content: '{"password":"hunter2","ssn":"123-45-6789"}' },
      });

      const raw = await readFile(path.join(dir, 'transcript.jsonl'), 'utf8');
      assert.doesNotMatch(raw, /hunter2/);
      assert.doesNotMatch(raw, /123-45-6789/);
    });
  });
});
