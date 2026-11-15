'use strict';
/**
 * Minimal Lutron LEAP client (HomeWorks QSX / RadioRA 3 / Athena processors).
 *
 * LEAP runs over TLS on TCP 8081. Messages are single-line JSON objects
 * terminated by CRLF. Requests carry a ClientTag; the processor echoes it on
 * the response. Subscriptions keep receiving messages with the same tag.
 */
const tls = require('tls');
const crypto = require('crypto');
const EventEmitter = require('events');

class LeapError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'LeapError';
    this.status = status;
    this.body = body;
  }
}

class LeapClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.host  processor IP / hostname
   * @param {number} [o.port=8081]
   * @param {string} o.key   client private key (PEM) from pairing
   * @param {string} o.cert  client certificate (PEM) from pairing
   * @param {string|string[]} o.ca  CA certificate(s) (PEM) from pairing
   * @param {number} [o.timeout=10000] request timeout in ms
   */
  constructor(o) {
    super();
    this.host = o.host;
    this.port = o.port || 8081;
    this.key = o.key;
    this.cert = o.cert;
    this.ca = o.ca;
    this.timeout = o.timeout || 10000;
    this.socket = null;
    this.pending = new Map();
    this.subs = new Map();
    this.buffer = '';
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => {
        done(new Error('Timed out connecting to ' + this.host + ':' + this.port));
        if (this.socket) this.socket.destroy();
      }, this.timeout);

      this.socket = tls.connect({
        host: this.host,
        port: this.port,
        key: this.key,
        cert: this.cert,
        ca: this.ca,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        // Lutron processors present a certificate that is not issued for their
        // IP address, so only the chain is verified, not the host name.
        checkServerIdentity: () => undefined
      });
      this.socket.setEncoding('utf8');
      this.socket.setKeepAlive(true, 30000);
      this.socket.on('secureConnect', () => {
        this.connected = true;
        done();
        this.emit('connect');
      });
      this.socket.on('data', (chunk) => this._onData(chunk));
      this.socket.on('error', (err) => {
        done(err);
        this.emit('error', err);
      });
      this.socket.on('close', () => {
        const was = this.connected;
        this.connected = false;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); }
        this.pending.clear();
        this.subs.clear();
        done(new Error('Connection closed'));
        if (was) this.emit('close');
      });
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.search(/\r?\n/)) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + (this.buffer[idx] === '\r' ? 2 : 1));
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { this.emit('parseError', line); continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    const tag = msg.Header && msg.Header.ClientTag;
    if (tag && this.pending.has(tag)) {
      const p = this.pending.get(tag);
      this.pending.delete(tag);
      clearTimeout(p.timer);
      const status = String((msg.Header && msg.Header.StatusCode) || '');
      if (/^[45]\d\d/.test(status) || msg.CommuniqueType === 'ExceptionResponse') {
        const m = (msg.Body && msg.Body.Message) || status || 'LEAP error';
        p.reject(new LeapError(m, status, msg.Body));
      } else {
        p.resolve(msg);
      }
      if (p.subscribe) this.subs.set(tag, p.subscribe);
      return;
    }
    if (tag && this.subs.has(tag)) {
      try { this.subs.get(tag)(msg); } catch (e) { this.emit('error', e); }
      return;
    }
    this.emit('unsolicited', msg);
  }

  _send(type, url, body, subscribe) {
    if (!this.socket || !this.connected) return Promise.reject(new Error('Not connected'));
    const tag = crypto.randomUUID();
    const msg = { CommuniqueType: type, Header: { ClientTag: tag, Url: url } };
    if (body !== undefined) msg.Body = body;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tag);
        reject(new Error('No answer from processor for ' + url));
      }, this.timeout);
      this.pending.set(tag, { resolve, reject, timer, subscribe });
      this.socket.write(JSON.stringify(msg) + '\r\n');
    });
  }

  read(url) { return this._send('ReadRequest', url); }
  create(url, body) { return this._send('CreateRequest', url, body); }
  update(url, body) { return this._send('UpdateRequest', url, body); }
  subscribe(url, onMessage) { return this._send('SubscribeRequest', url, undefined, onMessage); }

  async ping() {
    const t0 = Date.now();
    const r = await this.read('/server/1/status/ping');
    return { latencyMs: Date.now() - t0, leapVersion: r.Body && r.Body.PingResponse && r.Body.PingResponse.LEAPVersion };
  }

  close() {
    if (this.socket) { this.socket.end(); this.socket.destroy(); }
    this.connected = false;
  }
}

/** "00:00:02" style duration used by LEAP for fade times. */
function leapDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}

/** "/zone/123" -> "123" */
function idFromHref(href) {
  const m = /\/(\d+)(?:\/|$)/.exec(String(href || '').replace(/\/(status|commandprocessor)$/, ''));
  return m ? m[1] : String(href || '').split('/').filter(Boolean).pop();
}

module.exports = { LeapClient, LeapError, leapDuration, idFromHref };
