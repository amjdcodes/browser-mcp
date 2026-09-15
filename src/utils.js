import { URL } from 'node:url';
import { resolve, isAbsolute, normalize } from 'node:path';

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:']);
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const REJECTED_SCHEMES = new Set(['file:', 'javascript:', 'data:', 'vbscript:']);

// Environment-driven limits. Priority: tool argument -> env var -> default -> hard cap.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const MAX_TIMEOUT_MS = envInt('MAX_TIMEOUT_MS', 120000);
const DEFAULT_TIMEOUT_MS = envInt('TOOL_TIMEOUT_MS', 30000);
const NAVIGATION_TIMEOUT_MS = envInt('NAVIGATION_TIMEOUT_MS', 30000);
const TOOL_DEFAULT_TIMEOUT_MS = envInt('TOOL_TIMEOUT_MS', 10000);

const MAX_TEXT_LENGTH = envInt('MAX_TEXT_LENGTH', 1_000_000);
const MAX_IMAGE_BYTES = envInt('MAX_IMAGE_BYTES', 10_000_000);
const MAX_CONSOLE_LINES = envInt('MAX_CONSOLE_LINES', 500);
const MAX_CONSOLE_MESSAGES = envInt('MAX_CONSOLE_MESSAGES', 500);
const MAX_SNAPSHOT_ITEMS = envInt('MAX_SNAPSHOT_ITEMS', 100);
const MAX_SCREENSHOT_PIXELS = envInt('MAX_SCREENSHOT_PIXELS', 16_000_000);
const MAX_EVAL_LENGTH = envInt('MAX_EVAL_LENGTH', 100_000);

const QUEUE_LIMIT = envInt('QUEUE_LIMIT', 8);

export function validateURL(urlString, options = {}) {
  const { allowPrivateNetworks = false } = options;

  if (typeof urlString !== 'string' || urlString.length === 0) {
    return { valid: false, error: 'URL must be a non-empty string' };
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, error: `Invalid URL: ${urlString}` };
  }

  const scheme = parsed.protocol.toLowerCase();

  if (REJECTED_SCHEMES.has(scheme)) {
    return { valid: false, error: `Rejected scheme: ${scheme}` };
  }

  if (!ALLOWED_SCHEMES.has(scheme)) {
    return { valid: false, error: `Unknown scheme: ${scheme}. Allowed: http, https, about` };
  }

  if (scheme === 'about:') {
    return { valid: true, url: parsed.href };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (!allowPrivateNetworks && !ALLOWED_HOSTS.has(hostname)) {
    if (isPrivateIP(hostname)) {
      return { valid: false, error: `Private network blocked: ${hostname}. Set ALLOW_PRIVATE_NETWORKS=1 to allow.` };
    }
  }

  return { valid: true, url: parsed.href };
}

function isPrivateIP(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return false;
  }
  if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) {
    return true;
  }
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return true;
  }
  return false;
}

export function validateSafePath(inputPath, outputDir) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { valid: false, error: 'Path must be a non-empty string' };
  }

  if (isAbsolute(inputPath)) {
    return { valid: false, error: 'Absolute paths are not allowed' };
  }

  if (inputPath.includes('..')) {
    return { valid: false, error: 'Path traversal (..) is not allowed' };
  }

  const normalized = normalize(inputPath);
  const resolved = resolve(outputDir, normalized);
  const resolvedOutputDir = resolve(outputDir);

  if (!resolved.startsWith(resolvedOutputDir)) {
    return { valid: false, error: 'Path escapes output directory' };
  }

  return { valid: true, path: resolved };
}

export function capTimeout(ms, defaultMs = DEFAULT_TIMEOUT_MS) {
  if (ms === undefined || ms === null) {
    return defaultMs;
  }
  const num = Number(ms);
  if (Number.isNaN(num) || num <= 0) {
    return defaultMs;
  }
  return Math.min(Math.max(num, 100), MAX_TIMEOUT_MS);
}

