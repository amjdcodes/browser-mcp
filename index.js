#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Browser } from './src/browser.js';
import {
  validateURL,
  capTimeout,
  truncateText,
  validateSafePath,
  isEvalJsEnabled,
  decodeImageSize,
  ERRORS,
  CONFIG
} from './src/utils.js';
import { OperationLock, withLock } from './src/lock.js';
import {
  clickElement,
  typeIntoElement,
  waitForCondition,
  normalizeWhitespace,
  scrollByDirection,
  scrollToPosition,
  scrollToElement,
  waitForSettle,
  hoverElement,
  pressKey,
  evaluateExpression
} from './src/helpers.js';
import { resolveViewportParams } from './src/viewport.js';
import { resolveKey } from './src/keymap.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const server = new McpServer({
  name: 'browser-mcp',
  version: '1.5.0'
}, {
  capabilities: {
    tools: {}
  }
});

const browser = new Browser();

let isShuttingDown = false;
let idleTimer = null;
let navigationPromise = null;
const IDLE_SHUTDOWN_MS = parseInt(process.env.IDLE_SHUTDOWN_MS || '300000', 10);

// Tracks in-flight tool calls so the idle timer never fires mid-operation.
let activeOperations = 0;

function withActivityTracking(handler) {
  return async (args) => {
    activeOperations++;
    // Any request counts as activity: extend the idle window from its start.
    resetIdleTimer();
    try {
      const result = await handler(args);

      // After a crash restart the page is back on about:blank with its scroll
      // position and DOM gone. Say so on the first successful call afterwards,
      // instead of letting the client draw conclusions from a blank page it
      // never saw reset. Error results do not consume the flag — they may
      // predate the restart finishing.
      if (result && result.isError !== true && browser.consumeSessionReset() &&
          Array.isArray(result.content)) {
        result.content.push({
          type: 'text',
          text: JSON.stringify({
            sessionReset: true,
            reason: 'Chromium restarted after a crash; the page and its in-memory state were reset.'
          })
        });
      }

      return result;
    } finally {
      activeOperations--;
    }
  };
}

function registerTool(name, description, schema, handler) {
  server.tool(name, description, schema, withActivityTracking(handler));
}

// Single mutex serializing state-changing operations (click, type, navigate,
// full-page screenshot). Reading tools do not need it.
const operationLock = new OperationLock({ maxQueue: CONFIG.QUEUE_LIMIT });

// Run a state-changing operation under the lock. Returns an MCP error result
// when the queue is full.
async function runLocked(fn) {
  try {
    return await withLock(operationLock, fn);
  } catch (err) {
    if (err.code === 'BUSY_QUEUE_FULL') {
      process.stderr.write(`[MCP] Operation queue full: ${err.message}\n`);
      return formatToolError(err);
    }
    throw err;
  }
}

function toolError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function formatToolError(err) {
  const code = err.code ? `[${err.code}] ` : '';
  return {
    content: [{ type: 'text', text: `${code}${err.message}` }],
    isError: true
  };
}

/**
 * Detect a same-document (hash-only) navigation: the target differs from the
 * current page only by its URL fragment. Chromium fires Page.navigatedWithinDocument
 * (NOT Page.loadEventFired) for these, so the navigate handler must branch.
 * Returns true when the target is a hash change on the current document.
 */
async function detectSameDocumentNavigation(browser, targetUrl) {
  try {
    const target = new URL(targetUrl);
    if (!target.hash || target.hash === '#') return false;

    const result = await browser.send('Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true
    }, 5000);

    const currentUrl = result.result?.value;
    if (typeof currentUrl !== 'string' || !currentUrl) return false;

    const current = new URL(currentUrl);
    return (
      current.origin === target.origin &&
      current.pathname === target.pathname &&
      current.search === target.search
    );
  } catch {
    return false;
  }
}

async function ensureBrowserReady() {
  if (browser.state === 'ready') {
    return;
  }

  if (browser.state === 'stopped') {
    process.stderr.write('[MCP] Starting browser...\n');
    await browser.start();
    return;
  }

  if (browser.state === 'failed') {
    if (browser.failureReason) {
      // Surface the clear failure (e.g. CHROMIUM_RESTART_FAILED) to the client
      // instead of silently masking the crash loop.
      const reason = browser.failureReason;
      const err = new Error(`[${reason.code || 'BROWSER_FAILED'}] ${reason.message}`);
      if (reason.stderrLines) {
        err.message += `\nLast Chromium stderr:\n${reason.stderrLines}`;
      }
      throw err;
    }
    process.stderr.write('[MCP] Starting browser after failure...\n');
    await browser.start();
    return;
  }

  // starting / reconnecting / restarting / stopping: wait for the transition.
  while (['starting', 'reconnecting', 'restarting', 'stopping'].includes(browser.state)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (browser.state === 'failed') {
    const reason = browser.failureReason;
    const err = new Error(`[${reason?.code || 'BROWSER_FAILED'}] ${reason?.message || 'browser failed'}`);
    if (reason?.stderrLines) {
      err.message += `\nLast Chromium stderr:\n${reason.stderrLines}`;
    }
    throw err;
  }

  if (browser.state !== 'ready') {
    throw new Error(`Browser failed to start (state=${browser.state})`);
  }
}

function resetIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  if (IDLE_SHUTDOWN_MS <= 0) {
    // Idle shutdown disabled (IDLE_SHUTDOWN_MS=0).
    return;
  }

  idleTimer = setTimeout(async () => {
    if (activeOperations > 0) {
      // An operation is still in flight — do not interrupt it; postpone.
      resetIdleTimer();
      return;
    }
    process.stderr.write('[MCP] Idle timeout reached, closing browser...\n');
    try {
      await browser.cleanup();
    } catch (err) {
      process.stderr.write(`[MCP] Error during idle shutdown: ${err.message}\n`);
    }
  }, IDLE_SHUTDOWN_MS);
}

