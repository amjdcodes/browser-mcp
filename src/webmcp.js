// src/webmcp.js
// ---------------------------------------------------------------------------
// WebMCP (Web Model Context Protocol) support.
//
// WebMCP lets a page declare "tools" (name + description + JSON inputSchema +
// an `execute` callback) that an AI agent can discover and invoke directly,
// instead of the agent scraping the DOM and guessing. This module makes
// browser-mcp a WebMCP-aware agent for ANY page it drives.
//
// Two transports, tried in order:
//   1. Chrome's experimental CDP `WebMCP` domain (preferred, external-agent
//      path). Requires Chromium launched with --enable-features=WebMCP.
//        - WebMCP.enable        -> fires WebMCP.toolsAdded for registered tools
//        - WebMCP.toolsAdded/Removed -> live catalog (maintained on Browser)
//        - WebMCP.invokeTool    -> { invocationId } (reply precedes events)
//        - WebMCP.toolResponded -> { invocationId, status, output, errorText }
//        - WebMCP.cancelInvocation
//   2. In-page `document.modelContext.getTools()` / `executeTool()` (the
//      "author-provided agent" path), used when the CDP domain is absent.
//
// SECURITY: the in-page helpers below are STATIC function sources. Tool names
// and JSON inputs always travel as CDP `arguments` values — they are NEVER
// concatenated into JavaScript source. Everything a page provides (tool names,
// descriptions, schemas and results) is UNTRUSTED and surfaced as such.
// ---------------------------------------------------------------------------

import { ERRORS } from './utils.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function webmcpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// In-page fallback: static function sources (never assembled from arguments).
// ---------------------------------------------------------------------------

export const IN_PAGE_WEBMCP = {
  list: `async function() {
    const mc = document.modelContext || (navigator && navigator.modelContext);
    if (!mc || typeof mc.getTools !== 'function') {
      return { available: false };
    }
    let tools;
    try {
      tools = await mc.getTools();
    } catch (e) {
      return { available: true, error: String((e && e.message) || e) };
    }
    const mapped = (Array.isArray(tools) ? tools : []).map(function(t) {
      return {
        name: t && t.name,
        description: t && t.description,
        inputSchema: t && t.inputSchema,
        origin: t && t.origin,
        annotations: t && t.annotations
      };
    });
    return { available: true, tools: mapped };
  }`,

  // Arguments: [toolName, input]
  call: `async function(toolName, input) {
    const mc = document.modelContext || (navigator && navigator.modelContext);
    if (!mc || typeof mc.getTools !== 'function' || typeof mc.executeTool !== 'function') {
      return { available: false };
    }
    let tools;
    try {
      tools = await mc.getTools();
    } catch (e) {
      return { available: true, ok: false, error: String((e && e.message) || e) };
    }
    const tool = (Array.isArray(tools) ? tools : []).find(function(t) { return t && t.name === toolName; });
    if (!tool) return { available: true, notFound: true };
    try {
      const result = await mc.executeTool(tool, input || {});
      return { available: true, ok: true, result: result };
    } catch (e) {
      return { available: true, ok: false, error: String((e && e.message) || e) };
    }
  }`
};

async function callInPage(browser, fnSource, args, timeoutMs) {
  const doc = await browser.send('Runtime.evaluate', {
    expression: 'document',
    returnByValue: false
  }, timeoutMs);
  if (doc.exceptionDetails) {
    throw new Error('Could not access page document');
  }
  const result = await browser.send('Runtime.callFunctionOn', {
    functionDeclaration: fnSource,
    objectId: doc.result.objectId,
    arguments: args.map(value => ({ value })),
    returnByValue: true,
    awaitPromise: true
  }, timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'In-page WebMCP call failed'
    );
  }
  return result.result ? result.result.value : null;
}

// ---------------------------------------------------------------------------
// CDP transport
// ---------------------------------------------------------------------------

/**
 * Whether the CDP `WebMCP` domain is usable. Attempts to enable it once and
 * caches the answer on the Browser (browser.webmcpAvailable). Never throws —
 * an unsupported/disabled domain simply returns false so callers can fall back.
 */
