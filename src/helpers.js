// src/helpers.js
// ---------------------------------------------------------------------------
// In-page JavaScript helper functions for the interaction tools
// (browser_click, browser_type, browser_select, browser_wait_for).
//
// SECURITY MODEL
// --------------
// Every in-page helper below is a STATIC string that is passed to
// Runtime.callFunctionOn as `functionDeclaration`. User-supplied values
// (CSS selectors, typed text) are ALWAYS passed separately via the CDP
// `arguments` array as JSON-serialized values — they are NEVER concatenated
// into JavaScript source. This makes selector/text-based code injection
// impossible: `'); maliciousCode(); ('` is treated as literal data.
//
// All helpers run in the page's main world and are plain functions.
// ---------------------------------------------------------------------------

import { resolveKey } from './keymap.js';
import { classifyWebglMessages } from './webgl.js';

export const IN_PAGE = {
  // document.querySelector. `this` is the document node.
  queryElement: `function(selector) {
    return this.querySelector(selector);
  }`,

  // Visibility check (display, visibility, opacity, zero-size). `this` is the element.
  isElementVisible: `function() {
    if (!this || this.nodeType !== 1) return false;
    const style = window.getComputedStyle(this);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = this.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }`,

  // Scroll element into view (centered in viewport). `this` is the element.
  // behavior:'instant' keeps the scroll synchronous — the default 'auto'
  // may be interpreted as smooth scrolling, whose animation races with
  // subsequent getClickablePoint / screenshot calls.
  scrollIntoView: `function() {
    this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return true;
  }`,

  // Scroll the page by a direction, optionally by an exact pixel amount.
  // Defaults to 80% of the viewport dimension. Uses 'instant' behavior so the
  // scroll position is settled synchronously (no animation in flight).
  scrollByDirection: `function(direction, pixels) {
    const amount = (pixels === undefined || pixels === null)
      ? Math.round(
          (direction === 'left' || direction === 'right')
            ? window.innerWidth * 0.8
            : window.innerHeight * 0.8
        )
      : Math.round(pixels);
    const opts = { behavior: 'instant' };
    switch (direction) {
      case 'up':    window.scrollBy({ ...opts, top: -amount }); break;
      case 'down':  window.scrollBy({ ...opts, top: amount }); break;
      case 'left':  window.scrollBy({ ...opts, left: -amount }); break;
      case 'right': window.scrollBy({ ...opts, left: amount }); break;
      case 'top':   window.scrollTo({ ...opts, top: 0 }); break;
      case 'bottom': window.scrollTo({ ...opts, top: document.documentElement.scrollHeight }); break;
      default:
        throw new Error('Invalid direction: ' + direction);
    }
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  }`,

  // Read current scroll position.
  getScrollPosition: `function() {
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  }`,

  // Scroll to absolute document coordinates. A null axis keeps its current
  // position, so a caller can scroll a single axis. `this` is unused; runs in page.
  scrollToPosition: `function(x, y) {
    window.scrollTo({
      top: (y === null || y === undefined) ? window.scrollY : y,
      left: (x === null || x === undefined) ? window.scrollX : x,
      behavior: 'instant'
    });
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  }`,

  // Does any part of this element intersect the current viewport? This is the
  // meaning callers expect from "inViewport": partially visible counts.
  isInViewport: `function() {
    const rect = this.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom > 0 && rect.right > 0 &&
      rect.top < vh && rect.left < vw;
  }`,

  // Is this element entirely within the current viewport? An element taller
  // than the viewport can never satisfy this.
  isFullyInViewport: `function() {
    const rect = this.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.top >= 0 && rect.left >= 0 &&
      rect.bottom <= vh && rect.right <= vw;
  }`,

  // Viewport-relative bounding box of this element, in CSS pixels. `this` is
  // the element. Used for element-clipped captures.
  getBoundingBox: `function() {
    const rect = this.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }`,

  // Wait for the next paint after a state change (double rAF ensures the
  // compositor has produced at least one new frame).
  waitForSettle: `function() {
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }`,

  // JavaScript click fallback — bypasses visual overlays. `this` is the element.
  jsClick: `function() {
    this.click();
    return true;
  }`,

  // Viewport-relative click coordinates in CSS pixels (as required by
  // Input.dispatchMouseEvent). Scans up to 5 points (center + four quadrants)
  // and reports the first unobstructed one, so partially-obscured elements
  // remain clickable. `this` is the element.
  getClickablePoint: `function() {
    const rect = this.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const points = [
      { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5 },
      { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.25 },
      { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.25 },
      { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.75 },
      { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.75 }
    ];

    for (const pt of points) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (pt.x < 0 || pt.y < 0 || pt.x > vw || pt.y > vh) continue;
      const elAtPoint = document.elementFromPoint(pt.x, pt.y);
      if (!elAtPoint || elAtPoint === this || this.contains(elAtPoint)) {
        return {
          x: Math.round(pt.x),
          y: Math.round(pt.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          covered: false,
          coveredBy: null
        };
      }
    }

    // All candidate points covered — report center for the caller to decide.
    const centerEl = document.elementFromPoint(points[0].x, points[0].y);
    return {
      x: Math.round(points[0].x),
      y: Math.round(points[0].y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      covered: true,
      coveredBy: centerEl
        ? centerEl.tagName.toLowerCase() +
          (centerEl.id ? '#' + centerEl.id : '') +
          (centerEl.className && typeof centerEl.className === 'string'
            ? '.' + centerEl.className.trim().split(/\\s+/).join('.') : '')
        : 'unknown'
    };
  }`,

  // Focus an input/textarea/contenteditable. `this` is the element.
  focusElement: `function() {
    try { this.focus(); } catch (e) { return false; }
    return document.activeElement === this || this.contains(document.activeElement);
  }`,

  // Is this element typeable (input, textarea, or contenteditable)?
  isTypeable: `function() {
    if (!this || this.nodeType !== 1) return false;
    const tag = this.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return true;
    return this.isContentEditable === true;
  }`,

  // Clear an input/textarea/contenteditable and dispatch input/change events.
  // Uses the native value setter so framework value trackers (React etc.)
  // observe the change. `this` is the element.
  clearInput: `function() {
    if (this.isContentEditable) {
      this.focus();
      this.textContent = '';
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    this.focus();
    const proto = this.tagName.toLowerCase() === 'textarea'
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(this, '');
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }`,

  // Type text character by character, dispatching input events per character
  // (and a final change event) for framework compatibility. Uses the native
  // value setter for inputs and document.execCommand('insertText') for
  // contenteditable. `this` is the element; `text` is passed as a CDP argument.
  typeText: `function(text) {
    this.focus();
    const chars = Array.from(String(text));
    for (const char of chars) {
      if (this.isContentEditable) {
        document.execCommand('insertText', false, char);
      } else {
        const start = (this.selectionStart == null) ? this.value.length : this.selectionStart;
        const end = (this.selectionEnd == null) ? this.value.length : this.selectionEnd;
        const proto = this.tagName.toLowerCase() === 'textarea'
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(this, this.value.slice(0, start) + char + this.value.slice(end));
        const newPos = start + char.length;
        try { this.setSelectionRange(newPos, newPos); } catch (e) { /* readonly */ }
        this.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (!this.isContentEditable) {
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return this.isContentEditable ? this.textContent : this.value;
  }`,

  // Choose an option in a <select> by value | label | index, then dispatch
  // input/change so framework listeners observe the change. `this` is the
  // select; the three criteria are passed as CDP arguments (never concatenated).
  selectOption: `function(value, label, index) {
    if (!this || this.tagName.toLowerCase() !== 'select') {
      return { error: 'not-a-select' };
    }
    const options = Array.from(this.options);
    let option = null;
    if (index !== null && index !== undefined) {
      option = options[index] || null;
    } else if (value !== null && value !== undefined) {
      option = options.find(o => o.value === value) || null;
    } else if (label !== null && label !== undefined) {
      option = options.find(o => o.textContent.trim() === String(label).trim()) || null;
    }
    if (!option) {
      return { error: 'option-not-found' };
    }
    const target = option;
    try { this.focus(); } catch (e) { /* not focusable — selection still applies */ }
    // Set the option's selected property rather than assigning this.value: some
    // engines mishandle the value setter for options whose value attribute is
    // absent or duplicated.
    target.selected = true;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      selected: true,
      value: this.value,
      label: target.textContent.trim(),
      index: this.selectedIndex
    };
  }`,

  // Whitespace normalization used for text matching (whitespace only — no
  // diacritic normalization, per spec).
  normalizeWhitespace: `function(text) {
    return String(text).replace(/\\s+/g, ' ').trim();
  }`,

  // Search for literal text in document.body.innerText with whitespace
  // normalization. `text` is passed as a CDP argument.
  findTextInPage: `function(text) {
    const normalize = (s) => String(s).replace(/\\s+/g, ' ').trim();
    const bodyText = (document.body && document.body.innerText) || '';
    return normalize(bodyText).includes(normalize(String(text)));
  }`,

  // Read back element info (tag, id, value, text) for verification.
  getElementInfo: `function() {
    const tag = this.tagName.toLowerCase();
    const value = (this.value !== undefined && this.value !== null)
      ? String(this.value) : '';
    return {
      tag,
      id: this.id || null,
      value,
      text: this.textContent || '',
      isContentEditable: this.isContentEditable === true
    };
  }`,

  // Is the element currently in the :hover state? `this` is the element.
  isHovered: `function() {
    try { return this.matches(':hover') === true; } catch (e) { return false; }
  }`,

  // Serialize an arbitrary in-page value into a JSON-safe structure, handling
  // cycles, depth/property limits, DOM nodes, functions, BigInt/Symbol, Date,
  // Error, Map and Set. `this` is the value; opts is passed as a CDP argument.
  // Never built from user input — this is a fixed declaration.
  serializeValue: `function(opts) {
    var maxDepth = (opts && opts.maxDepth) || 4;
    var maxProps = (opts && opts.maxProps) || 100;

    function describeElement(el) {
      var tag = el.tagName ? el.tagName.toLowerCase() : 'element';
      var id = el.id ? '#' + el.id : '';
      var cls = '';
      if (el.classList && el.classList.length) {
        cls = '.' + Array.prototype.slice.call(el.classList).join('.');
      }
      var text = '';
      if (el.textContent) {
        text = el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80);
      }
      return { __type: 'Element', tag: tag + id + cls, text: text };
    }

    function serialize(value, depth, seen) {
      if (value === undefined) return { __type: 'undefined' };
      if (value === null) return null;

      var t = typeof value;

      if (t === 'string' || t === 'boolean') return value;

      if (t === 'number') {
        if (Number.isNaN(value)) return { __type: 'number', value: 'NaN' };
        if (!Number.isFinite(value)) {
          return { __type: 'number', value: value > 0 ? 'Infinity' : '-Infinity' };
        }
        if (Object.is(value, -0)) return { __type: 'number', value: '-0' };
        return value;
      }

      if (t === 'bigint') return { __type: 'bigint', value: String(value) };
      if (t === 'symbol') return { __type: 'symbol', value: String(value) };
      if (t === 'function') {
        return { __type: 'function', name: value.name || '', length: value.length };
      }

      if (depth > maxDepth) {
        return { __type: 'truncated', reason: 'maxDepth' };
      }

      if (seen.has(value)) return { __type: 'circular' };
      seen.add(value);

      try {
        if (value instanceof Date) {
          return {
            __type: 'Date',
            value: isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
          };
        }
        if (value instanceof Error) {
          return { __type: 'Error', name: value.name, message: value.message };
        }
        if (typeof Element !== 'undefined' && value instanceof Element) {
          return describeElement(value);
        }
        if (typeof Node !== 'undefined' && value instanceof Node) {
          return { __type: 'Node', name: value.nodeName };
        }

        if (Array.isArray(value)) {
          var arr = [];
          var len = Math.min(value.length, maxProps);
          for (var i = 0; i < len; i++) {
            arr.push(serialize(value[i], depth + 1, seen));
          }
          if (value.length > maxProps) {
            arr.push({ __type: 'truncated', reason: 'maxItems', total: value.length });
          }
          return arr;
        }

        if (value instanceof Map) {
          var entries = [];
          var mCount = 0;
          value.forEach(function(v, k) {
            if (mCount < maxProps) {
              entries.push([serialize(k, depth + 1, seen), serialize(v, depth + 1, seen)]);
              mCount++;
            }
          });
          if (value.size > maxProps) {
            entries.push({ __type: 'truncated', reason: 'maxItems', total: value.size });
          }
          return { __type: 'Map', entries: entries };
        }

        if (value instanceof Set) {
          var values = [];
          var sCount = 0;
          value.forEach(function(v) {
            if (sCount < maxProps) {
              values.push(serialize(v, depth + 1, seen));
              sCount++;
            }
          });
          if (value.size > maxProps) {
            values.push({ __type: 'truncated', reason: 'maxItems', total: value.size });
          }
          return { __type: 'Set', values: values };
        }

        var out = {};
        var keys = Object.keys(value);
        var count = 0;
        for (var j = 0; j < keys.length && count < maxProps; j++) {
          var k2 = keys[j];
          try {
            out[k2] = serialize(value[k2], depth + 1, seen);
          } catch (e) {
            out[k2] = { __type: 'unserializable' };
          }
          count++;
        }
        if (keys.length > maxProps) {
          out.__truncated = { reason: 'maxProps', total: keys.length };
        }
        return out;
      } finally {
        seen.delete(value);
      }
    }

    return serialize(this, 0, new WeakSet());
  }`,

  // Probe WebGL availability in this document. Creates a throwaway canvas per
  // context type (a real context is not reusable for a different type), reads
  // the driver strings and limits when one succeeds, and releases it again via
  // WEBGL_lose_context so the probe does not hold a context slot. Reports the
  // shim's own globals too, so caller and page agree on who is serving WebGL.
  webglInfo: `function() {
    function probe(type) {
      var canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;

      var gl = null;
      var error = null;
      try {
        gl = canvas.getContext(type);
      } catch (e) {
        error = String((e && e.message) || e);
      }

      if (!gl) return { ok: false, error: error };

      var info = {
        ok: true,
        mock: gl.__mcpMock === true,
        vendor: null,
        renderer: null,
        version: null,
        maxTextureSize: null,
        maxRenderbufferSize: null,
        extensionCount: 0,
        extensions: [],
        unmasked: null
      };

      try {
        info.vendor = gl.getParameter(gl.VENDOR);
        info.renderer = gl.getParameter(gl.RENDERER);
        info.version = gl.getParameter(gl.VERSION);
        info.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        info.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);

        var extensions = gl.getSupportedExtensions ? gl.getSupportedExtensions() : [];
        info.extensions = extensions ? extensions.slice(0, 20) : [];
        info.extensionCount = extensions ? extensions.length : 0;

        if (gl.getExtension) {
          var debug = gl.getExtension('WEBGL_debug_renderer_info');
          if (debug) {
            info.unmasked = {
              vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
              renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
            };
          }
          var lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        }
      } catch (e) {
        info.probeError = String((e && e.message) || e);
      }

      return info;
    }

    function probeOffscreen(type) {
      if (typeof OffscreenCanvas === 'undefined') return { supported: false };
      try {
        var offscreen = new OffscreenCanvas(32, 32);
        var gl = offscreen.getContext(type);
        return { supported: true, ok: !!gl, mock: !!(gl && gl.__mcpMock === true) };
      } catch (e) {
        return { supported: true, ok: false, error: String((e && e.message) || e) };
      }
    }

    var shim = window.__mcpWebglShim || null;

    return {
      interfaces: {
        WebGLRenderingContext: typeof WebGLRenderingContext !== 'undefined',
        WebGL2RenderingContext: typeof WebGL2RenderingContext !== 'undefined',
        OffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
        WebGPUNavigator: (typeof navigator !== 'undefined' && 'gpu' in navigator)
      },
      contexts: { webgl: probe('webgl'), webgl2: probe('webgl2') },
      offscreen: { webgl: probeOffscreen('webgl'), webgl2: probeOffscreen('webgl2') },
      shim: shim
        ? { active: !!shim.active, mode: shim.mode, mockedContexts: shim.mockedContexts || 0 }
        : { active: false, mode: null, mockedContexts: 0 }
    };
  }`,

  // Describe every canvas: size, position, which context is serving it, and
  // whether it actually holds pixels. Blankness is measured by drawing the
  // canvas into an offscreen 2D canvas and sampling it (capped at 64x64, so the
  // cost is constant per canvas regardless of its real size).
  canvasInfo: `function(maxCanvases) {
    function pixelStats(canvas) {
      var w = Math.min(canvas.width || Math.ceil(canvas.clientWidth) || 1, 64);
      var h = Math.min(canvas.height || Math.ceil(canvas.clientHeight) || 1, 64);
      if (w < 1 || h < 1) return null;

      var probe = document.createElement('canvas');
      probe.width = w;
      probe.height = h;

      var ctx = null;
      try { ctx = probe.getContext('2d'); } catch (e) { ctx = null; }
      if (!ctx) return { error: 'no-2d-context' };

      try {
        ctx.drawImage(canvas, 0, 0, w, h);
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }

      var data;
      try {
        data = ctx.getImageData(0, 0, w, h).data;
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }

      var seen = new Set();
      var nonTransparent = 0;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 0) nonTransparent++;
        if (seen.size < 64) {
          seen.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2] + ',' + data[i + 3]);
        }
      }

      return {
        sampledWidth: w,
        sampledHeight: h,
        uniqueColors: seen.size,
        nonTransparentRatio: Math.round((nonTransparent / (w * h)) * 1000) / 1000,
        blank: seen.size <= 1
      };
    }

    var canvases = document.querySelectorAll('canvas');
    var limit = Math.min(canvases.length, maxCanvases);
    var entries = [];

    for (var i = 0; i < limit; i++) {
      var c = canvases[i];
      var rect = c.getBoundingClientRect();

      var entry = {
        index: i,
        id: c.id || null,
        className: (typeof c.className === 'string' && c.className) || null,
        attributeSize: { width: c.width, height: c.height },
        cssSize: { width: Math.round(rect.width), height: Math.round(rect.height) },
        position: { x: Math.round(rect.x), y: Math.round(rect.y) },
        mockContextType: c.__mcpMockContext || null,
        pixels: pixelStats(c)
      };

      try {
        entry.dataUrlLength = c.toDataURL().length;
      } catch (e) {
        entry.dataUrlError = String((e && e.message) || e);
      }

      entries.push(entry);
    }

    return {
      count: canvases.length,
      sampled: entries.length,
      truncated: canvases.length > limit,
      canvases: entries
    };
  }`
};