registerTool(
  'browser_navigate',
  'Navigate to a URL in the browser',
  {
    url: z.string().url(),
    timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.NAVIGATION_TIMEOUT_MS)
  },
  async ({ url, timeout_ms }) => {
    return runLocked(async () => {
      navigationPromise = (async () => {
        try {
          await ensureBrowserReady();

          const urlValidation = validateURL(url, {
            allowPrivateNetworks: isPrivateNetworksAllowed()
          });
          if (!urlValidation.valid) {
            return {
              content: [{ type: 'text', text: urlValidation.error }],
              isError: true
            };
          }

          const timeout = capTimeout(timeout_ms, CONFIG.DEFAULT_TIMEOUT_MS);

          process.stderr.write(`[MCP] Navigating to: ${url}\n`);

          let loadEventFired = false;
          let frameNavigated = false;
          let withinDocumentFired = false;
          let finalUrl = url;
          let status = null;

          const onLoadEventFired = () => {
            loadEventFired = true;
          };

          const onFrameNavigated = (params) => {
            if (!params.frame.parentId) {
              frameNavigated = true;
              finalUrl = params.frame.url;
            }
          };

          const onWithinDocument = (params) => {
            withinDocumentFired = true;
            finalUrl = params.url;
          };

          const onResponseReceived = (params) => {
            if (params.type === 'Document' && params.response) {
              status = params.response.status;
            }
          };

          browser.cdp.on('Page.loadEventFired', onLoadEventFired);
          browser.cdp.on('Page.frameNavigated', onFrameNavigated);
          browser.cdp.on('Page.navigatedWithinDocument', onWithinDocument);
          browser.cdp.on('Network.responseReceived', onResponseReceived);

          try {
            // Hash-only navigations never fire Page.loadEventFired; branch to
            // Page.navigatedWithinDocument for those.
            const isSameDocument = await detectSameDocumentNavigation(browser, url);

            await browser.send('Page.navigate', { url }, timeout);

            if (isSameDocument) {
              const withinStart = Date.now();
              while (
                !withinDocumentFired &&
                !loadEventFired &&
                Date.now() - withinStart < 5000
              ) {
                await new Promise(resolve => setTimeout(resolve, 50));
              }

              if (withinDocumentFired) {
                // Let the browser's built-in anchor scroll settle before
                // reading state. The scroll may be animated (300-500ms), and
                // the software compositor is slow to repaint — a plain
                // setTimeout can return before a valid frame exists, leaving
                // the next screenshot blank. Wait + double-rAF ensures the
                // compositor has produced a frame.
                await new Promise(resolve => setTimeout(resolve, 200));
                await waitForSettle(browser).catch(() => {});

                const titleResult = await browser.send('Runtime.evaluate', {
                  expression: 'document.title'
                }, 5000);
                const locationResult = await browser.send('Runtime.evaluate', {
                  expression: 'window.location.href',
                  returnByValue: true
                }, 5000);

                const title = titleResult.result.value || '';

                resetIdleTimer();

                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      url: locationResult.result.value || finalUrl,
                      title,
                      status
                    })
                  }]
                };
              }
              // Fall through: the server may return a full page for the hash
              // URL (edge case) — use the standard loadEventFired path.
            }

            const startTime = Date.now();
            while (!loadEventFired && Date.now() - startTime < timeout) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }

            if (!loadEventFired) {
              throw new Error(`Navigation timeout after ${timeout}ms`);
            }

            const titleResult = await browser.send('Runtime.evaluate', {
              expression: 'document.title'
            }, 5000);

            const title = titleResult.result.value || '';

            resetIdleTimer();

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  url: finalUrl,
                  title,
                  status
                })
              }]
            };

          } finally {
            browser.cdp.off('Page.loadEventFired', onLoadEventFired);
            browser.cdp.off('Page.frameNavigated', onFrameNavigated);
            browser.cdp.off('Page.navigatedWithinDocument', onWithinDocument);
            browser.cdp.off('Network.responseReceived', onResponseReceived);
          }

        } catch (err) {
          process.stderr.write(`[MCP] Navigation error: ${err.message}\n`);
          return formatToolError(err);
        }
      })();

      try {
        return await navigationPromise;
      } finally {
        navigationPromise = null;
      }
    });
  }
);

registerTool(
  'browser_get_url',
  'Get the current page URL, title, and document ready state',
  {},
  async () => {
    try {
      await ensureBrowserReady();

      // Wait for any in-flight navigation to complete
      if (navigationPromise) {
        await navigationPromise.catch(() => {});
      }

      process.stderr.write('[MCP] Getting current URL\n');

      const result = await browser.send('Runtime.evaluate', {
        expression: `({
          url: window.location.href,
          title: document.title,
          readyState: document.readyState
        })`,
        returnByValue: true
      }, 5000);

      resetIdleTimer();

      return {
        content: [{ type: 'text', text: JSON.stringify(result.result.value) }]
      };

    } catch (err) {
      process.stderr.write(`[MCP] Get URL error: ${err.message}\n`);
      return formatToolError(err);
    }
  }
);

