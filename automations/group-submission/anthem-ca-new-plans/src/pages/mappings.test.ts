import { BusinessException } from '@rpa/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applicationDate, organizationType, waitingPeriodOption } from './employer-application.page.ts';
import { MedicalPlansPage } from './medical-plans.page.ts';
import { effectiveDateOption } from './portfolios.page.ts';

/**
 * This portal uses THREE date formats on three screens, and picking the wrong
 * one produces a validation error on one screen or a silently shifted date on
 * another. Pinning each to the screen that declares it is the only defence.
 */
describe('the three date formats', () => {
  it('the coverage effective date list has no comma', () => {
    assert.equal(effectiveDateOption('2026-09-01'), 'Sep 1 2026');
    assert.equal(effectiveDateOption('2026-12-31'), 'Dec 31 2026');
  });

  it('the employer application wants MM/DD/YYYY', () => {
    assert.equal(applicationDate('2024-01-03'), '01/03/2024');
    assert.equal(applicationDate('2026-12-31'), '12/31/2026');
  });

  it('both refuse anything that is not an ISO date rather than guessing', () => {
    assert.throws(() => effectiveDateOption('Sep 1 2026'), BusinessException);
    assert.throws(() => applicationDate('03/01/2024'), BusinessException);
  });
});

describe('organizationType', () => {
  /** Verified against the live picklist. */
  it('maps the payload entity type to the portal option', () => {
    assert.equal(organizationType('llc'), 'Limited Liability Company (LLC)');
    assert.equal(organizationType('Corporation'), 'Corporation');
  });

  /**
   * The picklist has an "Other", but choosing it is a judgement call with
   * consequences on a signed application - so an unmapped type stops.
   */
  it('refuses an entity type it does not know', () => {
    assert.throws(() => organizationType('cooperative'), BusinessException);
  });
});

describe('waitingPeriodOption', () => {
  it('maps the payload wording to the portal option', () => {
    assert.equal(waitingPeriodOption('1st, on/following hire'), 'First of month after hire date');
  });

  it('refuses wording it has never seen', () => {
    assert.throws(() => waitingPeriodOption('90 days'), BusinessException);
  });
});

describe('metalOf', () => {
  /**
   * The plan list shows only a handful at a time and `Show More` expands a card
   * rather than paging, so a plan outside the default view is invisible and
   * looks unsold. Metal is the one filter that works, and it comes from the
   * plan name - so getting this wrong reports an available plan as not offered.
   */
  it('reads the metal level out of the plan name', () => {
    assert.equal(MedicalPlansPage.metalOf('Anthem Bronze Select PPO 60/6850/40%'), 'Bronze');
    assert.equal(MedicalPlansPage.metalOf('Anthem Gold PPO 35/500/25%'), 'Gold');
    assert.equal(MedicalPlansPage.metalOf('Anthem Platinum Select PPO 5/200/15%'), 'Platinum');
    assert.equal(MedicalPlansPage.metalOf('Anthem Silver PPO 50/2200/40% 8V9F'), 'Silver');
  });

  it('is undefined when the name carries no metal level', () => {
    assert.equal(MedicalPlansPage.metalOf('Anthem Something Else PPO'), undefined);
  });
});