// ---------------------------------------------------------------------------
// Node-side runners (execute the in-page helpers via CDP)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeWhitespace(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

function isStaleObjectError(err) {
  return /could not find object with given id/i.test(err.message || '');
}

function helperError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

/**
 * ELEMENT_HIDDEN error: the element exists but is not rendered (display:none,
 * visibility:hidden, opacity:0, or zero-sized). `remedy` carries the
 * tool-specific advice, since what to do about it differs per tool.
 */
function elementHiddenError(selector, remedy) {
  return helperError(
    `Element is not visible (hidden, transparent, or zero-sized): ${selector}. ${remedy}`,
    'ELEMENT_HIDDEN'
  );
}

async function evaluateDocument(browser, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const result = await browser.send('Runtime.evaluate', {
    expression: 'document',
    returnByValue: false
  }, timeoutMs);
  if (result.exceptionDetails) {
    throw new Error('Could not access page document');
  }
  return result.result.objectId;
}

/**
 * Call an in-page helper via Runtime.callFunctionOn.
 *
 * @param {Browser} browser
 * @param {string} fn - one of IN_PAGE helper strings
 * @param {object} [options]
 * @param {string} [options.objectId] - target object (element/document)
 * @param {Array}  [options.args] - JSON-serializable argument values (NEVER concatenated)
 * @param {boolean} [options.returnByValue]
 * @param {number} [options.timeoutMs]
 */