registerTool(
  'browser_get_text',
  'Get text content from the page or a specific element',
  {
    selector: z.string().optional(),
    timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.TOOL_DEFAULT_TIMEOUT_MS)
  },
  async ({ selector, timeout_ms }) => {
    try {
      await ensureBrowserReady();
      
      // Wait for any in-flight navigation to complete
      if (navigationPromise) {
        await navigationPromise.catch(() => {});
      }
      
      const timeout = capTimeout(timeout_ms, 10000);
      
      process.stderr.write(`[MCP] Getting text${selector ? ` for selector: ${selector}` : ' from body'}\n`);
      
      let expression;
      if (selector) {
        expression = `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            // Form elements store their content in the value property, not
            // as text nodes — innerText on an <input>/<textarea>/<select>
            // would return "" for typed/selected content.
            const tag = el.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') {
              return el.value;
            }
            return el.innerText;
          })()
        `;
      } else {
        expression = 'document.body.innerText';
      }
      
      const startTime = Date.now();
      let result = null;
      
      while (Date.now() - startTime < timeout) {
        const evalResult = await browser.send('Runtime.evaluate', {
          expression,
          returnByValue: true
        }, 5000);
        
        if (evalResult.result.value !== null && evalResult.result.value !== undefined) {
          result = evalResult.result.value;
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if (result === null) {
        if (selector) {
          throw new Error(`Element not found: ${selector}`);
        } else {
          throw new Error('Could not get text content');
        }
      }
      
      const truncated = truncateText(result, CONFIG.MAX_TEXT_LENGTH);
      
      resetIdleTimer();
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            text: truncated.text,
            truncated: truncated.truncated,
            length: result.length
          })
        }]
      };
      
    } catch (err) {
      process.stderr.write(`[MCP] Get text error: ${err.message}\n`);
      return {
        content: [{ type: 'text', text: err.message }],
        isError: true
      };
    }
  }
);

const OUTPUT_DIR = process.env.OUTPUT_DIR || './screenshots';
const MAX_SCREENSHOT_PIXELS = CONFIG.MAX_SCREENSHOT_PIXELS;

// Image extensions the screenshot filename resolver recognises. A name already
// carrying one of these has it REPLACED by the requested format's extension —
// appending blindly produced double extensions like "01-hero.png.jpg".
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// ALLOW_PRIVATE_NETWORKS=1|true allows navigation to private IP ranges.
function isPrivateNetworksAllowed() {
  const v = (process.env.ALLOW_PRIVATE_NETWORKS || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// Constants for the scroll settle inside warmUpPageForScreenshot.
const WARMUP_STEP_DELAY_MS = 100;
const WARMUP_SETTLE_MS = 150;

/**
 * Scroll through the entire page in viewport-sized steps so IntersectionObserver
 * callbacks and lazy-rendering JavaScript run for every section, then return to
 * the top. Required before full-page screenshots: below-fold sections on modern
 * sites are not painted until they enter the viewport, so a naive capture would
 * produce a page with blank middle sections.
 */
async function warmUpPageForScreenshot(browser) {
  const metrics = await browser.send('Page.getLayoutMetrics', {}, 5000);
  const viewport = metrics.visualViewport || metrics.layoutViewport;
  const contentSize = metrics.contentSize || metrics.cssContentSize;
  const vh = viewport.clientHeight;
  const totalHeight = contentSize.height;

  process.stderr.write(`[MCP] Warm-up scroll: ${Math.ceil(totalHeight / vh)} steps (${Math.round(totalHeight)}px)\n`);

  // Scroll down in viewport-sized steps, pausing so observers can fire.
  for (let y = 0; y < totalHeight; y += vh) {
    await browser.send('Runtime.evaluate', {
      expression: `window.scrollTo({ top: ${y}, behavior: 'instant' })`
    }, 3000).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, WARMUP_STEP_DELAY_MS));
  }

  // Absolute bottom (catches any remaining lazy content), then back to top.
  await browser.send('Runtime.evaluate', {
    expression: 'window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" })'
  }, 3000).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, WARMUP_SETTLE_MS));

  await browser.send('Runtime.evaluate', {
    expression: 'window.scrollTo({ top: 0, behavior: "instant" })'
  }, 3000).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, WARMUP_STEP_DELAY_MS));
}

