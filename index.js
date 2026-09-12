#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Browser } from './src/browser.js';
import { validateURL, capTimeout, truncateText, validateSafePath, ERRORS, CONFIG } from './src/utils.js';
import { OperationLock, withLock } from './src/lock.js';
import {
  clickElement,
  typeIntoElement,
  waitForCondition,
  normalizeWhitespace,
  scrollByDirection,
  scrollToPosition,
  scrollToElement,
  waitForSettle
} from './src/helpers.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const server = new McpServer({
  name: 'browser-mcp',
  version: '1.0.0'
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
      return await handler(args);
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

        const JPEG_EXTENSIONS = ['.jpg', '.jpeg'];
        const PNG_EXTENSIONS = ['.png'];

        if (!filename) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          filename = `screenshot-${timestamp}.${format}`;
        } else {
          const ext = format === 'jpeg' ? JPEG_EXTENSIONS : PNG_EXTENSIONS;
          const hasExt = ext.some(e => filename.toLowerCase().endsWith(e));
          if (!hasExt) {
            filename = `${filename}.${format === 'jpeg' ? 'jpg' : 'png'}`;
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

        let clip;
        let captureBeyondViewport = false;
        // Dimensions used for the pixel-limit check (full-page: the clip;
        // viewport: the visual viewport — no clip is passed for viewport shots).
        let captureSize = null;

        if (full_page) {
          // Trigger lazy rendering (IntersectionObserver) for below-fold sections
          // before capturing — otherwise middle sections come out blank.
          await warmUpPageForScreenshot(browser);

          // Re-read metrics: contentSize may have grown after the warm-up.
          metrics = await browser.send('Page.getLayoutMetrics', {}, 5000);
          const contentSize = metrics.contentSize || metrics.cssContentSize;
          clip = {
            x: 0,
            y: 0,
            width: contentSize.width,
            height: contentSize.height,
            scale: 1
          };
          captureBeyondViewport = true;
        } else {
          // Viewport capture: do NOT pass a clip. An explicit clip with
          // captureBeyondViewport:false captures a BLANK (white/black) frame
          // when the page is scrolled — clip coordinates are page-space, and
          // Chromium never produces the clipped surface for the scrolled page.
          // Without a clip, the current viewport at the current scroll
          // position is captured correctly.
          const visualViewport = metrics.visualViewport || metrics.layoutViewport;
          captureSize = {
            width: visualViewport.clientWidth,
            height: visualViewport.clientHeight
          };
        }

        const totalPixels = (clip ?? captureSize).width * (clip ?? captureSize).height;
        let truncated = false;

        if (totalPixels > MAX_SCREENSHOT_PIXELS) {
          // FIX: reduce RESOLUTION via clip.scale, keeping clip.width/height at the
          // full capture dimensions. Shrinking the clip would CROP the page
          // (right/bottom edges lost) instead of downscaling it.
          const scaleFactor = Math.sqrt(MAX_SCREENSHOT_PIXELS / totalPixels);
          clip.scale = scaleFactor;
          truncated = true;
          const outputPixels =
            Math.round(clip.width * scaleFactor) * Math.round(clip.height * scaleFactor);
          process.stderr.write(
            `[MCP] Screenshot scaled from ${totalPixels} to ~${outputPixels} pixels (scale=${scaleFactor.toFixed(3)})\n`
          );
        }

        const screenshotParams = {
          format
        };

        // Full-page captures pass an explicit clip (page coordinates, with
        // captureBeyondViewport so the whole document is captured). Viewport
        // captures pass no clip — see the viewport branch above.
        if (clip) {
          screenshotParams.clip = clip;
          screenshotParams.captureBeyondViewport = captureBeyondViewport;
        }

        if (format === 'jpeg') {
          screenshotParams.quality = quality;
        }

        // Optional explicit delay for pages with heavy animations or
        // lazy-loaded content (the post-click settle covers the common case).
        if (delay_ms > 0) {
          process.stderr.write(`[MCP] Screenshot delay: ${delay_ms}ms\n`);
          await new Promise(resolve => setTimeout(resolve, delay_ms));
        }

        // For full-page captures, temporarily set the viewport height to the full
        // page height so CSS layout computations (grid/flex/100vh) resolve
        // correctly. ALWAYS reset afterwards, even on failure.
        let emulationSet = false;
        try {
          if (full_page) {
            const viewport = metrics.visualViewport || metrics.layoutViewport;
            await browser.send('Emulation.setDeviceMetricsOverride', {
              width: viewport.clientWidth,
              height: Math.max(clip.height, viewport.clientHeight),
              deviceScaleFactor: 1,
              mobile: false
            }, 5000);
            emulationSet = true;
            await new Promise(resolve => setTimeout(resolve, 200));
          }

          const result = await browser.send('Page.captureScreenshot', screenshotParams, 30000);

          const buffer = Buffer.from(result.data, 'base64');

          await writeFile(pathValidation.path, buffer);

          resetIdleTimer();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  path: pathValidation.path,
                  size: buffer.length,
                  truncated
                })
              },
              {
                type: 'image',
                data: result.data,
                mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png'
              }
            ]
          };
        } finally {
          if (emulationSet) {
            await browser.send('Emulation.clearDeviceMetricsOverride', {}, 5000).catch(() => {});
          }
        }

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
            truncated: interactiveElements.length >= max_items
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
      if (hasPosition && (x === undefined || y === undefined)) {
        return formatToolError(toolError(
          'INVALID_ARGS',
          'Both x and y must be provided for coordinate scrolling'
        ));
      }

      process.stderr.write(`[MCP] Scrolling: ${hasSelector ? `to element ${selector}` : hasDirection ? `by direction ${direction}${pixels !== undefined ? ` (${pixels}px)` : ''}` : `to (${x}, ${y})`}\n`);

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
              inViewport: result.inViewport
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
            x,
            y
          })
        }]
      };

    } catch (err) {
      process.stderr.write(`[MCP] Scroll error: ${err.message}\n`);
      return formatToolError(err);
    }
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