async function callHelper(browser, fn, options = {}) {
  const {
    objectId = null,
    args = [],
    returnByValue = true,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  const params = {
    functionDeclaration: fn,
    arguments: args.map(value => ({ value })),
    returnByValue,
    awaitPromise: true
  };
  if (objectId) {
    params.objectId = objectId;
  } else {
    // Some Chromium builds omit executionContextId from Runtime.evaluate
    // responses, so target helpers at the document node instead — helpers
    // that don't need `this` still run fine in the page's main world.
    params.objectId = await evaluateDocument(browser, timeoutMs);
  }

  const result = await browser.send('Runtime.callFunctionOn', params, timeoutMs);

  if (result.exceptionDetails) {
    const exc = result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text || 'Unknown error';
    throw new Error(exc);
  }
  return result.result;
}

/**
 * Resolve a CSS selector to an element objectId, or null when not found.
 * Never evaluates user input as code — the selector travels as a data value.
 */
export async function queryElement(browser, selector) {
  const docId = await evaluateDocument(browser);
  const result = await callHelper(browser, IN_PAGE.queryElement, {
    objectId: docId,
    args: [selector],
    returnByValue: false
  });
  if (result.subtype === 'null' || result.value === null || !result.objectId) {
    return null;
  }
  return result.objectId;
}

/**
 * Poll for an element until found or timeout. Throws ELEMENT_NOT_FOUND.
 */
export async function waitForElement(browser, selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const elementId = await queryElement(browser, selector);
    if (elementId) {
      return elementId;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw helperError(`Element not found: ${selector}`, 'ELEMENT_NOT_FOUND');
}

export async function isElementVisible(browser, elementId) {
  const result = await callHelper(browser, IN_PAGE.isElementVisible, { objectId: elementId });
  return result.value === true;
}

export async function scrollIntoView(browser, elementId) {
  return callHelper(browser, IN_PAGE.scrollIntoView, { objectId: elementId });
}

export async function getClickablePoint(browser, elementId) {
  const result = await callHelper(browser, IN_PAGE.getClickablePoint, { objectId: elementId });
  return result.value;
}

/**
 * Resolve a selector and return its viewport-relative bounding box in CSS
 * pixels, or throw ELEMENT_NOT_FOUND. The selector is passed as a CDP argument,
 * never concatenated into the page code.
 */
export async function getBoundingBox(browser, selector, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const elementId = await waitForElement(browser, selector, timeoutMs);
  const result = await callHelper(browser, IN_PAGE.getBoundingBox, { objectId: elementId });
  return result.value;
}

/**
 * Scroll the page by a direction (up/down/left/right/top/bottom), optionally
 * by an exact pixel count. Returns { scrollX, scrollY }.
 */
export async function scrollByDirection(browser, direction, pixels) {
  const result = await callHelper(browser, IN_PAGE.scrollByDirection, {
    args: [direction, pixels ?? null],
    returnByValue: true
  });
  // The in-page scroll call only schedules the scroll — wait for the
  // compositor to produce a new frame before returning, so a screenshot in
  // the next tool call is not black (software rendering is slow to repaint).
  await sleep(100);
  await waitForSettle(browser).catch(() => {});
  return result.value;
}

/**
 * Scroll to absolute document coordinates. A null axis keeps its current
 * position. Returns { scrollX, scrollY }.
 */
export async function scrollToPosition(browser, x, y) {
  const result = await callHelper(browser, IN_PAGE.scrollToPosition, {
    args: [x ?? null, y ?? null],
    returnByValue: true
  });
  await sleep(100);
  await waitForSettle(browser).catch(() => {});
  return result.value;
}

/**
 * Scroll the target element into view and report its visibility. `inViewport`
 * means any part is visible; `fullyInViewport` means all of it fits.
 * Returns { scrollX, scrollY, inViewport, fullyInViewport }.
 */
export async function scrollToElement(browser, selector, timeoutMs = 10000) {
  const elementId = await waitForElement(browser, selector, timeoutMs);
  await scrollIntoView(browser, elementId);
  await sleep(100); // let the compositor begin the repaint
  await waitForSettle(browser).catch(() => {}); // wait for the new frame
  const inViewport = await callHelper(browser, IN_PAGE.isInViewport, {
    objectId: elementId,
    returnByValue: true
  });
  const fullyInViewport = await callHelper(browser, IN_PAGE.isFullyInViewport, {
    objectId: elementId,
    returnByValue: true
  });
  const position = await callHelper(browser, IN_PAGE.getScrollPosition, {
    returnByValue: true
  });
  return {
    scrollX: position.value.scrollX,
    scrollY: position.value.scrollY,
    inViewport: inViewport.value === true,
    fullyInViewport: fullyInViewport.value === true
  };
}

export async function waitForSettle(browser) {
  return callHelper(browser, IN_PAGE.waitForSettle, { returnByValue: true });
}

export async function focusElement(browser, elementId) {
  const result = await callHelper(browser, IN_PAGE.focusElement, { objectId: elementId });
  return result.value === true;
}

export async function isTypeable(browser, elementId) {
  const result = await callHelper(browser, IN_PAGE.isTypeable, { objectId: elementId });
  return result.value === true;
}

export async function clearInput(browser, elementId) {
  return callHelper(browser, IN_PAGE.clearInput, { objectId: elementId });
}

export async function typeText(browser, elementId, text) {
  const result = await callHelper(browser, IN_PAGE.typeText, {
    objectId: elementId,
    args: [text],
    returnByValue: true
  });
  return result.value !== undefined ? String(result.value) : '';
}

export async function getElementInfo(browser, elementId) {
  const result = await callHelper(browser, IN_PAGE.getElementInfo, { objectId: elementId });
  return result.value;
}

export async function findTextInPage(browser, text) {
  const result = await callHelper(browser, IN_PAGE.findTextInPage, {
    args: [text],
    returnByValue: true
  });
  return result.value === true;
}

/**
 * Poll for a text occurrence in document.body.innerText until found or timeout.
 * Literal matching with whitespace normalization only (no diacritic handling).
 */
export async function waitForText(browser, text, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await findTextInPage(browser, text);
    if (found) {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw helperError(`Text not found: "${normalizeWhitespace(text)}"`, 'TEXT_NOT_FOUND');
}

/**
 * High-level click: wait for element, check visibility, scroll into view,
 * resolve a click point, and dispatch real mouse events via CDP.
 *
 * Options:
 *   - force: when true, falls back to a JavaScript .click() if every hit-test
 *     point is covered by an overlay (Playwright-style). Returns forced: true.
 *   - settleMs: extra render-settle wait after the click (default 100ms).
 *
 * Returns { x, y, forced? }.
 */
export async function clickElement(browser, selector, timeoutMs, options = {}) {
  const { force = false, settleMs = 100 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let elementId;
    try {
      elementId = await queryElement(browser, selector);
      if (!elementId) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const visible = await isElementVisible(browser, elementId);
      if (!visible) {
        throw elementHiddenError(
          selector,
          'If it only appears on hover, run browser_hover first; otherwise retry with force:true to click it anyway.'
        );
      }

      await scrollIntoView(browser, elementId);
      // behavior:'instant' makes the scroll synchronous; still give the
      // compositor a frame so the element's final position is stable before
      // the coverage check (sticky headers / below-viewport elements).
      await sleep(100);
      await waitForSettle(browser).catch(() => {});

      let point = await getClickablePoint(browser, elementId);

      // The first read may reflect a stale position if the scroll has not
      // fully settled — wait a moment and re-check before declaring the
      // element covered.
      if (point.covered) {
        await sleep(100);
        await waitForSettle(browser).catch(() => {});
        point = await getClickablePoint(browser, elementId);
      }

      if (point.covered) {
        if (force) {
          // JavaScript click fallback — bypasses visual overlays entirely.
          await callHelper(browser, IN_PAGE.jsClick, { objectId: elementId });
          await waitForSettle(browser).catch(() => {});
          return { x: point.x, y: point.y, forced: true };
        }
        throw helperError(
          `Element is not clickable (covered by ${point.coveredBy}): ${selector}`,
          'ELEMENT_NOT_CLICKABLE'
        );
      }

      await dispatchMouseClick(browser, point.x, point.y);
      // Give the browser at least one render frame before returning, so a
      // screenshot in the next tool call is not blank.
      await sleep(settleMs);
      await waitForSettle(browser).catch(() => {});
      return { x: point.x, y: point.y };
    } catch (err) {
      if (isStaleObjectError(err)) {
        // Page changed under us (e.g. navigation); re-resolve and retry.
        continue;
      }
      throw err;
    }
  }

  throw helperError(`Element not found: ${selector}`, 'ELEMENT_NOT_FOUND');
}

async function dispatchMouseClick(browser, x, y) {
  const params = { x, y, button: 'left', clickCount: 1 };
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...params }, DEFAULT_TIMEOUT_MS);
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params }, DEFAULT_TIMEOUT_MS);
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params }, DEFAULT_TIMEOUT_MS);
}

