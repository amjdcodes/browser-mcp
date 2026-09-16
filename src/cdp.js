import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { capTimeout, CONFIG } from './utils.js';

export class CDPClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ws = null;
    this.url = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.defaultTimeout = options.defaultTimeout || CONFIG.DEFAULT_TIMEOUT_MS;
  }

  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        return reject(new Error('Already connected'));
      }

      this.url = wsUrl;
      this.nextId = 1;

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        return reject(err);
      }

      const onOpen = () => {
        this.connected = true;
        this.ws.removeListener('error', onError);
        resolve();
      };

      const onError = (err) => {
        this.ws.removeListener('open', onOpen);
        reject(err);
      };

      this.ws.once('open', onOpen);
      this.ws.once('error', onError);

      this.ws.on('message', (data) => this._handleMessage(data));
      this.ws.on('close', () => this._handleClose());
      this.ws.on('error', (err) => this._handleError(err));
    });
  }

  _handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      process.stderr.write(`[CDP] Failed to parse message: ${data}\n`);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);

        if (message.error) {
          pending.reject(new Error(`CDP Error: ${message.error.message} (${message.error.code})`));
        } else {
          pending.resolve(message.result);
        }
      } else {
        process.stderr.write(`[CDP] Late response for id ${message.id}, ignoring\n`);
      }
    } else if (message.method) {
      this.emit(message.method, message.params);
    }
  }

  _handleClose() {
    this.connected = false;
    this._rejectAllPending('WebSocket closed');
    this.emit('close');
  }

  _handleError(err) {
    process.stderr.write(`[CDP] WebSocket error: ${err.message}\n`);
    this.emit('error', err);
  }

  _rejectAllPending(reason) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }

      const id = this.nextId++;
      const timeout = capTimeout(timeoutMs, this.defaultTimeout);

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method} exceeded ${timeout}ms`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer, method });

      const message = JSON.stringify({ id, method, params });

      try {
        this.ws.send(message, (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws) {
        return resolve();
      }

      this._rejectAllPending('Connection closed');

      if (this.ws.readyState === WebSocket.CLOSED) {
        this.ws = null;
        this.connected = false;
        return resolve();
      }

      this.ws.once('close', () => {
        this.ws = null;
        this.connected = false;
        resolve();
      });

      try {
        this.ws.close();
      } catch {
        this.ws = null;
        this.connected = false;
        resolve();
      }
    });
  }

  get isConnected() {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get pendingCount() {
    return this.pending.size;
  }
}

export default CDPClient;
