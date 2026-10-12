import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CDPClient } from './cdp.js';
import { ConsoleBuffer } from './console-buffer.js';
import { ERRORS, isWebmcpEnabled } from './utils.js';
import { SHIM_MODES, SHIM_SOURCES } from './webgl.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const KNOWN_PATHS = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
];

const DEFAULT_FLAGS = [
  '--headless',
  '--no-sandbox',
  // NOTE: no --window-size. A desktop-sized default (1440x900) was measured to
  // make the first viewport capture ~5x more expensive (software rendering on
  // ARM), pushing a single screenshot past 30s and timing out the suite. The
  // default stays at Chromium's own 780x437; call browser_resize when a desktop
  // layout is needed.
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-software-rasterizer',
  '--use-gl=swiftshader',
  '--disable-features=dbus',
  '--no-zygote',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--no-first-run',
  // Prevent the crashpad handler from lingering as an orphan when the main
  // Chromium process is killed hard (SIGKILL) — crash reports are not needed
  // for an automation browser.
  '--disable-crash-reporter',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0'
];

const STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  RECONNECTING: 'reconnecting',
  RESTARTING: 'restarting',
  FAILED: 'failed',
  STOPPING: 'stopping'
};

export class Browser {
  constructor(options = {}) {
    this.options = options;
    this.state = STATES.STOPPED;
    this.process = null;
    this.pid = null;
    this.profileDir = null;
    this.cdp = null;
    this.port = null;
    this.failureReason = null;
    this.stderrLines = [];
    this.maxStderrLines = options.maxStderrLines || 100;
    // Persistent viewport override applied by browser_resize. It lives on the
    // Browser object (survives idle shutdown) and is re-applied after a
    // restart/reconnect, since the Emulation override does not survive a new
    // Chromium process.
    this.viewport = null;
    // WebGL shim registration ({ mode, identifier }) installed by
    // browser_webgl_shim. Like the viewport it is remembered here so it can be
    // re-registered after a reconnect or a crash restart — the CDP registration
    // itself does not survive either.
    this.webglShim = null;
    // WebMCP: null = not probed yet, true/false = CDP `WebMCP` domain usable.
    // The live tool catalog is maintained from WebMCP.toolsAdded/toolsRemoved
    // and cleared on main-frame navigation (tools belong to the document).
    this.webmcpAvailable = null;
    this.webmcpTools = new Map();
    // Set by a crash restart; the first tool call afterwards reports it so the
    // client knows the old page state is gone.
    this.sessionReset = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
    this.restartAttempts = 0;
    this.maxRestartAttempts = options.maxRestartAttempts ?? 2;
    this._cleanupDone = false;
    this.consoleBuffer = new ConsoleBuffer();
  }

  findChromiumPath() {
    if (process.env.CHROMIUM_PATH) {
      if (existsSync(process.env.CHROMIUM_PATH)) {
        return process.env.CHROMIUM_PATH;
      }
      throw new Error(`CHROMIUM_PATH set but not found: ${process.env.CHROMIUM_PATH}`);
    }

    for (const path of KNOWN_PATHS) {
      if (existsSync(path)) {
        return path;
      }
    }

    throw new Error('Chromium not found. Set CHROMIUM_PATH environment variable.');
  }

  async start({ preserveProfile = false } = {}) {
    if (this.state !== STATES.STOPPED && this.state !== STATES.FAILED) {
      throw new Error(`Cannot start: state is ${this.state}`);
    }

    this.state = STATES.STARTING;
    this.stderrLines = [];
    this.failureReason = null;
    this._cleanupDone = false;

    const execPath = this.findChromiumPath();
    process.stderr.write(`[Browser] Found Chromium at: ${execPath}\n`);

    // A crash restart reuses the existing profile so the page's stored state
    // (localStorage, session storage, cookies) survives. A fresh start — and
    // any start after a graceful cleanup — gets a new directory.
    if (preserveProfile && this.profileDir && existsSync(this.profileDir)) {
      process.stderr.write(`[Browser] Reusing profile: ${this.profileDir}\n`);
      // A killed Chromium leaves its singleton lock and DevToolsActivePort
      // behind. Without clearing them the new instance delegates to the dead
      // one and exits immediately, and the stale port file would be read as
      // this instance's CDP port.
      for (const stale of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
        rmSync(join(this.profileDir, stale), { force: true });
      }
    } else {
      this.profileDir = mkdtempSync(join(tmpdir(), 'browser-mcp-'));
      process.stderr.write(`[Browser] Profile dir: ${this.profileDir}\n`);
    }

    const args = [
      ...DEFAULT_FLAGS,
      // Enable Chrome's experimental WebMCP feature (document.modelContext +
      // the CDP WebMCP domain). Opt-out via ENABLE_WEBMCP=0.
      ...(isWebmcpEnabled() ? ['--enable-features=WebMCP'] : []),
      `--user-data-dir=${this.profileDir}`,
      'about:blank'
    ];

    try {
      this.process = spawn(execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      this.pid = this.process.pid;
      process.stderr.write(`[Browser] Chromium PID: ${this.pid}\n`);

      this.process.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) {
          this.stderrLines.push(line);
          if (this.stderrLines.length > this.maxStderrLines) {
            this.stderrLines.shift();
          }
        }
      });