/**
 * High-level type: wait for element, verify typeable, focus, optionally clear,
 * then type text character by character. Returns the final element value.
 */
export async function typeIntoElement(browser, selector, text, options = {}) {
  const { clearFirst = true, timeoutMs = 10000 } = options;
  const elementId = await waitForElement(browser, selector, timeoutMs);

  const typeable = await isTypeable(browser, elementId);
  if (!typeable) {
    throw helperError(
      `Element is not typeable (must be input, textarea, or contenteditable): ${selector}`,
      'ELEMENT_NOT_TYPEABLE'
    );
  }

  await focusElement(browser, elementId);

  if (clearFirst) {
    await clearInput(browser, elementId);
  }

  return typeText(browser, elementId, text);
}

/**
 * Resolve a <select> and choose one option by value, label, or index. Dispatches
 * input/change so framework listeners observe the change. Returns
 * { value, label, index }.
 *
 * Throws ELEMENT_NOT_FOUND, ELEMENT_HIDDEN, ELEMENT_NOT_SELECT, OPTION_NOT_FOUND.
 */
export async function selectOptionInElement(browser, selector, options = {}) {
  const { value = null, label = null, index = null, timeoutMs = 10000 } = options;
  const elementId = await waitForElement(browser, selector, timeoutMs);

  const visible = await isElementVisible(browser, elementId);
  if (!visible) {
    throw elementHiddenError(
      selector,
      'It must be rendered before its value can be set.'
    );
  }

  const result = await callHelper(browser, IN_PAGE.selectOption, {
    objectId: elementId,
    args: [value, label, index],
    returnByValue: true
  });

  const out = result.value || {};
  if (out.error === 'not-a-select') {
    throw helperError(`Element is not a <select>: ${selector}`, 'ELEMENT_NOT_SELECT');
  }
  if (out.error === 'option-not-found') {
    const criteria = index !== null
      ? `index=${index}`
      : value !== null
        ? `value="${value}"`
        : `label="${label}"`;
    throw helperError(
      `No matching option in ${selector} for ${criteria}`,
      'OPTION_NOT_FOUND'
    );
  }

  await waitForSettle(browser).catch(() => {});
  return { value: out.value, label: out.label, index: out.index };
}

