import { BusinessException } from '@rpa/core';
import { createTestLogger } from '@rpa/testkit';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import { PostSignaturePage } from './post-signature.page.ts';

/**
 * The steps after the signature all act on an application that is already
 * FILED with the carrier, so - as with stage 8 - what is worth testing without
 * a browser is whether they can run at all, plus the properties that stop the
 * last step from being faked.
 */

const config = {
  allowSubmit: false,
  memberEnrollmentType: 'Online Census Tool',
} as unknown as AutomationConfig;
const steps = { logger: createTestLogger() };
const page = {} as Page;

describe('the allowSubmit guard on the post-signature steps', () => {
  /**
   * Every public method, individually. The guard is repeated per method rather
   * than checked once in the constructor precisely so a method added later
   * cannot become the one that transmits - and that only holds if each one is
   * actually covered.
   */
  const post = new PostSignaturePage(page, steps, config);

  it('refuses acknowledgeSignature', async () => {
    await assert.rejects(() => post.acknowledgeSignature(), BusinessException);
  });

  it('refuses crossPostSigningSteps', async () => {
    await assert.rejects(
      () => post.crossPostSigningSteps(async () => undefined),
      BusinessException,
    );
  });

  it('refuses selectMemberEnrollmentType', async () => {
    await assert.rejects(() => post.selectMemberEnrollmentType(), BusinessException);
  });

  it('refuses reachDocumentChecklist', async () => {
    await assert.rejects(() => post.reachDocumentChecklist('02283813'), BusinessException);
  });

  it('refuses attachDocument', async () => {
    await assert.rejects(
      () => post.attachDocument('Waivers', '/tmp/waivers.pdf'),
      BusinessException,
    );
  });

  it('refuses submitChecklist', async () => {
    await assert.rejects(() => post.submitChecklist(), BusinessException);
  });

  it('refuses removeAllDocuments', async () => {
    await assert.rejects(() => post.removeAllDocuments(), BusinessException);
  });

  it('names the guard in the message, so an operator knows why it stopped', async () => {
    await assert.rejects(() => post.submitChecklist(), (error: unknown) => {
      assert.ok(error instanceof BusinessException);
      assert.match(error.message, /allowSubmit/);
      assert.equal(error.details['guard'], 'allowSubmit');
      return true;
    });
  });
});

/**
 * Source-level checks, for the same reason signature.page.test.ts has them: the
 * failure these prevent is a step reporting success without doing anything, and
 * no browserless test of behaviour can catch that.
 */
describe('the document checklist step is anchored to this transaction', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'post-signature.page.ts'), 'utf8');
  const method = source.slice(source.indexOf('async reachDocumentChecklist'));
  const withComments = method.slice(0, method.indexOf('async readChecklist'));

  /**
   * Comments stripped, because the comment above this step explains the trap by
   * quoting it - and a naive source scan then flags the explanation as the bug.
   */
  const body = withComments.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /**
   * Rule 9's trap, and it is a live risk here specifically: this is the LAST
   * step, so a postcondition satisfied by any checklist would let a run report
   * "reached the end of the wizard" while parked on the previous group's
   * screen.
   *
   * The anchor is the `Quote` row's file name, which carries this
   * transaction's quote number. An earlier version also read the screen's
   * `Application Name` field - which exists only on the STANDALONE checklist,
   * and so failed the step on a screen it had correctly reached.
   */
  it('anchors on the quote number carried by a checklist row', () => {
    assert.match(
      body,
      /filter\(\{\s*hasText:\s*quoteNumber\s*\}\)/,
      'the postcondition must identify THIS group, not merely "a checklist is on screen"',
    );
  });

  /**
   * The checklist populates server-side a few seconds after the step opens -
   * the screen shows `0 out of 0 documents uploaded` first. Reading the rows
   * once, rather than waiting on a locator, failed this step on a screen it had
   * reached correctly. `readChecklist()` is a snapshot and must not be the gate.
   */
  it('waits on a locator instead of snapshotting the rows', () => {
    assert.match(body, /visible\(/);
    assert.doesNotMatch(
      body,
      /readChecklist\(/,
      'readChecklist() is a one-shot read; an empty table means "not built yet", not "wrong screen"',
    );
  });

  /**
   * That field is absent in-wizard (`fields: []` in the failure evidence), so
   * reading it is how this step failed on a screen it had reached correctly.
   */
  it('does not read the Application Name field, which is standalone-only', () => {
    assert.doesNotMatch(body, /Application Name/);
  });
});

/**
 * `Submit` on the checklist carries `aria-label="documentCheckListSubmit"`, and
 * an aria-label WINS over the visible text - so `getByRole('button', { name:
 * 'Submit' })` matches nothing at all on the live screen. Measured 2026-09-03:
 * zero matches by role, one by text.
 *
 * The repo's `button()` helper filters on text and therefore works. Nothing
 * here may switch to a role-based lookup for these controls.
 */
describe('the checklist controls avoid the accessible-name trap', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'post-signature.page.ts'), 'utf8');
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('does not look up wizard buttons by role', () => {
    assert.doesNotMatch(
      body,
      /getByRole\(\s*'button'/,
      "this wizard's buttons hide behind disagreeing aria-labels; use button() from lightning.ts",
    );
  });

  /**
   * The file inputs are the real upload mechanism - one per row, indexed in row
   * order. Clicking the decorative `Choose File` button opens an OS file
   * picker, which cannot be driven.
   */
  it('uploads through the row file input rather than the Choose File button', () => {
    assert.match(body, /hidden-file-input/);
    assert.doesNotMatch(body, /Choose File/);
  });
});

/**
 * The checklist table is inside a Lightning shadow root.
 *
 * `document.querySelector('table.slds-table')` therefore finds nothing, and the
 * first version of this reader did precisely that: it threw "the table read as
 * empty" against a live screen displaying all 23 rows. That failure is
 * indistinguishable from a screen which has not finished rendering, so it would
 * have been debugged as a timing problem.
 *
 * Playwright's locators pierce shadow DOM; hand-written DOM traversal does not.
 * Anything in this file that walks the DOM by hand has to cross shadow roots.
 */
describe('the checklist reader crosses shadow roots', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'post-signature.page.ts'), 'utf8');
  const reader = source.slice(source.indexOf('const READ_CHECKLIST'));
  const body = reader.slice(0, reader.indexOf('export class'));

  it('walks shadowRoot rather than trusting querySelector', () => {
    assert.match(
      body,
      /shadowRoot/,
      'the table lives in a shadow root; querySelector alone reads the screen as empty',
    );
  });

  it('does not reach for the table with a bare document.querySelector', () => {
    assert.doesNotMatch(body, /document\.querySelector\(\s*'table/);
  });
});
