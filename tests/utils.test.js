import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateURL,
  validateSafePath,
  capTimeout,
  truncateText,
  truncateBuffer,
  truncateConsole,
  formatMCPError,
  formatMCPResult,
  ERRORS,
  CONFIG
} from '../src/utils.js';

describe('validateURL', () => {
  it('allows http URLs', () => {
    const result = validateURL('http://example.com');
    assert.equal(result.valid, true);
  });

  it('allows https URLs', () => {
    const result = validateURL('https://example.com');
    assert.equal(result.valid, true);
  });

  it('allows localhost', () => {
    const result = validateURL('http://localhost:8080');
    assert.equal(result.valid, true);
  });

  it('allows 127.0.0.1', () => {
    const result = validateURL('http://127.0.0.1/path');
    assert.equal(result.valid, true);
  });

  it('rejects file: scheme', () => {
    const result = validateURL('file:///etc/passwd');
    assert.equal(result.valid, false);
    assert.match(result.error, /Rejected scheme/);
  });

  it('rejects javascript: scheme', () => {
    const result = validateURL('javascript:alert(1)');
    assert.equal(result.valid, false);
    assert.match(result.error, /Rejected scheme/);
  });

  it('rejects data: scheme', () => {
    const result = validateURL('data:text/html,<h1>hi</h1>');
    assert.equal(result.valid, false);
    assert.match(result.error, /Rejected scheme/);
  });

  it('rejects unknown schemes', () => {
    const result = validateURL('ftp://example.com');
    assert.equal(result.valid, false);
    assert.match(result.error, /Unknown scheme/);
  });

  it('rejects empty string', () => {
    const result = validateURL('');
    assert.equal(result.valid, false);
  });

  it('rejects invalid URL', () => {
    const result = validateURL('not a url');
    assert.equal(result.valid, false);
  });

  it('blocks private networks by default', () => {
    const result = validateURL('http://192.168.1.1');
    assert.equal(result.valid, false);
    assert.match(result.error, /Private network blocked/);
  });

  it('allows private networks when enabled', () => {
    const result = validateURL('http://192.168.1.1', { allowPrivateNetworks: true });
    assert.equal(result.valid, true);
  });
});

describe('validateSafePath', () => {
  it('rejects absolute paths', () => {
    const result = validateSafePath('/etc/passwd', '/tmp/output');
    assert.equal(result.valid, false);
    assert.match(result.error, /Absolute paths/);
  });

  it('rejects paths with ..', () => {
    const result = validateSafePath('../secret', '/tmp/output');
    assert.equal(result.valid, false);
    assert.match(result.error, /traversal/);
  });

  it('accepts relative paths', () => {
    const result = validateSafePath('file.txt', '/tmp/output');
    assert.equal(result.valid, true);
    assert.match(result.path, /\/tmp\/output\/file\.txt/);
  });

  it('rejects paths escaping output directory', () => {
    const result = validateSafePath('../../etc/passwd', '/tmp/output');
    assert.equal(result.valid, false);
    assert.match(result.error, /traversal/);
  });
});

describe('capTimeout', () => {
  it('returns default for undefined', () => {
    assert.equal(capTimeout(undefined), CONFIG.DEFAULT_TIMEOUT_MS);
  });

  it('returns default for null', () => {
    assert.equal(capTimeout(null), CONFIG.DEFAULT_TIMEOUT_MS);
  });

  it('caps at MAX_TIMEOUT_MS', () => {
    assert.equal(capTimeout(999999), CONFIG.MAX_TIMEOUT_MS);
  });

  it('enforces minimum of 100ms', () => {
    assert.equal(capTimeout(1), 100);
  });

  it('returns valid value within range', () => {
    assert.equal(capTimeout(5000), 5000);
  });

  it('returns default for NaN', () => {
    assert.equal(capTimeout('abc'), CONFIG.DEFAULT_TIMEOUT_MS);
  });
});

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    const result = truncateText('hello', 100);
    assert.equal(result.text, 'hello');
    assert.equal(result.truncated, false);
  });

  it('truncates long text', () => {
    const longText = 'a'.repeat(200);
    const result = truncateText(longText, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, 100 + '\n... [truncated]'.length);
    assert.equal(result.originalLength, 200);
  });

  it('handles non-string input', () => {
    const result = truncateText(123);
    assert.equal(result.text, '123');
  });
});

describe('truncateBuffer', () => {
  it('returns small buffer unchanged', () => {
    const buf = Buffer.from('hello');
    const result = truncateBuffer(buf, 100);
    assert.equal(result.truncated, false);
  });

  it('truncates large buffer', () => {
    const buf = Buffer.alloc(200);
    const result = truncateBuffer(buf, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.buffer.length, 100);
  });
});

describe('truncateConsole', () => {
  it('returns small array unchanged', () => {
    const lines = ['a', 'b', 'c'];
    const result = truncateConsole(lines, 10);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.lines, lines);
  });

  it('keeps last N lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const result = truncateConsole(lines, 5);
    assert.equal(result.truncated, true);
    assert.equal(result.lines.length, 5);
    assert.equal(result.lines[0], 'line-15');
    assert.equal(result.droppedCount, 15);
  });
});

describe('formatMCPError', () => {
  it('formats error without details', () => {
    const result = formatMCPError(ERRORS.TIMEOUT, 'Operation timed out');
    assert.equal(result.isError, true);
    assert.equal(result.error.code, 'TIMEOUT');
    assert.equal(result.error.message, 'Operation timed out');
  });

  it('formats error with details', () => {
    const result = formatMCPError(ERRORS.CDP_ERROR, 'Failed', { method: 'Page.navigate' });
    assert.equal(result.error.details.method, 'Page.navigate');
  });
});

describe('formatMCPResult', () => {
  it('formats success result', () => {
    const result = formatMCPResult({ title: 'Test' });
    assert.equal(result.isError, false);
    assert.equal(result.data.title, 'Test');
  });
});