async function ensureCdpEnabled(browser, timeoutMs) {
  if (browser.webmcpAvailable === true) return true;
  if (browser.webmcpAvailable === false) return false;
  try {
    await browser.send('WebMCP.enable', {}, timeoutMs);
    browser.webmcpAvailable = true;
    return true;
  } catch (err) {
    browser.webmcpAvailable = false;
    process.stderr.write(`[WebMCP] CDP domain unavailable: ${err.message}\n`);
    return false;
  }
}

function readCatalog(browser) {
  if (!browser.webmcpTools) return [];
  return Array.from(browser.webmcpTools.values());
}

/** Wait for the event stream to settle after a fresh WebMCP.enable. */
async function waitForCatalogQuiet(browser, { quietMs = 120, maxMs = 800, minMs = 100 } = {}) {
  const start = Date.now();
  let lastSize = -1;
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    const size = browser.webmcpTools ? browser.webmcpTools.size : 0;
    if (size !== lastSize) {
      lastSize = size;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs && Date.now() - start >= minMs) {
      break;
    }
    await sleep(40);
  }
}

/** Force a full snapshot: enabling re-fires toolsAdded for every registered tool. */
async function refreshCatalog(browser, timeoutMs) {
  if (browser.webmcpTools) browser.webmcpTools.clear();
  try {
    await browser.send('WebMCP.enable', {}, timeoutMs);
  } catch {
    return;
  }
  await waitForCatalogQuiet(browser);
}

function normalizeTool(tool) {
  return {
    name: tool.name ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? null,
    annotations: tool.annotations ?? null,
    frameId: tool.frameId ?? null
  };
}

function pickTool(catalog, name, frameId) {
  const byName = catalog.filter(t => t && t.name === name);
  if (frameId) {
    return byName.find(t => t.frameId === frameId) || null;
  }
  if (byName.length <= 1) return byName[0] || null;
  const frames = byName.map(t => t.frameId).join(', ');
  throw webmcpError(
    ERRORS.WEBMCP_AMBIGUOUS_TOOL,
    `More than one WebMCP tool is named "${name}" (frames: ${frames}). Pass frame_id to choose one.`
  );
}

function awaitToolResponded(browser, invocationId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cdp = browser.cdp;
    if (!cdp) {
      return reject(webmcpError(ERRORS.WEBMCP_CALL_FAILED, 'CDP connection is not available.'));
    }
    const onResponded = (params) => {
      if (params && params.invocationId === invocationId) {
        cleanup();
        resolve(params);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      const err = webmcpError(
        ERRORS.WEBMCP_CALL_TIMEOUT,
        `WebMCP tool did not respond within ${timeoutMs}ms.`
      );
      reject(err);
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      cdp.off('WebMCP.toolResponded', onResponded);
    }
    cdp.on('WebMCP.toolResponded', onResponded);
  });
}

async function invokeViaCdp(browser, { frameId, name, input }, timeoutMs) {
  const { invocationId } = await browser.send('WebMCP.invokeTool', {
    frameId,
    toolName: name,
    input: input || {}
  }, timeoutMs);

  if (!invocationId) {
    throw webmcpError(ERRORS.WEBMCP_CALL_FAILED, 'WebMCP.invokeTool returned no invocationId.');
  }

  let response;
  try {
    response = await awaitToolResponded(browser, invocationId, timeoutMs);
  } catch (err) {
    if (err.code === ERRORS.WEBMCP_CALL_TIMEOUT) {
      // Best-effort cancel so a runaway tool does not keep running.
      await browser.send('WebMCP.cancelInvocation', { invocationId }, 5000).catch(() => {});
    }
    throw err;
  }
  return response;
}

