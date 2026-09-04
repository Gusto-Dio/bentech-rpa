import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPortalComplaint } from './portal-errors.ts';

/**
 * This function decides Business vs System for every screen in the automation,
 * so both directions of getting it wrong are expensive:
 *
 *  - a missed complaint becomes a SystemException, and the runner burns three
 *    browser relaunches on a rule that will never change its mind;
 *  - a FALSE complaint fails a healthy transaction, and it did exactly that on
 *    run `20260903T213924Z-ee0266`, immediately after the application had been
 *    signed and filed.
 *
 * Every string below is one the live portal actually produced.
 */
describe('isPortalComplaint - real messages the portal rejected input with', () => {
  const complaints = [
    'Error: Group Contact Name is required.',
    'Error: Please select a county.',
    "That SIC code isn't valid. Please double check it and try again.",
    'Please enter a valid ZIP code',
    'The group name exceeds the maximum length',
  ];

  for (const text of complaints) {
    it(`treats as a complaint: "${text.slice(0, 45)}"`, () => {
      assert.equal(isPortalComplaint(text), true);
    });
  }
});

describe('isPortalComplaint - messages that are NOT complaints', () => {
  /**
   * THE REGRESSION. Anthem's post-signature toast, verbatim and in one element
   * - note the `Success` prefix run together with the sentence, and that it is
   * an SLDS success toast carrying `role="alert"` like every other toast.
   *
   * `PROBLEM_WORDING` matches it on `please select`, so the confirmation of a
   * successful signature was read as a validation error and the transaction was
   * reported as a business failure AFTER filing a real application.
   */
  it('does not treat the post-signature success toast as a complaint', () => {
    assert.equal(
      isPortalComplaint(
        'SuccessYou have successfully signed the document. Please select Continue to move to the next step.',
      ),
      false,
    );
  });

  it('does not treat other success wording as a complaint', () => {
    assert.equal(isPortalComplaint('Success'), false);
    assert.equal(isPortalComplaint('Your census was uploaded successfully'), false);
  });

  /**
   * The dashboard's own informational banner, which sits in the same alert
   * region. Treating it as a validation failure would turn a healthy screen
   * into a BusinessException that no retry can clear.
   */
  it('does not treat an informational banner as a complaint', () => {
    assert.equal(isPortalComplaint("We've redesigned your dashboard! Take the tour now."), false);
  });

  it('does not treat neutral guidance as a complaint', () => {
    assert.equal(isPortalComplaint('Follow the steps below to upload documents.'), false);
    assert.equal(isPortalComplaint('2 out of 23 documents uploaded'), false);
  });

  /**
   * A genuine complaint that happens to contain the word "select" must still
   * be caught - the fix must not have blunted the detector.
   */
  it('still catches a complaint that asks us to select something', () => {
    assert.equal(isPortalComplaint('Please select a plan before continuing'), true);
  });
});
