import { spawn } from 'node:child_process';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function sendRequest(proc, request) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(request);
    proc.stdin.write(json + '\n');
    
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for response'));
    }, 10000);
    
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

describe('MCP Handshake', () => {
  let serverProc;

  afterEach(() => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      serverProc = null;
    }
  });

  it('completes MCP handshake', async () => {
    serverProc = spawn('node', ['index.js'], {
      cwd: '/root/browser-mcp',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderrOutput = '';
    serverProc.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    await new Promise(resolve => setTimeout(resolve, 500));

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

    const initResponse = await sendRequest(serverProc, initRequest);
    
    assert.ok(initResponse.result);
    assert.ok(initResponse.result.capabilities);
    assert.ok(initResponse.result.capabilities.tools);
    assert.equal(initResponse.result.serverInfo.name, 'browser-mcp');

    const initializedNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    };
    serverProc.stdin.write(JSON.stringify(initializedNotification) + '\n');

    await new Promise(resolve => setTimeout(resolve, 200));

    const toolsListRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    };

    const toolsListResponse = await sendRequest(serverProc, toolsListRequest);
    
    assert.ok(toolsListResponse.result);
    assert.ok(Array.isArray(toolsListResponse.result.tools));
    assert.ok(toolsListResponse.result.tools.length > 0);
    
    const navigateTool = toolsListResponse.result.tools.find(t => t.name === 'browser_navigate');
    assert.ok(navigateTool, 'browser_navigate tool not found');
    assert.ok(navigateTool.description);
    assert.ok(navigateTool.inputSchema);
    assert.ok(navigateTool.inputSchema.properties.url);

    assert.ok(stderrOutput.includes('[MCP] Server started'));
  });

  it('returns error for invalid URL without crashing', async () => {
    serverProc = spawn('node', ['index.js'], {
      cwd: '/root/browser-mcp',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await new Promise(resolve => setTimeout(resolve, 500));

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

    await sendRequest(serverProc, initRequest);

    const initializedNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    };
    serverProc.stdin.write(JSON.stringify(initializedNotification) + '\n');

    await new Promise(resolve => setTimeout(resolve, 200));

    const toolCallRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'browser_navigate',
        arguments: {
          url: 'file:///etc/passwd'
        }
      }
    };

    const toolCallResponse = await sendRequest(serverProc, toolCallRequest);
    
    assert.ok(toolCallResponse.result);
    assert.equal(toolCallResponse.result.isError, true);
    assert.ok(toolCallResponse.result.content[0].text.includes('Rejected scheme'));

    assert.ok(serverProc.exitCode === null, 'Server should still be running');
  });
});
