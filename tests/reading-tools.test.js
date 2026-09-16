import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

function sendRequest(proc, request) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(request);
    proc.stdin.write(json + '\n');
    
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for response'));
    }, 30000);
    
    const onData = (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const response = JSON.parse(line);
          if (response.id === request.id) {
            clearTimeout(timeout);
            proc.stdout.off('data', onData);
            resolve(response);
            return;
          }
        } catch {
          // Ignore parse errors
        }
      }
    };
    
    proc.stdout.on('data', onData);
  });
}

async function initializeServer(proc) {
  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  };

  await sendRequest(proc, initRequest);

  const initializedNotification = {
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  };
  proc.stdin.write(JSON.stringify(initializedNotification) + '\n');

  await new Promise(resolve => setTimeout(resolve, 200));
}

let testServer;
let testPort;

async function startTestServer() {
  return new Promise((resolve) => {
    testServer = createServer((req, res) => {
      const filePath = join(fixturesDir, req.url === '/' ? 'test-page.html' : req.url);
      try {
        const content = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    
    testServer.listen(0, '127.0.0.1', () => {
      testPort = testServer.address().port;
      resolve();
    });
  });
}

describe('Reading Tools', () => {
  let serverProc;

  before(async () => {
    await startTestServer();
  });

  after(async () => {
    if (testServer) {
      testServer.close();
    }
  });

  afterEach(async () => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      serverProc = null;
    }
  });

  describe('browser_get_url', () => {
    it('reports the current url, title and ready state', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'browser_get_url', arguments: {} }
      });

      assert.notEqual(response.result.isError, true);
      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.url, `http://127.0.0.1:${testPort}/`);
      assert.equal(result.title, 'Test Page - صفحة الاختبار');
      assert.equal(result.readyState, 'complete');

      // A hash-only navigation must be reflected too — this is the case where
      // the caller otherwise has no way to tell where the page ended up.
      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/#far-section` }
        }
      });

      const afterHash = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'browser_get_url', arguments: {} }
      });

      const hashResult = JSON.parse(afterHash.result.content[0].text);
      assert.equal(hashResult.url, `http://127.0.0.1:${testPort}/#far-section`);
    });
  });

  describe('browser_get_text', () => {
    it('gets body text without selector', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_get_text',
          arguments: {}
        }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.text);
      assert.ok(result.text.includes('Test Page'));
      assert.ok(result.text.includes('visible English text'));
      assert.ok(result.length > 0);
    });

    it('gets text with selector', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_get_text',
          arguments: { selector: '#english-text' }
        }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.text.includes('visible English text'));
    });

    it('handles Arabic text', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_get_text',
          arguments: { selector: '#arabic-text' }
        }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.text.includes('نص عربي'));
    });

    it('returns the current value of an input after typing (Phase 4)', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${testPort}/` } }
      });

      // Type into the text input (mixed Latin + Arabic, like the agent's case).
      await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'browser_type', arguments: { selector: '#text-input', text: 'محمد أحمد' } }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'browser_get_text', arguments: { selector: '#text-input' } }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.text, 'محمد أحمد', 'get_text must read the input value, not innerText');
    });

    it('returns the current value of a textarea (Phase 4)', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${testPort}/` } }
      });

      await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'browser_type', arguments: { selector: '#textarea', text: 'Multi-line\ncontent here' } }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'browser_get_text', arguments: { selector: '#textarea' } }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.text.includes('Multi-line'), `expected textarea value, got: ${result.text}`);
      assert.ok(result.text.includes('content here'), `expected textarea value, got: ${result.text}`);
    });

    it('returns the selected value of a select (Phase 4)', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${testPort}/` } }
      });

      // #select defaults to option1 selected; get_text must return the
      // selected option's VALUE, not "" (innerText reads no text nodes).
      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'browser_get_text', arguments: { selector: '#select' } }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.text, 'option1', 'get_text must read the selected option value');
    });

    it('still returns innerText for non-form elements (regression)', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${testPort}/` } }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'browser_get_text', arguments: { selector: '#english-text' } }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.text.includes('visible English text'), `expected innerText, got: ${result.text}`);
    });
  });

  describe('browser_screenshot', () => {
    it('takes screenshot with default options', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OUTPUT_DIR: '/tmp/test-screenshots' }
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_screenshot',
          arguments: { filename: 'test-screenshot.jpg' }
        }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.path);
      assert.ok(result.size > 0);
      
      assert.equal(response.result.content[1].type, 'image');
      assert.ok(response.result.content[1].data);
    });

    it('rejects absolute paths', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_screenshot',
          arguments: { filename: '/etc/passwd' }
        }
      });

      assert.ok(response.result);
      assert.equal(response.result.isError, true);
      assert.ok(response.result.content[0].text.includes('Absolute paths'));
    });

    it('rejects path traversal', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_screenshot',
          arguments: { filename: '../../etc/passwd' }
        }
      });

      assert.ok(response.result);
      assert.equal(response.result.isError, true);
      assert.ok(response.result.content[0].text.includes('traversal'));
    });

    it('resolves the extension from format instead of appending a second one', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OUTPUT_DIR: `/tmp/screenshot-ext-${process.pid}` }
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const cases = [
        { args: { filename: '01-hero.png' }, expected: '01-hero.jpg' },
        { args: { filename: '01-hero.png', format: 'png' }, expected: '01-hero.png' },
        { args: { filename: 'already.jpeg' }, expected: 'already.jpeg' },
        { args: { filename: 'photo.webp', format: 'png' }, expected: 'photo.png' },
        { args: { filename: 'shot-format', format: 'png' }, expected: 'shot-format.png' },
        { args: { filename: 'needs-ext' }, expected: 'needs-ext.jpg' }
      ];

      let id = 3;
      for (const { args, expected } of cases) {
        const response = await sendRequest(serverProc, {
          jsonrpc: '2.0',
          id: id++,
          method: 'tools/call',
          params: { name: 'browser_screenshot', arguments: args }
        });

        assert.notEqual(response.result.isError, true);
        const result = JSON.parse(response.result.content[0].text);
        assert.ok(
          result.path.endsWith(expected),
          `expected a path ending in "${expected}", got "${result.path}"`
        );
      }
    });
  });

  describe('browser_get_console', () => {
    it('gets console messages', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_get_console',
          arguments: { level: 'all' }
        }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.messages);
      assert.ok(result.count > 0);
    });

    it('filters by error level', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_get_console',
          arguments: { level: 'log' }
        }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.messages);
    });
  });

  describe('browser_snapshot', () => {
    it('gets interactive elements', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_snapshot',
          arguments: {}
        }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.elements);
      assert.ok(result.count > 0);
      
      const buttons = result.elements.filter(e => e.role === 'button');
      assert.ok(buttons.length > 0);
      
      const textboxes = result.elements.filter(e => e.role === 'textbox');
      assert.ok(textboxes.length > 0);

      // Snapshot advertises the browser_evaluate gate so a caller can discover
      // it without attempting a call. The advertisement must be truthful,
      // whichever way ENABLE_EVAL_JS is set in the environment.
      const evalResponse = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'browser_evaluate', arguments: { expression: '1' } }
      });
      assert.equal(
        result.evaluateEnabled,
        evalResponse.result.isError !== true,
        'the advertised evaluate gate must match the tool behavior'
      );
    });

    it('respects max_items limit', async () => {
      serverProc = spawn('node', ['index.js'], {
        cwd: '/root/browser-mcp',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      await initializeServer(serverProc);

      await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_navigate',
          arguments: { url: `http://127.0.0.1:${testPort}/` }
        }
      });

      const response = await sendRequest(serverProc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_snapshot',
          arguments: { max_items: 5 }
        }
      });

      assert.ok(response.result);
      assert.notEqual(response.result.isError, true);
      
      const result = JSON.parse(response.result.content[0].text);
      assert.ok(result.elements.length <= 5);
    });
  });
});