function buildCdpResult(name, response) {
  const status = response.status || 'Completed';
  if (status === 'Error') {
    throw webmcpError(
      ERRORS.WEBMCP_CALL_FAILED,
      response.errorText || `WebMCP tool "${name}" failed.`
    );
  }
  if (status === 'Canceled') {
    throw webmcpError(ERRORS.WEBMCP_CALL_FAILED, `WebMCP tool "${name}" was canceled.`);
  }
  return {
    source: 'cdp',
    tool: name,
    status,
    untrusted: true,
    output: response.output === undefined ? null : response.output
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List the WebMCP tools the current page exposes.
 * Returns { source, tools, truncated }. Throws WEBMCP_UNAVAILABLE when neither
 * the CDP domain nor the in-page API is present.
 */
export async function listWebmcpTools(browser, { maxTools = 64, timeoutMs = 10000 } = {}) {
  const cdpEnabled = await ensureCdpEnabled(browser, timeoutMs);

  if (cdpEnabled) {
    let catalog = readCatalog(browser);
    if (catalog.length === 0) {
      await refreshCatalog(browser, timeoutMs);
      catalog = readCatalog(browser);
    }
    if (catalog.length > 0) {
      const tools = catalog.slice(0, maxTools).map(normalizeTool);
      return { source: 'cdp', tools, truncated: catalog.length > maxTools };
    }
  }

  // In-page fallback / supplement (covers a page that polyfills modelContext).
  const page = await callInPage(browser, IN_PAGE_WEBMCP.list, [], timeoutMs).catch(() => null);
  if (page && page.available) {
    const all = Array.isArray(page.tools) ? page.tools : [];
    return {
      source: 'page',
      tools: all.slice(0, maxTools),
      truncated: all.length > maxTools
    };
  }

  if (cdpEnabled) {
    // Supported, but the page declares no tools.
    return { source: 'cdp', tools: [], truncated: false };
  }

  throw webmcpError(
    ERRORS.WEBMCP_UNAVAILABLE,
    'This page exposes no WebMCP tools, and the browser has no WebMCP support: ' +
    'the CDP WebMCP domain is unavailable and document.modelContext is not ' +
    'defined. Launch Chromium with --enable-features=WebMCP (ENABLE_WEBMCP is on ' +
    'by default) for pages that declare WebMCP tools.'
  );
}

/**
 * Invoke a WebMCP tool by name.
 * Returns { source, tool, status, untrusted, output }. Throws WEBMCP_TOOL_NOT_FOUND,
 * WEBMCP_AMBIGUOUS_TOOL, WEBMCP_CALL_FAILED, WEBMCP_CALL_TIMEOUT or WEBMCP_UNAVAILABLE.
 */
export async function callWebmcpTool(browser, { name, input = {}, frameId = null }, timeoutMs = 10000) {
  if (!name || typeof name !== 'string') {
    throw webmcpError(ERRORS.INVALID_ARGS, 'A WebMCP tool name is required.');
  }

  const cdpEnabled = await ensureCdpEnabled(browser, timeoutMs);

  if (cdpEnabled) {
    let catalog = readCatalog(browser);
    if (catalog.length === 0) {
      await refreshCatalog(browser, timeoutMs);
      catalog = readCatalog(browser);
    }
    const tool = pickTool(catalog, name, frameId); // may throw AMBIGUOUS
    if (tool) {
      const response = await invokeViaCdp(browser, { frameId: tool.frameId, name, input }, timeoutMs);
      return buildCdpResult(name, response);
    }
  }

  // In-page fallback (only reachable when the CDP domain is unavailable, or the
  // tool is not in the CDP catalog — e.g. a page that polyfills modelContext).
  const page = await callInPage(browser, IN_PAGE_WEBMCP.call, [name, input], timeoutMs).catch(() => null);
  if (page && page.available) {
    if (page.notFound) {
      throw webmcpError(ERRORS.WEBMCP_TOOL_NOT_FOUND, `No WebMCP tool named "${name}" is registered on this page.`);
    }
    if (!page.ok) {
      throw webmcpError(ERRORS.WEBMCP_CALL_FAILED, `WebMCP tool "${name}" failed: ${page.error}`);
    }
    return { source: 'page', tool: name, status: 'Completed', untrusted: true, output: page.result ?? null };
  }

  if (cdpEnabled) {
    throw webmcpError(ERRORS.WEBMCP_TOOL_NOT_FOUND, `No WebMCP tool named "${name}" is registered on this page.`);
  }

  throw webmcpError(
    ERRORS.WEBMCP_UNAVAILABLE,
    'The browser has no WebMCP support (no CDP WebMCP domain and no document.modelContext), ' +
    'so no tool can be invoked. Launch Chromium with --enable-features=WebMCP.'
  );
}