      this.process.on('exit', (code, signal) => {
        process.stderr.write(`[Browser] Chromium exited: code=${code} signal=${signal}\n`);
        if (this.state === STATES.READY || this.state === STATES.RECONNECTING) {
          this.state = STATES.RESTARTING;
          this._handleCrash();
        }
      });

      await this._waitForDevToolsPort();
      await this._connectToPage();

      this.state = STATES.READY;
      this.reconnectAttempts = 0;
      this.restartAttempts = 0;
      process.stderr.write(`[Browser] Ready on port ${this.port}\n`);

    } catch (err) {
      this.state = STATES.FAILED;
      await this.cleanup();
      throw err;
    }
  }

  async _waitForDevToolsPort(timeoutMs = 30000) {
    const portFile = join(this.profileDir, 'DevToolsActivePort');
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (existsSync(portFile)) {
        try {
          const content = readFileSync(portFile, 'utf8').trim();
          const port = parseInt(content.split('\n')[0], 10);
          if (!isNaN(port) && port > 0) {
            this.port = port;
            process.stderr.write(`[Browser] CDP port: ${port}\n`);
            return;
          }
        } catch {
          // Ignore read errors
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for DevToolsActivePort after ${timeoutMs}ms`);
  }

  async _connectToPage() {
    const url = `http://127.0.0.1:${this.port}/json/list`;
    const startTime = Date.now();
    const timeoutMs = 10000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const targets = await response.json();
          const pageTarget = targets.find(t => t.type === 'page');
          
          if (pageTarget && pageTarget.webSocketDebuggerUrl) {
            this.cdp = new CDPClient();
            await this.cdp.connect(pageTarget.webSocketDebuggerUrl);

            // If the WebSocket drops while the Chromium process is alive,
            // reconnect to the SAME process with exponential backoff.
            this.cdp.on('close', () => {
              if (this.state === STATES.READY) {
                this.state = STATES.RECONNECTING;
                process.stderr.write('[Browser] WebSocket closed; reconnecting...\n');
                this._reconnect().catch((err) => {
                  process.stderr.write(`[Browser] Reconnect failed: ${err.message}\n`);
                  if (this.state === STATES.RECONNECTING) {
                    this.state = STATES.FAILED;
                    this.failureReason = err;
                  }
                });
              }
            });

            await this._enableDomains();
            this._setupConsoleListeners();
            this._setupDialogHandler();
            await this._reapplyViewport();
            await this._reapplyWebglShim();
            await this._setupWebmcp();
            return;
          }
        }
      } catch {
        // Ignore fetch errors
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error(`Timeout waiting for page target after ${timeoutMs}ms`);
  }

  async _enableDomains() {
    // Domains that require an explicit `enable` command.
    const domains = ['Page', 'Runtime', 'Network', 'DOM', 'Accessibility'];
    for (const domain of domains) {
      try {
        await this.cdp.send(`${domain}.enable`, {}, 5000);
        process.stderr.write(`[Browser] Enabled ${domain} domain\n`);
      } catch (err) {
        throw new Error(`Failed to enable ${domain}: ${err.message}`);
      }
    }
    // Emulation has no `enable` command — it is available on any session.
    process.stderr.write('[Browser] Emulation domain available (no enable needed)\n');
  }

  _setupConsoleListeners() {
    this.cdp.on('Runtime.consoleAPICalled', (params) => {
      const level = params.type;
      const text = params.args
        .map(arg => {
          if (arg.type === 'string') return arg.value;
          if (arg.type === 'number' || arg.type === 'boolean') return String(arg.value);
          if (arg.type === 'undefined') return 'undefined';
          if (arg.type === 'object' && arg.subtype === 'null') return 'null';
          if (arg.description) return arg.description;
          return JSON.stringify(arg.value);
        })
        .join(' ');

      this.consoleBuffer.add({
        level,
        text,
        timestamp: params.timestamp,
        url: params.stackTrace?.callFrames?.[0]?.url || null
      });
    });

    this.cdp.on('Runtime.exceptionThrown', (params) => {
      const exception = params.exceptionDetails;
      const text = exception.exception?.description || exception.text || 'Unknown error';

      this.consoleBuffer.add({
        level: 'error',
        text: `[Exception] ${text}`,
        timestamp: params.timestamp,
        url: exception.url || null
      });
    });

    // Clear console buffer on navigation (main frame only)
    this.cdp.on('Page.frameNavigated', (params) => {
      if (!params.frame.parentId) {
        this.consoleBuffer.clear();
        process.stderr.write(`[Browser] Console buffer cleared (navigation)\n`);
        // WebMCP tools belong to the document that registered them.
        if (this.webmcpTools) this.webmcpTools.clear();
      }
    });
  }

  /**
   * Subscribe to the CDP `WebMCP` tool catalog and (best-effort) enable it.
   * Called from `_connectToPage()` so it covers the initial start, WebSocket
   * reconnect and crash restart — a CDP event subscription survives neither.
   * Missing support is expected (older Chromium, or the feature turned off):
   * we record it and let callers fall back to the in-page document.modelContext
   * API (see src/webmcp.js).
   */
  async _setupWebmcp() {
    this.webmcpTools = new Map();

    if (!isWebmcpEnabled()) {
      this.webmcpAvailable = false;
      return;
    }

    this.cdp.on('WebMCP.toolsAdded', (params) => {
      const tools = params && params.tools;
      if (!Array.isArray(tools)) return;
      for (const tool of tools) {
        if (!tool || !tool.name) continue;
        this.webmcpTools.set(`${tool.frameId || ''}|${tool.name}`, tool);
      }
    });

    this.cdp.on('WebMCP.toolsRemoved', (params) => {
      const tools = params && params.tools;
      if (!Array.isArray(tools)) return;
      for (const tool of tools) {
        if (!tool || !tool.name) continue;
        this.webmcpTools.delete(`${tool.frameId || ''}|${tool.name}`);
      }
    });

    try {
      await this.cdp.send('WebMCP.enable', {}, 5000);
      this.webmcpAvailable = true;
      process.stderr.write('[Browser] WebMCP domain enabled\n');
    } catch (err) {
      this.webmcpAvailable = false;
      process.stderr.write(`[Browser] WebMCP domain unavailable: ${err.message}\n`);
    }
  }

  _setupDialogHandler() {
    // Auto-dismiss JavaScript dialogs (alert/confirm/prompt) so automation
    // never hangs on a modal dialog. This matches Puppeteer/Playwright
    // defaults and keeps Input.dispatchMouseEvent from blocking.
    this.cdp.on('Page.javascriptDialogOpening', (params) => {
      process.stderr.write(`[Browser] Auto-dismissing dialog: ${params.type} \"${params.message}\"\n`);
      this.cdp.send('Page.handleJavaScriptDialog', { accept: false }, 5000).catch(() => {
        // Dialog may already be gone; ignore.
      });
    });
  }

  /**
   * Apply (and remember) a viewport override. Persisted in `this.viewport` so
   * it can be re-applied after a restart/reconnect.
   */
  async applyViewport({ width, height, deviceScaleFactor = 1, mobile = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile
    });
    this.viewport = { width, height, deviceScaleFactor, mobile };
  }

  /** Clear the viewport override and forget it. */
  async clearViewport() {
    await this.send('Emulation.clearDeviceMetricsOverride', {});
    this.viewport = null;
  }

  /**
   * Re-apply the remembered viewport override after the CDP session is
   * (re)established. Called from `_connectToPage()` so it covers the initial
   * start, WebSocket reconnect, and crash restart. Best-effort: a failure is
   * logged, not thrown.
   */
  async _reapplyViewport() {
    if (!this.viewport) return;
    try {
      await this.cdp.send('Emulation.setDeviceMetricsOverride', { ...this.viewport });
      process.stderr.write('[Browser] Re-applied viewport override\n');
    } catch (err) {
      process.stderr.write(`[Browser] Failed to re-apply viewport: ${err.message}\n`);
    }
  }

  /**
   * Register the WebGL shim for documents created from now on, replacing any
   * previous registration so modes never stack. Returns the CDP identifier, or
   * null for mode 'off'.
   *
   * The registration only affects NEW documents: the document that is already
   * loaded keeps whatever it had, so the caller reloads (or navigates) to
   * actually install it.
   */
  async applyWebglShim(mode) {
    if (!SHIM_MODES.includes(mode)) {
      const err = new Error(`Unknown WebGL shim mode: ${mode}`);
      err.code = ERRORS.WEBGL_SHIM_MODE_INVALID;
      throw err;
    }

    // Replace rather than stack: modes never accumulate registrations.
    await this.removeWebglShim();

    if (mode === 'off') return null;

    const { identifier } = await this.send(
      'Page.addScriptToEvaluateOnNewDocument', { source: SHIM_SOURCES[mode] }, 5000
    );
    this.webglShim = { mode, identifier };
    return identifier;
  }

  /**
   * Remove the shim registration and forget it. The current document is
   * unaffected — its mocked context, if any, stays until the next reload.
   */
  async removeWebglShim() {
    if (!this.webglShim) return;
    const { identifier } = this.webglShim;
    this.webglShim = null;
    try {
      await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, 5000);
    } catch {
      // Already gone — the registration does not outlive the CDP session it was
      // created on, so after a reconnect there is nothing left to remove.
    }
  }

  /**
   * Re-register the remembered WebGL shim after the CDP session is
   * (re)established. `Page.addScriptToEvaluateOnNewDocument` registrations live
   * on the session, so both a WebSocket reconnect and a crash restart begin
   * without one. Same lifecycle concern as the viewport override. Best-effort:
   * a failure is logged, not thrown.
   */
  async _reapplyWebglShim() {
    if (!this.webglShim) return;
    const mode = this.webglShim.mode;
    try {
      const { identifier } = await this.cdp.send(
        'Page.addScriptToEvaluateOnNewDocument', { source: SHIM_SOURCES[mode] }, 5000
      );
      this.webglShim = { mode, identifier };
      process.stderr.write(`[Browser] Re-applied WebGL shim (mode=${mode})\n`);
    } catch (err) {
      process.stderr.write(`[Browser] Failed to re-apply WebGL shim: ${err.message}\n`);
    }
  }

  /**
   * Reconnect to the same Chromium process after a WebSocket drop, using
   * exponential backoff (100ms, 200ms, 400ms, ...). The Chromium process and
   * its profile are untouched — only the CDP connection is re-established.
   */
  async _reconnect() {
    if (this.state !== STATES.RECONNECTING) return;

    this.reconnectAttempts++;
    process.stderr.write(`[Browser] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n`);

    // Close the stale CDP client (rejects its pending requests).
    if (this.cdp) {
      try { await this.cdp.close(); } catch { /* already closed */ }
    }

    const delay = Math.min(100 * 2 ** (this.reconnectAttempts - 1), 5000);
    await sleep(delay);

    if (this.state !== STATES.RECONNECTING) return; // superseded (e.g. crash restart)

    try {
      await this._connectToPage();
      if (this.state !== STATES.RECONNECTING) return;
      this.state = STATES.READY;
      this.reconnectAttempts = 0;
      process.stderr.write(`[Browser] Reconnected to Chromium (port ${this.port})\n`);
    } catch (err) {
      if (this.state !== STATES.RECONNECTING) return;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        const fail = new Error(
          `Reconnection failed after ${this.maxReconnectAttempts} attempts: ${err.message}`
        );
        fail.code = ERRORS.CDP_ERROR;
        fail.stderrLines = this.lastStderr;
        this.state = STATES.FAILED;
        this.failureReason = fail;
        throw fail;
      }
      await this._reconnect();
    }
  }

  async _handleCrash() {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      this.state = STATES.FAILED;
      const err = new Error(
        `Chromium restart failed after ${this.maxRestartAttempts} attempts`
      );
      err.code = ERRORS.CHROMIUM_RESTART_FAILED;
      err.stderrLines = this.lastStderr;
      this.failureReason = err;
      process.stderr.write(`[Browser] Max restart attempts reached\n${this.lastStderr}\n`);
      return;
    }

    this.restartAttempts++;
    process.stderr.write(`[Browser] Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts}\n`);

    try {
      // Preserve the profile so the page's stored state survives the restart.
      await this.cleanup({ removeProfile: false });
      await this.start({ preserveProfile: true });
      this.sessionReset = true;
    } catch (err) {
      this.state = STATES.FAILED;
      const fail = new Error(`Chromium restart failed: ${err.message}`);
      fail.code = ERRORS.CHROMIUM_RESTART_FAILED;
      fail.stderrLines = this.lastStderr;
      this.failureReason = fail;
      process.stderr.write(`[Browser] Restart failed: ${err.message}\n`);
    }
  }

  async send(method, params = {}, timeoutMs) {
    if (this.state === STATES.FAILED) {
      const reason = this.failureReason?.message || 'browser failed';
      const err = new Error(`[${this.failureReason?.code || ERRORS.BROWSER_CRASHED}] ${reason}`);
      if (this.failureReason?.stderrLines) {
        err.message += `\nLast Chromium stderr:\n${this.failureReason.stderrLines}`;
      }
      throw err;
    }
    if (this.state !== STATES.READY) {
      throw new Error(`Browser not ready: state=${this.state}`);
    }
    return this.cdp.send(method, params, timeoutMs);
  }

  /**
   * Kill Chromium child processes that still reference this profile dir.
   * Chromium spawns gpu/renderer/network children carrying
   * --user-data-dir=<profile> in their cmdline; if the main process dies
   * first they can outlive it and recreate the profile directory after it was
   * removed. Scanning /proc lets cleanup kill them before removing the dir.
   */
  _killChildrenByProfile(profileDir) {
    let killed = 0;
    try {
      for (const entry of readdirSync('/proc')) {
        const pid = Number(entry);
        if (!pid || pid === process.pid) continue;
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (cmdline.includes(profileDir)) {
            try {
              process.kill(pid, 'SIGKILL');
              killed++;
            } catch {
              // Already gone
            }
          }
        } catch {
          // Process exited between scan and read
        }
      }
    } catch {
      // /proc unavailable
    }
    if (killed > 0) {
      process.stderr.write(`[Browser] Killed ${killed} Chromium child process(es) for profile cleanup\n`);
    }
  }

  async cleanup({ removeProfile = true } = {}) {
    if (this._cleanupDone) return;
    this._cleanupDone = true;

    this.state = STATES.STOPPING;

    if (this.cdp) {
      try {
        await this.cdp.close();
      } catch {
        // Ignore close errors
      }
      this.cdp = null;
    }

    if (this.process && this.pid) {
      try {
        process.kill(this.pid, 'SIGTERM');

        const waitPromise = new Promise(resolve => {
          this.process.once('exit', resolve);
        });

        const timeoutPromise = new Promise(resolve => setTimeout(resolve, 5000));

        await Promise.race([waitPromise, timeoutPromise]);

        if (this.process.exitCode === null) {
          process.stderr.write(`[Browser] Force killing Chromium\n`);
          try {
            process.kill(this.pid, 'SIGKILL');
          } catch {
            // Process may have already exited
          }
        }
      } catch {
        // Process may have already exited
      }
      this.process = null;
      this.pid = null;
    }

    if (this.profileDir) {
      // Chromium children may survive the main process and recreate or hold the
      // profile dir; reap them either way before touching the directory.
      const profile = this.profileDir;
      this._killChildrenByProfile(profile);

      if (removeProfile) {
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            rmSync(profile, { recursive: true, force: true });
            process.stderr.write(`[Browser] Cleaned up profile: ${profile}\n`);
            break;
          } catch {
            this._killChildrenByProfile(profile);
            await sleep(250);
          }
        }
        this.profileDir = null;
      } else {
        process.stderr.write(`[Browser] Keeping profile for restart: ${profile}\n`);
      }
    }

    this.port = null;
    this.state = STATES.STOPPED;
    process.stderr.write(`[Browser] Cleanup complete\n`);
  }

  /**
   * Whether a crash restart happened since the last check. Reading clears the
   * flag, so only the first tool call after a restart reports the reset.
   */
  consumeSessionReset() {
    const reset = this.sessionReset;
    this.sessionReset = false;
    return reset;
  }

  get isReady() {
    return this.state === STATES.READY && this.cdp && this.cdp.isConnected;
  }

  get lastStderr() {
    return this.stderrLines.slice(-20).join('\n');
  }
}

export default Browser;
