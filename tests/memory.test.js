import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser.js';
import { ConsoleBuffer } from '../src/console-buffer.js';
import { truncateText, truncateBuffer, CONFIG } from '../src/utils.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function readRssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
}

describe('Memory usage and limits', () => {
  let browser;

  afterEach(async () => {
    if (browser) {
      await browser.cleanup();
      browser = null;
    }
  });

  it('runs 50 start/stop cycles without leaking memory or processes', async () => {
    const rssSamples = [];

    for (let i = 0; i < 50; i++) {
      browser = new Browser();
      await browser.start();
      assert.equal(browser.state, 'ready');

      // Do some work each cycle.
      await browser.send('Runtime.evaluate', { expression: '1 + 1' }, 5000);
      await browser.send('Page.navigate', { url: 'about:blank' }, 10000);

      await browser.cleanup();
      assert.equal(browser.state, 'stopped');
      assert.equal(browser.process, null, 'process handle must be released');
      assert.equal(browser.cdp, null, 'CDP client must be released');
      assert.equal(browser.port, null, 'port must be released');

      if (i % 10 === 0 || i === 49) {
        await sleep(100); // let GC settle before sampling
        rssSamples.push({ cycle: i + 1, rssMb: readRssMb() });
      }
    }

    // A slow, steady climb of a few MB per 50 cycles is normal V8 behavior;
    // a leak shows up as continuous large growth.
    const first = rssSamples[0].rssMb;
    const last = rssSamples[rssSamples.length - 1].rssMb;
    const growth = last - first;
    assert.ok(
      growth < 64,
      `RSS grew ${growth}MB over 50 cycles (${first}MB -> ${last}MB) — possible leak`
    );
    assert.equal(browser.state, 'stopped');
  });

  it('cleanup is idempotent and releases all browser resources', async () => {
    browser = new Browser();
    await browser.start();
    const profile = browser.profileDir;

    await browser.cleanup();
    await browser.cleanup(); // second call must be a no-op

    assert.equal(browser.state, 'stopped');
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(profile), false, 'profile dir must be removed');
  });

  it('cleanup survives errors (e.g. profile deletion failure)', async () => {
    browser = new Browser();
    await browser.start();

    // Point the profile at a path that cannot exist (parent is a regular
    // file), so rmSync fails with ENOTDIR during cleanup.
    const { writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const blocker = join(tmpdir(), `browser-mcp-blocker-${process.pid}-${Date.now()}`);
    writeFileSync(blocker, '');
    browser.profileDir = join(blocker, 'sub');

    // cleanup() must swallow the error, keep going, and end in stopped state.
    await browser.cleanup();
    assert.equal(browser.state, 'stopped');
  });

  it('enforces MAX_TEXT_LENGTH truncation', () => {
    const long = 'x'.repeat(CONFIG.MAX_TEXT_LENGTH + 1000);
    const result = truncateText(long, CONFIG.MAX_TEXT_LENGTH);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= CONFIG.MAX_TEXT_LENGTH + 64);
  });

  it('enforces MAX_IMAGE_BYTES truncation', () => {
    const big = Buffer.alloc(CONFIG.MAX_IMAGE_BYTES + 1000);
    const result = truncateBuffer(big, CONFIG.MAX_IMAGE_BYTES);
    assert.equal(result.truncated, true);
    assert.equal(result.buffer.length, CONFIG.MAX_IMAGE_BYTES);
  });

  it('ConsoleBuffer ring buffer evicts oldest beyond MAX_CONSOLE_MESSAGES', () => {
    const buffer = new ConsoleBuffer(10);
    for (let i = 0; i < 25; i++) {
      buffer.add({ level: 'log', text: `msg ${i}` });
    }
    const messages = buffer.getMessages();
    assert.equal(messages.length, 10);
    assert.equal(messages[0].text, 'msg 15');
    assert.equal(messages[9].text, 'msg 24');
  });

  it('CONFIG exposes environment-overridable limits', () => {
    assert.ok(CONFIG.MAX_TEXT_LENGTH > 0);
    assert.ok(CONFIG.MAX_CONSOLE_MESSAGES >= 10);
    assert.ok(CONFIG.MAX_SNAPSHOT_ITEMS > 0);
    assert.ok(CONFIG.MAX_SCREENSHOT_PIXELS > 0);
    assert.equal(typeof CONFIG.QUEUE_LIMIT, 'number');
  });
});