/**
 * High-level wait: poll for selector existence and/or page text.
 * Returns elapsed milliseconds once all requested conditions are met.
 */
export async function waitForCondition(browser, { selector = null, text = null, timeoutMs = 15000 } = {}) {
  if (!selector && !text) {
    throw helperError('Provide at least one of "selector" or "text" to wait for', 'INVALID_ARGS');
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let selectorOk = true;
    let textOk = true;

    if (selector) {
      selectorOk = (await queryElement(browser, selector)) !== null;
    }
    if (text) {
      textOk = await findTextInPage(browser, text);
    }

    if (selectorOk && textOk) {
      return Date.now() - start;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const pending = [];
  if (selector) pending.push(`element "${selector}"`);
  if (text) pending.push(`text "${normalizeWhitespace(text)}"`);
  throw helperError(
    `Timed out after ${timeoutMs}ms waiting for ${pending.join(' and ')}`,
    'TIMEOUT'
  );
}

export async function isHovered(browser, elementId) {
  const result = await callHelper(browser, IN_PAGE.isHovered, { objectId: elementId });
  return result.value === true;
}

async function dispatchMouseMove(browser, x, y) {
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none'
  }, DEFAULT_TIMEOUT_MS);
}

/**
 * High-level hover: wait for element, check visibility, scroll into view,
 * resolve an unobstructed point, move the real mouse there, and verify the
 * :hover state. Some engines do not enter :hover on a single jump, so a
 * nudge (move away then back) is attempted before giving up.
 *
 * Returns { x, y, matchesHover }.
 */