registerTool(
  'browser_screenshot',
  'Take a screenshot of the current page',
  {
    filename: z.string().optional(),
    format: z.enum(['jpeg', 'png']).optional().default('jpeg'),
    quality: z.number().min(1).max(100).optional().default(80),
    full_page: z.boolean().optional().default(false),
    delay_ms: z.number().min(0).max(5000).optional().default(0)
  },
  async ({ filename, format, quality, full_page, delay_ms }) => {
    // Full-page capture reads the whole document layout (and changes capture
    // state), so it is serialized behind the operation lock. Viewport shots
    // are read-only and do not need the lock.
    const run = async () => {
      try {
        await ensureBrowserReady();

        // Wait for any in-flight navigation to complete
        if (navigationPromise) {
          await navigationPromise.catch(() => {});
        }

        if (!filename) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          filename = `screenshot-${timestamp}.${format}`;
        } else {
          // The extension is decided by `format`: a matching extension is kept
          // (".jpg" and ".jpeg" both match jpeg), any other image extension is
          // replaced, and a name without one gets the format's extension.
          const matchingExtensions = format === 'jpeg' ? ['.jpg', '.jpeg'] : ['.png'];
          const targetExtension = format === 'jpeg' ? '.jpg' : '.png';
          const lowerName = filename.toLowerCase();

          if (!matchingExtensions.some(ext => lowerName.endsWith(ext))) {
            const existingExtension = IMAGE_EXTENSIONS.find(ext => lowerName.endsWith(ext));
            const baseName = existingExtension
              ? filename.slice(0, -existingExtension.length)
              : filename;
            filename = `${baseName}${targetExtension}`;
          }
        }

        const pathValidation = validateSafePath(filename, OUTPUT_DIR);
        if (!pathValidation.valid) {
          return {
            content: [{ type: 'text', text: pathValidation.error }],
            isError: true
          };
        }

        process.stderr.write(`[MCP] Taking screenshot: ${filename}\n`);

        await mkdir(OUTPUT_DIR, { recursive: true });

        let metrics = await browser.send('Page.getLayoutMetrics', {}, 5000);

        // Full-page captures need an explicit clip spanning the whole document.
        let fullPageClip = null;
        if (full_page) {
          // Trigger lazy rendering (IntersectionObserver) for below-fold sections
          // before capturing — otherwise middle sections come out blank.
          await warmUpPageForScreenshot(browser);

          // Re-read metrics: contentSize may have grown after the warm-up.
          metrics = await browser.send('Page.getLayoutMetrics', {}, 5000);
          const contentSize = metrics.contentSize || metrics.cssContentSize;
          fullPageClip = {
            x: 0,
            y: 0,
            width: contentSize.width,
            height: contentSize.height,
            scale: 1
          };
        }

        // The CSS visual viewport carries the page-scale factor applied by
        // mobile emulation; the stored deviceScaleFactor is the other factor
        // that multiplies the real pixel size of a capture.
        const visualViewport =
          metrics.cssVisualViewport || metrics.visualViewport || metrics.layoutViewport;
        const deviceScaleFactor =
          (browser.viewport && browser.viewport.deviceScaleFactor) || 1;
        const pageScale =
          visualViewport.scale && visualViewport.scale > 0 ? visualViewport.scale : 1;
        // Full-page captures force deviceScaleFactor 1 and mobile false, so only
        // the clip's own scale affects their size.
        const scaleProduct = fullPageClip ? 1 : deviceScaleFactor * pageScale;

        // --- Layer 1: best-effort pre-capture estimate ----------------------
        // Avoids a second capture in the common case. The post-capture
        // measurement below is the authority.
        let scale = 1;
        let truncated = false;
        {
          const baseW = fullPageClip ? fullPageClip.width : visualViewport.clientWidth;
          const baseH = fullPageClip ? fullPageClip.height : visualViewport.clientHeight;
          const estPixels = baseW * baseH * scaleProduct * scaleProduct;
          if (estPixels > MAX_SCREENSHOT_PIXELS) {
            // Reduce RESOLUTION via clip.scale; shrinking the clip would CROP
            // the page instead of downscaling it.
            scale = Math.sqrt(MAX_SCREENSHOT_PIXELS / estPixels) * 0.98;
            if (fullPageClip) fullPageClip.scale = scale;
            truncated = true;
            process.stderr.write(
              `[MCP] Screenshot pre-scaled (estimate ~${Math.round(estPixels)}px, scale=${scale.toFixed(3)})\n`
            );
          }
        }

        const buildCaptureParams = (captureScale) => {
          const params = { format };
          if (fullPageClip) {
            params.clip = { ...fullPageClip, scale: captureScale };
            params.captureBeyondViewport = true;
          } else if (captureScale !== 1) {
            // Viewport captures normally pass NO clip (an explicit clip with
            // captureBeyondViewport:false yields a blank frame on a scrolled
            // page). When downscaling is required we must supply a clip at the
            // current page offset, with captureBeyondViewport:true.
            params.clip = {
              x: visualViewport.pageX || 0,
              y: visualViewport.pageY || 0,
              width: visualViewport.clientWidth,
              height: visualViewport.clientHeight,
              scale: captureScale
            };
            params.captureBeyondViewport = true;
          }
          if (format === 'jpeg') params.quality = quality;
          return params;
        };

        // Optional explicit delay for pages with heavy animations or
        // lazy-loaded content (the post-click settle covers the common case).
        if (delay_ms > 0) {
          process.stderr.write(`[MCP] Screenshot delay: ${delay_ms}ms\n`);
          await new Promise(resolve => setTimeout(resolve, delay_ms));
        }

        // Full-page captures rely on `captureBeyondViewport` with a clip spanning
        // the whole document — the viewport is deliberately NOT resized to the
        // page height. Doing that recomputed the layout against a fake viewport
        // (100vh elements inflated, `position: fixed` elements stretched over the
        // whole image), which visibly broke RTL pages.

        // --- Layer 2: capture, measure the real image, correct if needed --
        const MAX_CAPTURE_ATTEMPTS = 2;
        let finalResult = null;
        let finalBuffer = null;
        let finalDims = null;
        let finalScale = scale;
        let lastBuffer = null;
        let lastDims = null;

        for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt++) {
          const result = await browser.send(
            'Page.captureScreenshot',
            buildCaptureParams(scale),
            30000
          );
          const buffer = Buffer.from(result.data, 'base64');
          const dims = decodeImageSize(buffer, format);

          const overPixels =
            dims !== null && dims.width * dims.height > MAX_SCREENSHOT_PIXELS;
          const overBytes = buffer.length > CONFIG.MAX_IMAGE_BYTES;

          if (!overPixels && !overBytes) {
            finalResult = result;
            finalBuffer = buffer;
            finalDims = dims;
            finalScale = scale;
            break;
          }

          const fPix = overPixels
            ? Math.sqrt(MAX_SCREENSHOT_PIXELS / (dims.width * dims.height))
            : 1;
          const fByte = overBytes
            ? Math.sqrt(CONFIG.MAX_IMAGE_BYTES / buffer.length)
            : 1;
          const correction = Math.min(fPix, fByte) * 0.98;

          process.stderr.write(
            `[MCP] Screenshot over limit (px=${dims ? `${dims.width}x${dims.height}` : 'unknown'}, ` +
            `bytes=${buffer.length}); re-capturing scale=${((scale || 1) * correction).toFixed(3)}\n`
          );

          lastBuffer = buffer;
          lastDims = dims;
          scale = (scale || 1) * correction;
          truncated = true;
        }

        if (!finalResult) {
          return formatToolError(toolError(
            ERRORS.SCREENSHOT_TOO_LARGE,
            `Screenshot still exceeds limits after ${MAX_CAPTURE_ATTEMPTS} attempts ` +
            `(px=${lastDims ? `${lastDims.width}x${lastDims.height}` : 'unknown'}, ` +
            `bytes=${lastBuffer ? lastBuffer.length : 'unknown'}). ` +
            'Use a smaller viewport or lower quality.'
          ));
        }

        await writeFile(pathValidation.path, finalBuffer);
        resetIdleTimer();

        const meta = {
          path: pathValidation.path,
          size: finalBuffer.length,
          truncated,
          scale: finalScale,
          measured: finalDims !== null
        };
        if (finalDims) {
          meta.width = finalDims.width;
          meta.height = finalDims.height;
        }

        return {
          content: [
            { type: 'text', text: JSON.stringify(meta) },
            {
              type: 'image',
              data: finalResult.data,
              mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png'
            }
          ]
        };

      } catch (err) {
        process.stderr.write(`[MCP] Screenshot error: ${err.message}\n`);
        return {
          content: [{ type: 'text', text: err.message }],
          isError: true
        };
      }
    };

    return full_page ? runLocked(run) : run();
  }
);