export function truncateText(text, maxLength = MAX_TEXT_LENGTH) {
  if (typeof text !== 'string') {
    return { text: String(text), truncated: false };
  }
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxLength) + '\n... [truncated]',
    truncated: true,
    originalLength: text.length
  };
}

export function truncateBuffer(buffer, maxBytes = MAX_IMAGE_BYTES) {
  if (!Buffer.isBuffer(buffer)) {
    return { buffer, truncated: false };
  }
  if (buffer.length <= maxBytes) {
    return { buffer, truncated: false };
  }
  return {
    buffer: buffer.subarray(0, maxBytes),
    truncated: true,
    originalLength: buffer.length
  };
}

export function truncateConsole(lines, maxLines = MAX_CONSOLE_LINES) {
  if (!Array.isArray(lines)) {
    return { lines: [], truncated: false };
  }
  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }
  return {
    lines: lines.slice(-maxLines),
    truncated: true,
    droppedCount: lines.length - maxLines
  };
}

export function formatMCPError(code, message, details = null) {
  const error = { code, message };
  if (details !== null) {
    error.details = details;
  }
  return { isError: true, error };
}

/**
 * Whether `browser_evaluate` is enabled. Disabled by default: the project
 * does not execute arbitrary page JavaScript unless explicitly opted in.
 * Accepts 1 / true / yes (case-insensitive).
 */
export function isEvalJsEnabled() {
  const raw = (process.env.ENABLE_EVAL_JS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Read the real pixel dimensions of an encoded PNG or JPEG image buffer,
 * without any external dependency. Returns null when the format is unknown
 * or the header cannot be parsed (callers fall back to their estimate).
 */
export function decodeImageSize(buffer, format) {
  try {
    if (!Buffer.isBuffer(buffer)) return null;

    if (format === 'png') {
      // PNG signature (8 bytes) + IHDR length/type (8) => width at 16, height at 20.
      if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (!width || !height) return null;
      return { width, height };
    }

    if (format === 'jpeg' || format === 'jpg') {
      let offset = 2; // skip SOI (0xFFD8)
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buffer[offset + 1];
        // Standalone markers carry no length payload.
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const length = buffer.readUInt16BE(offset + 2);
        const isSOF =
          marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          if (!width || !height) return null;
          return { width, height };
        }
        offset += 2 + length;
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}


export function formatMCPResult(data) {
  return { isError: false, data };
}

export const ERRORS = {
  INVALID_URL: 'INVALID_URL',
  UNSAFE_PATH: 'UNSAFE_PATH',
  INVALID_ARGS: 'INVALID_ARGS',
  TIMEOUT: 'TIMEOUT',
  BROWSER_NOT_READY: 'BROWSER_NOT_READY',
  BROWSER_CRASHED: 'BROWSER_CRASHED',
  CDP_ERROR: 'CDP_ERROR',
  BUSY_QUEUE_FULL: 'BUSY_QUEUE_FULL',
  CHROMIUM_RESTART_FAILED: 'CHROMIUM_RESTART_FAILED',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  ELEMENT_HIDDEN: 'ELEMENT_HIDDEN',
  ELEMENT_NOT_CLICKABLE: 'ELEMENT_NOT_CLICKABLE',
  ELEMENT_NOT_TYPEABLE: 'ELEMENT_NOT_TYPEABLE',
  KEY_NOT_SUPPORTED: 'KEY_NOT_SUPPORTED',
  EVAL_DISABLED: 'EVAL_DISABLED',
  EVAL_ERROR: 'EVAL_ERROR',
  VIEWPORT_APPLY_FAILED: 'VIEWPORT_APPLY_FAILED',
  SCREENSHOT_TOO_LARGE: 'SCREENSHOT_TOO_LARGE'
};

export const CONFIG = {
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
  TOOL_DEFAULT_TIMEOUT_MS,
  MAX_TEXT_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_CONSOLE_LINES,
  MAX_CONSOLE_MESSAGES,
  MAX_SNAPSHOT_ITEMS,
  MAX_SCREENSHOT_PIXELS,
  MAX_EVAL_LENGTH,
  QUEUE_LIMIT
};