export async function hoverElement(browser, selector, timeoutMs = 10000) {
  const elementId = await waitForElement(browser, selector, timeoutMs);

  const visible = await isElementVisible(browser, elementId);
  if (!visible) {
    throw elementHiddenError(
      selector,
      'It must be rendered before it can be hovered — wait for it to appear or check the selector.'
    );
  }

  await scrollIntoView(browser, elementId);
  await sleep(100);
  await waitForSettle(browser).catch(() => {});

  let point = await getClickablePoint(browser, elementId);
  if (point.covered) {
    // Re-read once: the first read may predate the scroll settling.
    await sleep(100);
    await waitForSettle(browser).catch(() => {});
    point = await getClickablePoint(browser, elementId);
  }

  await dispatchMouseMove(browser, point.x, point.y);
  let matchesHover = await isHovered(browser, elementId);

  if (!matchesHover) {
    await dispatchMouseMove(browser, point.x + 1, point.y + 1);
    await dispatchMouseMove(browser, point.x, point.y);
    await waitForSettle(browser).catch(() => {});
    matchesHover = await isHovered(browser, elementId);
  }

  await waitForSettle(browser).catch(() => {});
  return { x: point.x, y: point.y, matchesHover };
}

async function dispatchKey(browser, resolved) {
  const base = {
    modifiers: resolved.modifiers,
    key: resolved.key,
    code: resolved.code,
    windowsVirtualKeyCode: resolved.keyCode,
    nativeVirtualKeyCode: resolved.keyCode
  };

  const hasText = typeof resolved.text === 'string';
  await browser.send('Input.dispatchKeyEvent', {
    type: hasText ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(hasText ? { text: resolved.text, unmodifiedText: resolved.text } : {})
  }, DEFAULT_TIMEOUT_MS);

  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...base
  }, DEFAULT_TIMEOUT_MS);
}

