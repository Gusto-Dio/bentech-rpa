import { BusinessException } from '@rpa/core';
import { createTestLogger } from '@rpa/testkit';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import type { Payload } from '../payload.ts';
import { SignaturePage } from './signature.page.ts';

/**
 * Stage 8 files a real application, so the parts worth testing without a
 * browser are the two that decide whether it CAN: the guard, and the promise
 * that the filing step is never skipped.
 */

const config = { allowSubmit: false } as unknown as AutomationConfig;
const steps = { logger: createTestLogger() };
const page = {} as Page;
const payload = { benefitsSignatory: { firstName: 'Jane', lastName: 'Doe', title: 'CEO' } } as Payload;

describe('the allowSubmit guard', () => {
  /**
   * Every public method, individually. The guard is repeated per method rather
   * than checked once in the constructor precisely so a method added later
   * cannot become the one that signs unguarded - and that only holds if each
   * one is actually covered.
   */
  const signature = new SignaturePage(page, steps, config);

  it('refuses chooseElectronicSignature', async () => {
    await assert.rejects(() => signature.chooseElectronicSignature(), BusinessException);
  });

  it('refuses enterSignatory', async () => {
    await assert.rejects(() => signature.enterSignatory(payload), BusinessException);
  });

  it('refuses signAndFile', async () => {
    await assert.rejects(() => signature.signAndFile(), BusinessException);
  });

  it('refuses saveSignedApplication', async () => {
    await assert.rejects(() => signature.saveSignedApplication('/tmp'), BusinessException);
  });

  it('names the guard in the message, so an operator knows why it stopped', async () => {
    await assert.rejects(() => signature.signAndFile(), (error: unknown) => {
      assert.ok(error instanceof BusinessException);
      assert.match(error.message, /allowSubmit/);
      assert.equal(error.details['guard'], 'allowSubmit');
      return true;
    });
  });
});

/**
 * A source-level check, which is unusual but earns its place.
 *
 * The filing step was once skipped entirely: its postcondition was
 * `textVisible(/signed|submitted|complete/i)`, the wizard rail prints
 * "Completed" beside every finished step, so `step()` decided the work was
 * already done and never signed - while the run reported `submitted: 1`.
 *
 * A false success on the one action that cannot be checked by looking at the
 * screen afterwards is the worst thing this automation can do, and no
 * browserless test of behaviour can catch it. Pinning the two properties that
 * prevent it is the next best thing.
 */
describe('the filing step cannot be skipped', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'signature.page.ts'), 'utf8');
  const signAndFile = source.slice(source.indexOf('async signAndFile'));
  const withComments = signAndFile.slice(0, signAndFile.indexOf('async saveSignedApplication'));

  /**
   * Comments stripped, because the comment above the fix quotes the very
   * expression the fix removed - and a naive source scan then flags the
   * explanation as the defect.
   */
  const body = withComments.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('marks the filing step alwaysRun', () => {
    assert.match(body, /alwaysRun:\s*true/, 'signAndFile must never take the skip-ahead branch');
  });

  it('does not gate the filing on loose page text', () => {
    assert.doesNotMatch(
      body,
      /textVisible\([^)]*complete/i,
      'a /complete/ text match is satisfied by the wizard rail on every screen',
    );
  });

  /**
   * The ceremony has a `Close` button bottom-right that DISCARDS the envelope.
   * A blind `click(/^close$/i)` - added to dismiss an AI popover whose X is
   * also called "Close" - abandoned a signing whose fields had been filled
   * correctly. Nothing in this step may target "Close" by name again.
   */
  it('never targets a control called Close, which abandons the envelope', () => {
    /**
     * `close(?!d)` rather than plain `close`: the step legitimately calls
     * `#ceremonyClosed()` to wait for the frame to disappear, and a blunt
     * /close/i match flagged that as the defect. What is forbidden is
     * TARGETING a control named Close, not the word appearing at all.
     */
    assert.doesNotMatch(
      body,
      /close(?!d)/i,
      'Close discards the DocuSign envelope; dismiss overlays with Escape instead',
    );
  });
});
