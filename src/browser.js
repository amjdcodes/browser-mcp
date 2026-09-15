import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CDPClient } from './cdp.js';
import { ConsoleBuffer } from './console-buffer.js';
import { ERRORS, formatMCPError } from './utils.js';

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

  getChromiumVersion(execPath) {
    try {
      const { execSync } = require('node:child_process');
      const output = execSync(`${execPath} --version`, { encoding: 'utf8' });
      return output.trim();
    } catch {
      return 'unknown';
    }
  }

  async start() {
    if (this.state !== STATES.STOPPED && this.state !== STATES.FAILED) {
      throw new Error(`Cannot start: state is ${this.state}`);
    }

    this.state = STATES.STARTING;
    this.stderrLines = [];
    this.failureReason = null;
    this._cleanupDone = false;

    const execPath = this.findChromiumPath();
    process.stderr.write(`[Browser] Found Chromium at: ${execPath}\n`);

    this.profileDir = mkdtempSync(join(tmpdir(), 'browser-mcp-'));
    process.stderr.write(`[Browser] Profile dir: ${this.profileDir}\n`);

    const args = [
      ...DEFAULT_FLAGS,
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
      }
    });
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
      await this.cleanup();
      await this.start();
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

  async cleanup() {
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
      // Chromium children may survive the main process and recreate the
      // profile dir; kill them first, then remove with retries (a child
      // finishing its exit can hold the directory for a few hundred ms).
      const profile = this.profileDir;
      this._killChildrenByProfile(profile);
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
    }

    this.port = null;
    this.state = STATES.STOPPED;
    process.stderr.write(`[Browser] Cleanup complete\n`);
  }

  get isReady() {
    return this.state === STATES.READY && this.cdp && this.cdp.isConnected;
  }

  get lastStderr() {
    return this.stderrLines.slice(-20).join('\n');
  }
}

export default Browser;
