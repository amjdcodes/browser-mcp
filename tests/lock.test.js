import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OperationLock } from '../src/lock.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe('OperationLock', () => {
  it('serializes concurrent operations (FIFO order)', async () => {
    const lock = new OperationLock({ maxQueue: 8 });
    const order = [];

    const release1 = await lock.acquire();
    const p2 = lock.acquire().then(release2 => {
      order.push('op2');
      release2();
    });
    const p3 = lock.acquire().then(release3 => {
      order.push('op3');
      release3();
    });

    order.push('op1');
    release1();

    await Promise.all([p2, p3]);
    assert.deepEqual(order, ['op1', 'op2', 'op3']);
  });

  it('rejects with BUSY_QUEUE_FULL when the queue is at capacity', async () => {
    const lock = new OperationLock({ maxQueue: 2 });
    const release1 = await lock.acquire();
    const p2 = lock.acquire(); // queued behind op1 (not awaited yet)

    await assert.rejects(
      lock.acquire(),
      (err) => err.code === 'BUSY_QUEUE_FULL' && /queue is full/i.test(err.message)
    );

    release1();
    const release2 = await p2;
    release2();

    // After everything is released, acquires work again.
    const release3 = await lock.acquire();
    release3();
  });

  it('releases on error paths (caller uses try/finally)', async () => {
    const lock = new OperationLock({ maxQueue: 8 });

    // Simulate an operation that throws — release still called via finally.
    let release = await lock.acquire();
    try {
      throw new Error('operation failed');
    } catch {
      // expected operation failure
    } finally {
      release();
    }

    // The lock must be free for the next operation.
    release = await lock.acquire();
    assert.equal(lock.locked, true);
    release();
    assert.equal(lock.locked, false);
  });

  it('lets queued operations proceed after an operation throws', async () => {
    const lock = new OperationLock({ maxQueue: 8 });
    const results = [];

    const run = async (name, shouldThrow) => {
      const release = await lock.acquire();
      try {
        await sleep(20);
        if (shouldThrow) throw new Error(`${name} failed`);
        results.push(name);
      } finally {
        release();
      }
    };

    await Promise.allSettled([
      run('a', false),
      run('b', true),
      run('c', false)
    ]);

    assert.deepEqual(results.sort(), ['a', 'c']);
    assert.equal(lock.locked, false);
  });

  it('force-releases after the maximum lock duration (deadlock backstop)', async () => {
    const lock = new OperationLock({ maxQueue: 2, maxDurationMs: 100 });
    const release1 = await lock.acquire();

    // Second operation waits; the watchdog force-releases op 1 after 100ms.
    const p2 = lock.acquire();
    const release2 = await Promise.race([
      p2,
      sleep(5000).then(() => { throw new Error('lock never released'); })
    ]);
    release2();

    assert.equal(lock.locked, false);
  });

  it('tracks queue length and locked state', async () => {
    const lock = new OperationLock({ maxQueue: 8 });
    assert.equal(lock.locked, false);
    assert.equal(lock.queueLength, 0);

    const release1 = await lock.acquire();
    assert.equal(lock.locked, true);
    assert.equal(lock.queueLength, 1); // active operation counted

    const p2 = lock.acquire();
    assert.equal(lock.queueLength, 2); // active + waiting

    release1();
    const release2 = await p2;
    assert.equal(lock.queueLength, 1);
    release2();
    assert.equal(lock.queueLength, 0);
  });
});