registerTool(
  'browser_get_console',
  'Get console messages from the browser',
  {
    level: z.enum(['all', 'error', 'warning', 'log', 'info', 'debug']).optional().default('all'),
    clear_after: z.boolean().optional().default(false)
  },
  async ({ level, clear_after }) => {
    try {
      await ensureBrowserReady();
      
      // Wait for any in-flight navigation to complete
      if (navigationPromise) {
        await navigationPromise.catch(() => {});
      }
      
      process.stderr.write(`[MCP] Getting console messages (level: ${level})\n`);
      
      const result = browser.consoleBuffer.getFormattedMessages(level, clear_after);
      
      resetIdleTimer();
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result)
        }]
      };
      
    } catch (err) {
      process.stderr.write(`[MCP] Get console error: ${err.message}\n`);
      return {
        content: [{ type: 'text', text: err.message }],
        isError: true
      };
    }
  }
);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'combobox', 'radio',
  'switch', 'tab', 'slider', 'searchbox', 'spinbutton', 'menuitem',
  'menu', 'menuitemcheckbox', 'menuitemradio', 'option', 'progressbar',
  'scrollbar', 'separator', 'tablist', 'tabpanel', 'tree', 'treeitem'
]);

registerTool(
  'browser_snapshot',
  'Get accessibility tree snapshot of interactive elements',
  {
    include_text: z.boolean().optional().default(true),
    max_items: z.number().max(200).optional().default(CONFIG.MAX_SNAPSHOT_ITEMS)
  },
  async ({ include_text, max_items }) => {
    try {
      await ensureBrowserReady();
      
      // Wait for any in-flight navigation to complete
      if (navigationPromise) {
        await navigationPromise.catch(() => {});
      }
      
      process.stderr.write(`[MCP] Getting accessibility snapshot\n`);
      
      const axTree = await browser.send('Accessibility.getFullAXTree', {}, 10000);
      
      const interactiveElements = [];
      
      for (const node of axTree.nodes) {
        const role = node.role?.value;
        
        if (!role || !INTERACTIVE_ROLES.has(role)) {
          continue;
        }
        
        const name = node.name?.value || '';
        const description = node.description?.value || '';
        
        let selector = null;
        
        if (node.backendDOMNodeId !== undefined) {
          try {
            const nodeInfo = await browser.send('DOM.describeNode', {
              backendNodeId: node.backendDOMNodeId,
              depth: 0
            }, 5000);
            
            const attrs = nodeInfo.node.attributes || [];
            const attrObj = {};
            for (let i = 0; i < attrs.length; i += 2) {
              attrObj[attrs[i]] = attrs[i + 1];
            }
            
            if (attrObj.id) {
              selector = `#${attrObj.id}`;
            } else if (attrObj.name) {
              selector = `[name="${attrObj.name}"]`;
            } else if (attrObj['aria-label']) {
              selector = `[aria-label="${attrObj['aria-label']}"]`;
            } else if (attrObj.placeholder) {
              selector = `[placeholder="${attrObj.placeholder}"]`;
            } else if (attrObj.value && node.role?.value === 'option') {
              const parentEl = nodeInfo.node;
              if (parentEl.parentNode?.backendNodeId) {
                const parentNodeInfo = await browser.send('DOM.describeNode', {
                  backendNodeId: parentEl.parentNode.backendNodeId,
                  depth: 0
                }, 5000);
                const parentAttrs = parentNodeInfo.node.attributes || [];
                const parentAttrObj = {};
                for (let i = 0; i < parentAttrs.length; i += 2) {
                  parentAttrObj[parentAttrs[i]] = parentAttrs[i + 1];
                }
                if (parentAttrObj.id) {
                  selector = `#${parentAttrObj.id} > option[value="${attrObj.value}"]`;
                } else if (parentAttrObj.name) {
                  selector = `select[name="${parentAttrObj.name}"] > option[value="${attrObj.value}"]`;
                } else {
                  selector = `option[value="${attrObj.value}"]`;
                }
              } else {
                selector = `option[value="${attrObj.value}"]`;
              }
            }
          } catch (err) {
            process.stderr.write(`[Snapshot] Selector generation failed for backendNodeId ${node.backendDOMNodeId}: ${err.message}\n`);
          }
        }
        
        // Fallback: use Runtime.evaluate if no selector found
        if (!selector && node.name?.value) {
          try {
            const result = await browser.send('Runtime.evaluate', {
              expression: `(function() {
                const role = ${JSON.stringify(node.role?.value)};
                const name = ${JSON.stringify(node.name?.value)};
                const els = document.querySelectorAll(
                  'button, a, input, textarea, select, option, [role]'
                );
                for (const el of els) {
                  const elRole = el.getAttribute('role') || el.tagName.toLowerCase();
                  const elName = el.textContent?.trim() ||
                    el.getAttribute('aria-label') ||
                    el.getAttribute('placeholder') || '';
                  if (elRole === role && elName.includes(name)) {
                    if (el.id) return '#' + el.id;
                    if (el.name) return '[name="' + el.name + '"]';
                    if (el.tagName.toLowerCase() === 'option' && el.value) {
                      const sel = el.closest('select');
                      if (sel?.id) return '#' + sel.id + ' > option[value="' + el.value + '"]';
                      if (sel?.name) return 'select[name="' + sel.name + '"] > option[value="' + el.value + '"]';
                      return 'option[value="' + el.value + '"]';
                    }
                    return null;
                  }
                }
                return null;
              })()`,
              returnByValue: true
            }, 5000);
            selector = result.result.value || null;
          } catch (err) {
            process.stderr.write(`[Snapshot] Fallback selector generation failed: ${err.message}\n`);
          }
        }
        
        const state = {};
        if (node.properties) {
          for (const prop of node.properties) {
            if (prop.name === 'checked') state.checked = prop.value?.value;
            if (prop.name === 'expanded') state.expanded = prop.value?.value;
            if (prop.name === 'disabled') state.disabled = prop.value?.value;
            if (prop.name === 'selected') state.selected = prop.value?.value;
            if (prop.name === 'readonly') state.readonly = prop.value?.value;
            if (prop.name === 'required') state.required = prop.value?.value;
          }
        }
        
        const element = {
          role,
          name,
          description,
          selector,
          state
        };
        
        if (include_text && node.value?.value) {
          element.value = node.value.value;
        }
        
        interactiveElements.push(element);
        
        if (interactiveElements.length >= max_items) {
          break;
        }
      }
      
      resetIdleTimer();
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            elements: interactiveElements,
            count: interactiveElements.length,
            truncated: interactiveElements.length >= max_items,
            // Snapshot is the discovery tool: advertise whether browser_evaluate
            // is usable here, instead of letting the caller find out by failing.
            evaluateEnabled: isEvalJsEnabled()
          })
        }]
      };
      
    } catch (err) {
      process.stderr.write(`[MCP] Snapshot error: ${err.message}\n`);
      return {
        content: [{ type: 'text', text: err.message }],
        isError: true
      };
    }
  }
);

