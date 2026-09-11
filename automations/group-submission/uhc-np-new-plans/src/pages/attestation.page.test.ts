import { BusinessException } from '@rpa/core';
import { createTestLogger } from '@rpa/testkit';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';
import type { AutomationConfig } from '../config.ts';
import type { ProducerIdentity } from '../producer-identity.ts';
import { AttestationPage, guardedByAllowSubmit } from './attestation.page.ts';

/**
 * No browser at all: the guard fires before any locator is touched, which is
 * the property under test. `{}` as the page proves it - if any method reached a
 * locator, it would throw a TypeError rather than a BusinessException.
 */
const page = {} as Page;
const steps = { logger: createTestLogger() };
const producer = { fullName: 'Test Producer' } as ProducerIdentity;

function configWith(allowSubmit: boolean): AutomationConfig {
  return { allowSubmit } as unknown as AutomationConfig;
}

describe('guardedByAllowSubmit', () => {
  it('refuses with a BusinessException when the guard is closed', () => {
    assert.throws(() => guardedByAllowSubmit(configWith(false), 'do the thing'), BusinessException);
  });

  /**
   * Business, not System, on purpose: a SystemException would be RETRIED, and a
   * retry would re-drive a partially-filled application against production.
   */
  it('names the guard in the message, so the log explains itself', () => {
    assert.throws(
      () => guardedByAllowSubmit(configWith(false), 'submit the attestation'),
      /allowSubmit is false/,
    );
  });

  it('permits the action when the guard is explicitly open', () => {
    assert.doesNotThrow(() => guardedByAllowSubmit(configWith(true), 'do the thing'));
  });
});

describe('AttestationPage with allowSubmit false', () => {
  const attestation = new AttestationPage(page, steps, configWith(false));

  /**
   * Every public method is asserted INDIVIDUALLY, so a method added later
   * cannot become the one that signs. A single test over submitAttestation()
   * would pass while a new unguarded method filed a real application.
   */
  const methods: Array<[string, () => Promise<unknown>]> = [
    ['acknowledgeAttestations', () => attestation.acknowledgeAttestations()],
    ['signAsProducer', () => attestation.signAsProducer(producer)],
    ['submitAttestation', () => attestation.submitAttestation()],
    ['downloadCompletedApplication', () => attestation.downloadCompletedApplication('/tmp', 'UHC-NP-0001')],
  ];

  for (const [name, call] of methods) {
    it(`${name} refuses to act`, async () => {
      await assert.rejects(call, BusinessException);
    });
  }

  /**
   * The count is asserted so that adding a public method to AttestationPage
   * fails this test until it is listed above and proven guarded.
   */
  it('covers every public method on the class', () => {
    const own = Object.getOwnPropertyNames(AttestationPage.prototype).filter((n) => n !== 'constructor');
    assert.deepEqual(own.sort(), methods.map(([name]) => name).sort());
  });
});