/**
 * High-level key press. When a selector is given the element is resolved,
 * checked for visibility, scrolled into view and focused first. The key is
 * resolved from `src/keymap.js` (never built from user input).
 *
 * Returns { focused }.
 */
export async function pressKey(browser, key, options = {}) {
  const { modifiers = [], selector = null, repeat = 1, timeoutMs = 10000 } = options;

  const resolved = resolveKey(key, modifiers);

  let focused = false;
  if (selector) {
    const elementId = await waitForElement(browser, selector, timeoutMs);

    const visible = await isElementVisible(browser, elementId);
    if (!visible) {
      throw elementHiddenError(
        selector,
        'It must be rendered before it can be focused — wait for it to appear or check the selector.'
      );
    }

    await scrollIntoView(browser, elementId);
    await sleep(100);
    await waitForSettle(browser).catch(() => {});
    focused = await focusElement(browser, elementId);
  }

  for (let i = 0; i < repeat; i++) {
    await dispatchKey(browser, resolved);
  }

  // Let submit/navigation handlers run and the compositor paint a frame so a
  // screenshot in the next tool call is not blank.
  await sleep(50);
  await waitForSettle(browser).catch(() => {});

  return { focused };
}

/**
 * Evaluate an expression in the page and return a serialized result.
 *
 * Primitives come back directly; objects/functions/DOM nodes are serialized
 * by the static IN_PAGE.serializeValue helper (never from user input). The
 * remote object handle is always released.
 *
 * Returns { type, value }. Throws an error with code EVAL_ERROR on an
 * in-page exception.
 */