registerTool(
  'browser_click',
  'Click an element on the page using its CSS selector',
  {
    selector: z.string(),
    force: z.boolean().optional().default(false),
    timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.TOOL_DEFAULT_TIMEOUT_MS)
  },
  async ({ selector, force, timeout_ms }) => {
    return runLocked(async () => {
      try {
        await ensureBrowserReady();

        if (navigationPromise) {
          await navigationPromise.catch(() => {});
        }

        const timeout = capTimeout(timeout_ms, 10000);
        process.stderr.write(`[MCP] Clicking element: ${selector}${force ? ' (force)' : ''}\n`);

        const point = await clickElement(browser, selector, timeout, { force });
        resetIdleTimer();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              clicked: true,
              selector,
              x: point.x,
              y: point.y,
              ...(point.forced ? { forced: true } : {})
            })
          }]
        };

      } catch (err) {
        process.stderr.write(`[MCP] Click error: ${err.message}\n`);
        return formatToolError(err);
      }
    });
  }
);

registerTool(
  'browser_type',
  'Type text into an input, textarea, or contenteditable element',
  {
    selector: z.string(),
    text: z.string(),
    clear_first: z.boolean().optional().default(true),
    timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.TOOL_DEFAULT_TIMEOUT_MS)
  },
  async ({ selector, text, clear_first, timeout_ms }) => {
    return runLocked(async () => {
      try {
        await ensureBrowserReady();

        if (navigationPromise) {
          await navigationPromise.catch(() => {});
        }

        const timeout = capTimeout(timeout_ms, 10000);
        // NEVER log `text` — it may contain sensitive data (passwords, tokens).
        process.stderr.write(`[MCP] Typing into element: ${selector} (clear_first=${clear_first}, length=${text.length})\n`);

        const finalValue = await typeIntoElement(browser, selector, text, {
          clearFirst: clear_first,
          timeoutMs: timeout
        });
        resetIdleTimer();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              typed: true,
              selector,
              length: text.length,
              finalLength: finalValue.length
            })
          }]
        };

      } catch (err) {
        process.stderr.write(`[MCP] Type error: ${err.message}\n`);
        return formatToolError(err);
      }
    });
  }
);

registerTool(
  'browser_wait_for',
  'Wait for an element to exist or for text to appear on the page',
  {
    selector: z.string().optional(),
    text: z.string().optional(),
    timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(15000)
  },
  async ({ selector, text, timeout_ms }) => {
    try {
      await ensureBrowserReady();

      if (navigationPromise) {
        await navigationPromise.catch(() => {});
      }

      const timeout = capTimeout(timeout_ms, 15000);
      process.stderr.write(`[MCP] Waiting for${selector ? ` element: ${selector}` : ''}${text ? ` text: "${normalizeWhitespace(text)}"` : ''} (timeout: ${timeout}ms)\n`);

      const elapsed = await waitForCondition(browser, { selector, text, timeoutMs: timeout });
      resetIdleTimer();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            found: true,
            selector: selector || null,
            text: text || null,
            elapsed_ms: elapsed
          })
        }]
      };

    } catch (err) {
      process.stderr.write(`[MCP] Wait error: ${err.message}\n`);
      return formatToolError(err);
    }
  }
);

