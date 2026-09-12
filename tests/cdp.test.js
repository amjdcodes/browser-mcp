import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CDPClient } from '../src/cdp.js';
import { WebSocketServer } from 'ws';

describe('CDPClient', () => {
  let server;
  let serverPort;
  let client;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    serverPort = await new Promise((resolve) => {
      server.on('listening', () => {
        resolve(server.address().port);
      });
    });
    client = new CDPClient({ defaultTimeout: 5000 });
  });

  afterEach(async () => {
    if (client) {
      await client.close();
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects send() when not connected', async () => {
    await assert.rejects(
      () => client.send('Runtime.evaluate', { expression: '1+1' }),
      /Not connected/
    );
  });

  it('connects to WebSocket server', async () => {
    await client.connect(`ws://127.0.0.1:${serverPort}`);
    assert.equal(client.isConnected, true);
  });

  it('generates unique incrementing IDs', async () => {
    const ids = [];
    
    const connectionPromise = new Promise((resolve) => {
      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          ids.push(msg.id);
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        });
        resolve();
      });
    });

    await client.connect(`ws://127.0.0.1:${serverPort}`);
    await connectionPromise;

    await client.send('Method1', {});
    await client.send('Method2', {});
    await client.send('Method3', {});

    assert.deepEqual(ids, [1, 2, 3]);
  });

  it('resolves with result on success', async () => {
    const connectionPromise = new Promise((resolve) => {
      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          ws.send(JSON.stringify({ id: msg.id, result: { value: 42 } }));
        });
        resolve();
      });
    });

    await client.connect(`ws://127.0.0.1:${serverPort}`);
    await connectionPromise;

    const result = await client.send('Runtime.evaluate', { expression: '42' });
    assert.deepEqual(result, { value: 42 });
  });

  it('rejects with error on CDP error', async () => {
    const connectionPromise = new Promise((resolve) => {
      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          ws.send(JSON.stringify({
            id: msg.id,
            error: { code: -32000, message: 'Test error' }
          }));
        });
        resolve();
      });
    });

    await client.connect(`ws://127.0.0.1:${serverPort}`);
    await connectionPromise;

    await assert.rejects(
      () => client.send('Runtime.evaluate', {}),
      /CDP Error: Test error/
    );
  });

  it('times out pending requests', async () => {
    const shortClient = new CDPClient({ defaultTimeout: 100 });
    
    server.on('connection', () => {
      // Don't respond - let it timeout
    });

    await shortClient.connect(`ws://127.0.0.1:${serverPort}`);

    await assert.rejects(
      () => shortClient.send('Runtime.evaluate', {}),
      /Timeout/
    );

    await shortClient.close();
    assert.equal(shortClient.pendingCount, 0);
  });

  it('rejects all pending on close', async () => {
    server.on('connection', () => {
      // Don't respond
    });

    await client.connect(`ws://127.0.0.1:${serverPort}`);

    const promise1 = client.send('Method1', {}, 10000).catch(e => e);
    const promise2 = client.send('Method2', {}, 10000).catch(e => e);

    // Give time for sends to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    await client.close();

    const err1 = await promise1;
    const err2 = await promise2;
    
    assert.ok(err1 instanceof Error);
    assert.ok(err2 instanceof Error);
    assert.equal(client.pendingCount, 0);
  });

  it('ignores late responses', async () => {
    let savedWs;
    const connectionPromise = new Promise((resolve) => {
      server.on('connection', (ws) => {
        savedWs = ws;
        ws.on('message', () => {
          // Don't respond immediately
        });
        resolve();
      });
    });

    await client.connect(`ws://127.0.0.1:${serverPort}`);
    await connectionPromise;

    const promise = client.send('Method1', {}, 100);

    await assert.rejects(promise, /Timeout/);

    // Send late response
    savedWs.send(JSON.stringify({ id: 1, result: { late: true } }));

    // Should not throw
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  it('emits events for CDP events', async () => {
    let receivedEvent = null;
    client.on('Page.loadEventFired', (params) => {
      receivedEvent = params;
    });

    const connectionPromise = new Promise((resolve) => {
      server.on('connection', (ws) => {
        ws.send(JSON.stringify({
          method: 'Page.loadEventFired',
          params: { timestamp: 12345 }
        }));
        resolve();
      });
    });

    await client.connect(`ws://127.0.0.1:${serverPort}`);
    await connectionPromise;

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(receivedEvent, { timestamp: 12345 });
  });

  it('reports correct pending count', async () => {
    server.on('connection', () => {
      // Don't respond
    });

    await client.connect(`ws://127.0.0.1:${serverPort}`);

    assert.equal(client.pendingCount, 0);

    const p1 = client.send('Method1', {}, 10000).catch(() => {});
    const p2 = client.send('Method2', {}, 10000).catch(() => {});

    // Give time for sends to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(client.pendingCount, 2);

    await client.close();
    assert.equal(client.pendingCount, 0);
  });
});