export async function evaluateExpression(browser, expression, options = {}) {
  const { awaitPromise = true, userGesture = false, timeoutMs = 10000 } = options;

  const evalResult = await browser.send('Runtime.evaluate', {
    expression,
    returnByValue: false,
    awaitPromise,
    userGesture,
    generatePreview: true
  }, timeoutMs);

  if (evalResult.exceptionDetails) {
    const details = evalResult.exceptionDetails;
    const description =
      details.exception?.description || details.text || 'Unknown evaluation error';
    throw helperError(description, 'EVAL_ERROR');
  }

  const remote = evalResult.result;
  if (!remote) {
    return { type: 'undefined', value: undefined };
  }

  if (remote.type === 'undefined') {
    return { type: 'undefined', value: undefined };
  }
  if (remote.type === 'string' || remote.type === 'boolean') {
    return { type: remote.type, value: remote.value };
  }
  if (remote.type === 'number') {
    if (remote.unserializableValue) {
      return { type: 'number', value: remote.unserializableValue };
    }
    return { type: 'number', value: remote.value };
  }
  if (remote.type === 'bigint') {
    return { type: 'bigint', value: remote.unserializableValue || String(remote.value) };
  }
  if (remote.type === 'symbol') {
    return { type: 'symbol', value: remote.description || 'Symbol()' };
  }

  if (remote.objectId) {
    try {
      const serialized = await callHelper(browser, IN_PAGE.serializeValue, {
        objectId: remote.objectId,
        args: [{ maxDepth: 4, maxProps: 100 }],
        returnByValue: true,
        timeoutMs
      });
      return { type: remote.subtype || remote.type || 'object', value: serialized.value };
    } finally {
      await browser.send('Runtime.releaseObject', { objectId: remote.objectId }, 5000)
        .catch(() => {});
    }
  }

  return { type: remote.type || 'object', value: remote.value === undefined ? null : remote.value };
}

/**
 * Report whether the page can use WebGL, and why not.
 *
 * Read-only and independent of browser_evaluate: it runs a fixed expression, so
 * it needs no opt-in. `effective` is the short answer — 'real' for a real
 * context, 'shimmed' for one served by browser_webgl_shim, 'unavailable' when
 * neither could be created. The console hits matter as much as the probe: a
 * WebGL app that fails to boot leaves no other trace on the page.
 */
export async function webglInfo(browser, { includeConsole = true } = {}) {
  const result = await callHelper(browser, IN_PAGE.webglInfo);
  const probe = result.value || {};

  const gl1 = probe.contexts?.webgl || null;
  const gl2 = probe.contexts?.webgl2 || null;
  const real = (gl1?.ok === true && gl1.mock !== true) || (gl2?.ok === true && gl2.mock !== true);
  const shimmed =
    (gl1?.ok === true && gl1.mock === true) || (gl2?.ok === true && gl2.mock === true);

  const report = {
    usable: real,
    effective: shimmed ? 'shimmed' : (real ? 'real' : 'unavailable'),
    webgl: gl1,
    webgl2: gl2,
    offscreen: probe.offscreen || null,
    interfaces: probe.interfaces || null,
    shim: probe.shim || { active: false, mode: null, mockedContexts: 0 }
  };

  if (report.effective === 'unavailable') {
    report.reason = 'No WebGL context could be created in this environment';
    report.advice =
      'WebGL output is unavailable. If the app must boot anyway, enable browser_webgl_shim ' +
      '(ENABLE_WEBGL_SHIM=1) with mode "mock" or "trace" and reload.';
  } else if (shimmed) {
    report.reason = 'WebGL is served by the shim, not by a GPU — nothing is rasterized';
    report.advice =
      'Use browser_webgl_trace to inspect what the page intended to draw, and ' +
      'browser_canvas_info to confirm the canvas is blank on purpose.';
  }

  if (includeConsole && browser.consoleBuffer) {
    const hits = classifyWebglMessages(browser.consoleBuffer.getMessages('all'));
    if (hits.length > 0) report.consoleHits = hits;
  }

  return report;
}

/** Plain-language verdict for one canvas, so the numbers are not left to guesswork. */
function canvasVerdict(entry) {
  if (entry.pixels?.blank === true && entry.mockContextType) {
    return `Blank on purpose: this canvas holds a "${entry.mockContextType}" context served by the ` +
      'WebGL shim, which records calls but rasterizes nothing. Inspect browser_webgl_trace instead.';
  }
  if (entry.pixels?.blank === true) {
    return 'Blank: nothing was drawn into this canvas (or it was cleared and never re-rendered).';
  }
  return 'Has pixel content.';
}

/**
 * Describe every canvas on the page and whether it holds pixels. This is what
 * separates "the app is broken" from "nothing here can rasterize".
 */
export async function canvasInfo(browser, maxCanvases = 50) {
  const result = await callHelper(browser, IN_PAGE.canvasInfo, {
    args: [maxCanvases]
  });
  const page = result.value || { canvases: [] };
  const canvases = (page.canvases || []).map(entry => ({
    ...entry,
    verdict: canvasVerdict(entry)
  }));

  return {
    count: page.count ?? canvases.length,
    blank: canvases.filter(c => c.pixels?.blank === true).length,
    sampled: page.sampled ?? canvases.length,
    truncated: page.truncated === true,
    canvases
  };
}

export default {
  IN_PAGE,
  normalizeWhitespace,
  queryElement,
  waitForElement,
  isElementVisible,
  scrollIntoView,
  getClickablePoint,
  getBoundingBox,
  scrollByDirection,
  scrollToPosition,
  scrollToElement,
  waitForSettle,
  focusElement,
  isTypeable,
  clearInput,
  typeText,
  getElementInfo,
  findTextInPage,
  waitForText,
  clickElement,
  typeIntoElement,
  selectOptionInElement,
  waitForCondition,
  isHovered,
  hoverElement,
  pressKey,
  evaluateExpression,
  webglInfo,
  canvasInfo
};
