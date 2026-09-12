import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser.js';

describe('Browser Integration', () => {
  let browser;

  afterEach(async () => {
    if (browser) {
      await browser.cleanup();
    }
  });

  it('launches Chromium and connects via CDP', async () => {
    browser = new Browser();
    await browser.start();

    assert.equal(browser.isReady, true);
    assert.ok(browser.pid > 0);
    assert.ok(browser.port > 0);
    assert.ok(browser.profileDir);
  });

  it('executes Runtime.evaluate', async () => {
    browser = new Browser();
    await browser.start();

    const result = await browser.send('Runtime.evaluate', {
      expression: '1 + 1'
    });

    assert.deepEqual(result, { result: { type: 'number', value: 2, description: '2' } });
  });

  it('navigates to about:blank', async () => {
    browser = new Browser();
    await browser.start();

    const result = await browser.send('Page.navigate', {
      url: 'about:blank'
    });

    assert.ok(result.frameId);
  });

  it('cleans up properly', async () => {
    browser = new Browser();
    await browser.start();
    
    const pid = browser.pid;
    await browser.cleanup();

    assert.equal(browser.state, 'stopped');
    assert.equal(browser.isReady, false);
    
    // Verify process is gone
    try {
      process.kill(pid, 0);
      assert.fail('Process should have been killed');
    } catch (err) {
      assert.equal(err.code, 'ESRCH');
    }
  });

  it('handles multiple commands', async () => {
    browser = new Browser();
    await browser.start();

    const results = await Promise.all([
      browser.send('Runtime.evaluate', { expression: '2 * 3' }),
      browser.send('Runtime.evaluate', { expression: '"hello"' }),
      browser.send('Runtime.evaluate', { expression: 'true' })
    ]);

    assert.equal(results[0].result.value, 6);
    assert.equal(results[1].result.value, 'hello');
    assert.equal(results[2].result.value, true);
  });
});