registerTool(
  'browser_scroll',
  'Scroll the page by direction, to an element, or to absolute coordinates',
  {
    direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom']).optional(),
    selector: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    pixels: z.number().optional()
  },
  async ({ direction, selector, x, y, pixels }) => {
    try {
      await ensureBrowserReady();

      if (navigationPromise) {
        await navigationPromise.catch(() => {});
      }

      const hasDirection = direction !== undefined;
      const hasSelector = selector !== undefined;
      const hasPosition = x !== undefined || y !== undefined;
      const modes = [hasDirection, hasSelector, hasPosition].filter(Boolean).length;

      if (modes === 0) {
        return formatToolError(toolError(
          'INVALID_ARGS',
          'Provide one of "direction", "selector", or x/y coordinates to scroll'
        ));
      }
      if (modes > 1) {
        return formatToolError(toolError(
          'INVALID_ARGS',
          'Provide exactly one of "direction", "selector", or x/y coordinates'
        ));
      }

      process.stderr.write(`[MCP] Scrolling: ${hasSelector ? `to element ${selector}` : hasDirection ? `by direction ${direction}${pixels !== undefined ? ` (${pixels}px)` : ''}` : `to (${x ?? 'current'}, ${y ?? 'current'})`}\n`);

      let result;
      if (hasSelector) {
        result = await scrollToElement(browser, selector);
        resetIdleTimer();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              scrollX: result.scrollX,
              scrollY: result.scrollY,
              mode: 'element',
              selector,
              inViewport: result.inViewport,
              fullyInViewport: result.fullyInViewport
            })
          }]
        };
      }

      if (hasDirection) {
        result = await scrollByDirection(browser, direction, pixels);
        resetIdleTimer();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              scrollX: result.scrollX,
              scrollY: result.scrollY,
              mode: 'direction',
              direction
            })
          }]
        };
      }

      result = await scrollToPosition(browser, x, y);
      resetIdleTimer();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            scrollX: result.scrollX,
            scrollY: result.scrollY,
            mode: 'position',
            x: x ?? null,
            y: y ?? null
          })
        }]
      };

    } catch (err) {
      process.stderr.write(`[MCP] Scroll error: ${err.message}\n`);
      return formatToolError(err);
    }
  }
);

/**
 * Read the viewport the page actually has. `browser_resize` echoes back the
 * values it was asked for; these are the measured ones, which differ when the
 * document overflows the requested width (Chromium then shrinks the layout to
 * fit) or when mobile emulation applies a page scale.
 */
async function measureViewport(browser) {
  const result = await browser.send('Runtime.evaluate', {
    expression: `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollWidth: document.documentElement.scrollWidth
    })`,
    returnByValue: true
  }, 5000);
  return result.result.value ?? null;
}

registerTool(
  'browser_resize',
  'Resize the browser viewport (width/height, presets, or reset to default)',
  {
    preset: z.enum(['mobile', 'tablet', 'desktop']).optional(),
    width: z.number().int().min(100).max(10000).optional(),
    height: z.number().int().min(100).max(10000).optional(),
    device_scale_factor: z.number().min(1).max(4).optional(),
    mobile: z.boolean().optional(),
    reset: z.boolean().optional(),
    timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional()
  },
  async (args) => {
    return runLocked(async () => {
      // Validate the RAW arguments (not Zod-normalized) so `reset` and an empty
      // call are distinguishable — see src/viewport.js.
      let params;
      try {
        params = resolveViewportParams(args);
      } catch (err) {
        return formatToolError(err);
      }

      try {
        await ensureBrowserReady();

        if (navigationPromise) {
          await navigationPromise.catch(() => {});
        }

        if (params.mode === 'reset') {
          process.stderr.write('[MCP] Resetting viewport override\n');
          await browser.clearViewport();
          await waitForSettle(browser).catch(() => {});
          const measured = await measureViewport(browser).catch(() => null);
          resetIdleTimer();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                resized: true,
                width: null,
                height: null,
                deviceScaleFactor: null,
                mobile: null,
                preset: null,
                reset: true,
                measured
              })
            }]
          };
        }

        const { viewport, preset } = params;
        process.stderr.write(
          `[MCP] Resizing viewport to ${viewport.width}x${viewport.height} ` +
          `(dSF=${viewport.deviceScaleFactor}, mobile=${viewport.mobile})` +
          `${preset ? ` preset=${preset}` : ''}\n`
        );

        try {
          await browser.applyViewport(viewport);
        } catch (err) {
          return formatToolError(toolError(
            ERRORS.VIEWPORT_APPLY_FAILED,
            `Failed to apply viewport: ${err.message}`
          ));
        }

        await waitForSettle(browser).catch(() => {});
        const measured = await measureViewport(browser).catch(() => null);
        resetIdleTimer();

        const response = {
          resized: true,
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor,
          mobile: viewport.mobile,
          preset: preset ?? null,
          reset: false,
          measured
        };

        // The echoed width is what was requested; a mismatch means the page did
        // not accept it (horizontal overflow, or shrink-to-fit under mobile
        // emulation). Say so instead of implying the values matched.
        if (measured && measured.innerWidth !== viewport.width) {
          response.warning =
            `Requested width ${viewport.width}px but the page reports ` +
            `innerWidth=${measured.innerWidth}px — the document overflows the ` +
            'viewport or is scaled to fit.';
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(response) }]
        };

      } catch (err) {
        process.stderr.write(`[MCP] Resize error: ${err.message}\n`);
        return formatToolError(err);
      }
    });
  }
);

