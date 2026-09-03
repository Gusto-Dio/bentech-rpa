import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BusinessException, SystemException } from './errors.ts';
import { createLogger } from './logger.ts';
import { step, type StepContext } from './steps.ts';

const ctx: StepContext = { logger: createLogger({ level: 'silent', pretty: false, base: {} }) };

const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

describe('step - the resume path', () => {
  /**
   * The reason the postcondition is checked first. Both carrier processes
   * document re-entering the portal mid-submission, so a re-run must skip what
   * already happened rather than doing it twice.
   */
  it('skips the action when the postcondition is already satisfied', async () => {
    let ran = false;
    const result = await step(ctx, {
      name: 'enter tax id',
      action: async () => {
        ran = true;
      },
      postcondition: yes,
    });

    assert.equal(result.outcome, 'skipped');
    assert.equal(ran, false, 'the action must not run when the step is already done');
  });

  it('alwaysRun forces the action even when the postcondition holds', async () => {
    let ran = false;
    const result = await step(ctx, {
      name: 'click generate quote',
      alwaysRun: true,
      action: async () => {
        ran = true;
      },
      postcondition: yes,
    });

    assert.equal(result.outcome, 'completed');
    assert.equal(ran, true);
  });
});

describe('step - preconditions', () => {
  it('raises a SystemException when we are not on the expected screen', async () => {
    let ran = false;
    await assert.rejects(
      step(ctx, {
        name: 'enter tax id',
        precondition: no,
        action: async () => {
          ran = true;
        },
        postcondition: no,
      }),
      (error: unknown) => {
        // System, not Business: the SESSION is wrong, so recovery is the fix.
        assert.ok(error instanceof SystemException);
        assert.match((error as Error).message, /Precondition failed/);
        return true;
      },
    );
    assert.equal(ran, false, 'the action must not run on a failed precondition');
  });

  it('captures evidence before throwing', async () => {
    const gates: string[] = [];
    await assert.rejects(
      step(
        { ...ctx, onGateFailure: async (info) => void gates.push(`${info.step}:${info.gate}`) },
        { name: 'enter tax id', precondition: no, action: async () => {}, postcondition: no },
      ),
      SystemException,
    );
    assert.deepEqual(gates, ['enter tax id:precondition']);
  });

  it('runs without a precondition when the action is safe from any screen', async () => {
    let calls = 0;
    const result = await step(ctx, {
      name: 'read confirmation',
      action: async () => 'ok',
      postcondition: async () => ++calls > 1,
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.value, 'ok');
  });
});

describe('step - the portal rejecting the data', () => {
  /**
   * The classification that matters most: the portal looked at the value and
   * refused it, so no retry will change the answer.
   */
  it('turns a portal validation message into a BusinessException carrying that wording', async () => {
    await assert.rejects(
      step(ctx, {
        name: 'enter group address',
        precondition: yes,
        action: async () => {},
        businessCheck: async () => 'Address exceeds 27 characters',
        // False, as it would be in reality: the portal refused the value, so the
        // field does not hold it. A `yes` here would short-circuit the whole
        // step as already-done and businessCheck would never run.
        postcondition: no,
      }),
      (error: unknown) => {
        assert.ok(error instanceof BusinessException);
        assert.match((error as Error).message, /Address exceeds 27 characters/);
        assert.equal((error as BusinessException).details['portalMessage'], 'Address exceeds 27 characters');
        return true;
      },
    );
  });

  it('proceeds when the portal says nothing', async () => {
    const result = await step(ctx, {
      name: 'enter group address',
      precondition: yes,
      action: async () => {},
      businessCheck: async () => undefined,
      postcondition: async () => true,
      alwaysRun: true,
    });
    assert.equal(result.outcome, 'completed');
  });
});

describe('step - postconditions and repair', () => {
  it('raises a SystemException when the action did not take effect', async () => {
    await assert.rejects(
      step(ctx, { name: 'select plan', precondition: yes, action: async () => {}, postcondition: no }),
      (error: unknown) => {
        assert.ok(error instanceof SystemException);
        assert.match((error as Error).message, /did not take effect/);
        return true;
      },
    );
  });

  it('accepts the step when one repair attempt fixes it', async () => {
    let repaired = false;
    const result = await step(ctx, {
      name: 'select plan',
      precondition: yes,
      action: async () => {},
      postcondition: async () => repaired,
      repair: async () => {
        repaired = true;
      },
    });
    assert.equal(result.outcome, 'repaired');
  });

  it('gives up after exactly one repair attempt', async () => {
    let repairs = 0;
    await assert.rejects(
      step(ctx, {
        name: 'select plan',
        precondition: yes,
        action: async () => {},
        postcondition: no,
        repair: async () => {
          repairs += 1;
        },
      }),
      SystemException,
    );
    assert.equal(repairs, 1, 'repair is a single attempt, not a retry loop');
  });
});

describe('step - gates are questions, not assertions', () => {
  /**
   * Locator checks throw routinely - a detached element, a navigation
   * mid-check. A throw escaping a predicate would bypass classification.
   */
  it('treats a throwing postcondition as not satisfied rather than propagating it', async () => {
    await assert.rejects(
      step(ctx, {
        name: 'select plan',
        action: async () => {},
        postcondition: async () => {
          throw new Error('locator detached');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SystemException);
        assert.match((error as Error).message, /did not take effect/);
        return true;
      },
    );
  });

  it('treats a throwing precondition as not satisfied', async () => {
    await assert.rejects(
      step(ctx, {
        name: 'select plan',
        precondition: async () => {
          throw new Error('page closed');
        },
        action: async () => {},
        postcondition: no,
      }),
      /Precondition failed/,
    );
  });
});

describe('step - action failures and timeouts', () => {
  it('propagates whatever the action threw, for the runner to classify', async () => {
    const thrown = new BusinessException('plan not offered');
    await assert.rejects(
      step(ctx, { name: 'select plan', precondition: yes, action: async () => { throw thrown; }, postcondition: no }),
      (error: unknown) => {
        assert.equal(error, thrown, 'classification belongs to the thrower, not to step()');
        return true;
      },
    );
  });

  it('times out a hung action as a SystemException', async () => {
    await assert.rejects(
      step(ctx, {
        name: 'wait for quote',
        timeoutMs: 50,
        action: async () => new Promise<void>(() => {}),
        postcondition: no,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SystemException);
        assert.match((error as Error).message, /exceeded its 50ms timeout/);
        return true;
      },
    );
  });

  it('does not let a hung gate stall the step forever', async () => {
    const started = Date.now();
    await assert.rejects(
      step(ctx, {
        name: 'wait for quote',
        timeoutMs: 50,
        action: async () => {},
        postcondition: async () => new Promise<boolean>(() => {}),
      }),
      SystemException,
    );
    assert.ok(Date.now() - started < 2_000, 'a hung gate must resolve to false, not hang');
  });
});