registerTool(
  'browser_evaluate',
  'Evaluate a JavaScript expression in the page and return a JSON-serialized result',
  {
    expression: z.string().min(1).max(CONFIG.MAX_EVAL_LENGTH),
    await_promise: z.boolean().optional().default(true),
    user_gesture: z.boolean().optional().default(false),
    timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.TOOL_DEFAULT_TIMEOUT_MS)
  },
  async ({ expression, await_promise, user_gesture, timeout_ms }) => {
    // Security gate: never start the browser or run code unless explicitly enabled.
    if (!isEvalJsEnabled()) {
      return formatToolError(toolError(
        ERRORS.EVAL_DISABLED,
        'browser_evaluate is disabled by default: it runs arbitrary page ' +
        'JavaScript, which can read document.cookie/localStorage and reach ' +
        'internal networks via fetch() (SSRF). Set ENABLE_EVAL_JS=1 in the MCP ' +
        'server environment to enable it for pages you trust.'
      ));
    }

    return runLocked(async () => {
      try {
        await ensureBrowserReady();

        if (navigationPromise) {
          await navigationPromise.catch(() => {});
        }

        const timeout = capTimeout(timeout_ms, CONFIG.TOOL_DEFAULT_TIMEOUT_MS);
        // The expression itself is not logged (it may contain sensitive values).
        process.stderr.write(`[MCP] Evaluating expression (length=${expression.length})\n`);

        const serialized = await evaluateExpression(browser, expression, {
          awaitPromise: await_promise,
          userGesture: user_gesture,
          timeoutMs: timeout
        });

        const rawValue = serialized.value === undefined ? null : serialized.value;
        let json;
        try {
          json = JSON.stringify(rawValue);
        } catch (err) {
          json = JSON.stringify({ __type: 'unserializable', message: err.message });
        }

        const truncatedResult = truncateText(json === undefined ? 'null' : json, CONFIG.MAX_EVAL_LENGTH);
        resetIdleTimer();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              result: truncatedResult.truncated ? truncatedResult.text : rawValue,
              type: serialized.type,
              truncated: truncatedResult.truncated
            })
          }]
        };

      } catch (err) {
        process.stderr.write(`[MCP] Evaluate error: ${err.message}\n`);
        return formatToolError(err);
      }
    });
  }
);

registerTool(
  'browser_hover',
  'Hover the mouse over an element using its CSS selector',
  {
    selector: z.string(),
    timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.TOOL_DEFAULT_TIMEOUT_MS)
  },
  async ({ selector, timeout_ms }) => {
    return runLocked(async () => {
      try {
        await ensureBrowserReady();

        if (navigationPromise) {
          await navigationPromise.catch(() => {});
        }

        const timeout = capTimeout(timeout_ms, 10000);
        process.stderr.write(`[MCP] Hovering element: ${selector}\n`);

        const result = await hoverElement(browser, selector, timeout);
        resetIdleTimer();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              hovered: true,
              selector,
              x: result.x,
              y: result.y,
              matchesHover: result.matchesHover
            })
          }]
        };

      } catch (err) {
        process.stderr.write(`[MCP] Hover error: ${err.message}\n`);
        return formatToolError(err);
      }
    });
  }
);

registerTool(
  'browser_press',
  'Press a keyboard key, optionally focusing an element first',
  {
    key: z.string().min(1),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional().default([]),
    selector: z.string().optional(),
    repeat: z.number().int().min(1).max(100).optional().default(1),
    timeout_ms: z.number().max(CONFIG.MAX_TIMEOUT_MS).optional().default(CONFIG.TOOL_DEFAULT_TIMEOUT_MS)
  },
  async ({ key, modifiers, selector, repeat, timeout_ms }) => {
    return runLocked(async () => {
      // Validate the key before starting the browser.
      let resolved;
      try {
        resolved = resolveKey(key, modifiers);
      } catch (err) {
        return formatToolError(err);
      }

      try {
        await ensureBrowserReady();

        if (navigationPromise) {
          await navigationPromise.catch(() => {});
        }

        const timeout = capTimeout(timeout_ms, 10000);
        // Never log a single-character key's value (may be sensitive input).
        const displayKey = resolved.key.length === 1 ? '<char>' : resolved.key;
        process.stderr.write(
          `[MCP] Pressing key: ${displayKey}` +
          `${modifiers.length ? ` (${modifiers.join('+')})` : ''}` +
          `${selector ? ` on ${selector}` : ''} x${repeat}\n`
        );

        const result = await pressKey(browser, key, {
          modifiers,
          selector,
          repeat,
          timeoutMs: timeout
        });
        resetIdleTimer();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              pressed: true,
              key: resolved.key,
              modifiers,
              count: repeat,
              selector: selector ?? null,
              focused: result.focused
            })
          }]
        };

      } catch (err) {
        process.stderr.write(`[MCP] Press error: ${err.message}\n`);
        return formatToolError(err);
      }
    });
  }
);

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  process.stderr.write('[MCP] Shutting down...\n');

  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  try {
    await browser.cleanup();
  } catch (err) {
    process.stderr.write(`[MCP] Error during cleanup: ${err.message}\n`);
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Exit when stdin closes (client disconnected)
process.stdin.on('close', () => {
  process.stderr.write('[MCP] stdin closed, shutting down\n');
  shutdown();
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[MCP] Server started\n');
}

main().catch((err) => {
  process.stderr.write(`[MCP] Fatal error: ${err.message}\n`);
  process.exit(1);
});
