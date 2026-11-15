'use strict';
/**
 * Connection manager for one Lutron HomeWorks QSX processor over LEAP.
 * Keeps the connection open, reconnects, pings, discovers zones and
 * virtual buttons, follows zone status, and sends level commands.
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { LeapClient, leapDuration, idFromHref } = require('./leap');
const { pair } = require('./pair');

const PING_MS = 60000;

class Lutron extends EventEmitter {
  constructor({ dataDir, settings }) {
    super();
    this.dir = path.join(dataDir, 'lutron');
    fs.mkdirSync(this.dir, { recursive: true });
    this.settings = Object.assign({ host: '', port: 8081, pairPort: 8083, fadeSeconds: 2, enabled: true }, settings || {});
    this.client = null;
    this.state = 'idle';           // idle | unpaired | connecting | connected | error | disabled
    this.lastError = '';
    this.leapVersion = '';
    this.project = null;
    this.latencyMs = null;
    this.lastPingAt = null;
    this.zoneLevels = {};          // zoneId -> level 0..100 as reported by the processor
    this.discovery = this._readJson('discovery.json') || { zones: [], buttons: [], readAt: null };
    this.pairing = { stage: 'idle', error: '', startedAt: null };
    this._retry = null;
    this._pingTimer = null;
    this._backoff = 2000;
  }

  // ---------- files ----------
  _file(n) { return path.join(this.dir, n); }
  _readJson(n) { try { return JSON.parse(fs.readFileSync(this._file(n), 'utf8')); } catch (e) { return null; } }
  _writeJson(n, v) { const f = this._file(n); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); }
  _readPem(n) { try { return fs.readFileSync(this._file(n), 'utf8'); } catch (e) { return null; } }
  credentials() {
    const key = this._readPem('client.key'), cert = this._readPem('client.crt'), ca = this._readPem('processor-ca.crt');
    return key && cert && ca ? { key, cert, ca } : null;
  }
  lapCertificates() {
    const ca = this._readPem('lap-ca.pem'), cert = this._readPem('lap-cert.pem'), key = this._readPem('lap-key.pem'), root = this._readPem('lutron-root-ca.pem');
    return ca && cert && key && root ? { ca, cert, key, root } : null;
  }

  status() {
    return {
      state: this.state,
      host: this.settings.host,
      port: this.settings.port,
      fadeSeconds: this.settings.fadeSeconds,
      enabled: this.settings.enabled,
      paired: !!this.credentials(),
      pairedHost: (this._readJson('pairing.json') || {}).host || '',
      lapReady: !!this.lapCertificates(),
      leapVersion: this.leapVersion,
      project: this.project,
      latencyMs: this.latencyMs,
      lastPingAt: this.lastPingAt,
      lastError: this.lastError,
      pairing: this.pairing,
      discovery: { zones: this.discovery.zones.length, buttons: this.discovery.buttons.length, readAt: this.discovery.readAt }
    };
  }

  _set(state, err) {
    this.state = state;
    if (err !== undefined) this.lastError = err ? String(err.message || err) : '';
    this.emit('status', this.status());
  }

  // ---------- lifecycle ----------
  applySettings(s) {
    const prevHost = this.settings.host, prevPort = this.settings.port;
    this.settings = Object.assign(this.settings, s);
    if (prevHost !== this.settings.host || prevPort !== this.settings.port || s.enabled !== undefined) this.restart();
    else this.emit('status', this.status());
  }

  start() {
    clearTimeout(this._retry);
    if (!this.settings.enabled) return this._set('disabled', '');
    if (!this.settings.host) return this._set('idle', '');
    const creds = this.credentials();
    if (!creds) return this._set('unpaired', '');
    this._connect(creds);
  }

  restart() { this.stop(); this.start(); }

  stop() {
    clearTimeout(this._retry);
    clearInterval(this._pingTimer);
    if (this.client) { this.client.removeAllListeners(); this.client.on('error', () => {}); this.client.close(); this.client = null; }
  }

  async _connect(creds) {
    this._set('connecting');
    const client = new LeapClient({ host: this.settings.host, port: this.settings.port, key: creds.key, cert: creds.cert, ca: creds.ca });
    client.on('error', () => {});
    client.on('close', () => {
      if (this.client !== client) return;
      clearInterval(this._pingTimer);
      this.client = null;
      this._set('error', 'Connection to the processor was lost');
      this._scheduleRetry();
    });
    client.on('unsolicited', (m) => this._onMessage(m));
    try {
      await client.connect();
      this.client = client;
      const p = await client.ping();
      this.leapVersion = p.leapVersion || '';
      this.latencyMs = p.latencyMs;
      this.lastPingAt = new Date().toISOString();
      try { const pr = await client.read('/project'); this.project = summariseProject(pr.Body && pr.Body.Project); } catch (e) { /* optional */ }
      try {
        const sub = await client.subscribe('/zone/status', (m) => this._onMessage(m));
        this._onMessage(sub);
      } catch (e) { /* older firmware: fall back to unsolicited updates */ }
      this._backoff = 2000;
      this._set('connected', '');
      this._pingTimer = setInterval(() => this._ping(), PING_MS);
    } catch (err) {
      client.removeAllListeners(); client.on('error', () => {}); client.close();
      if (this.client === client) this.client = null;
      this._set('error', friendly(err));
      this._scheduleRetry();
    }
  }

  _scheduleRetry() {
    clearTimeout(this._retry);
    if (!this.settings.enabled || !this.credentials()) return;
    this._retry = setTimeout(() => this.start(), this._backoff);
    this._backoff = Math.min(this._backoff * 2, 60000);
  }

  async _ping() {
    if (!this.client) return;
    try {
      const p = await this.client.ping();
      this.latencyMs = p.latencyMs; this.lastPingAt = new Date().toISOString();
      this.emit('status', this.status());
    } catch (e) {
      if (this.client) this.client.close();
    }
  }

  _onMessage(msg) {
    const body = msg && msg.Body;
    if (!body) return;
    const list = body.ZoneStatuses || (body.ZoneStatus ? [body.ZoneStatus] : []);
    const changed = {};
    list.forEach((zs) => {
      if (!zs || !zs.Zone) return;
      const id = idFromHref(zs.Zone.href);
      let level = zs.Level;
      if (zs.CCOLevel !== undefined) level = zs.CCOLevel === 'Closed' ? 100 : 0;
      if (typeof level !== 'number' || level < 0) return;
      this.zoneLevels[id] = Math.round(level);
      changed[id] = this.zoneLevels[id];
    });
    if (Object.keys(changed).length) this.emit('zones', changed);
  }

  // ---------- admin actions ----------
  /** Opens a separate short connection and reports what the processor says. */
  async test() {
    if (!this.settings.host) throw new Error('Enter the processor IP address first');
    const creds = this.credentials();
    if (!creds) throw new Error('Not paired yet. Pair with the processor first');
    const client = new LeapClient({ host: this.settings.host, port: this.settings.port, key: creds.key, cert: creds.cert, ca: creds.ca, timeout: 8000 });
    client.on('error', () => {});
    const t0 = Date.now();
    try {
      await client.connect();
      const connectMs = Date.now() - t0;
      const ping = await client.ping();
      let project = null, processor = null;
      try { const pr = await client.read('/project'); project = summariseProject(pr.Body && pr.Body.Project); } catch (e) {}
      try {
        const d = await client.read('/device?where=IsThisDevice:true');
        const dev = d.Body && d.Body.Devices && d.Body.Devices[0];
        if (dev) processor = { name: dev.Name, model: dev.ModelNumber, serial: dev.SerialNumber, type: dev.DeviceType };
      } catch (e) {}
      this.leapVersion = ping.leapVersion || this.leapVersion;
      this.latencyMs = ping.latencyMs;
      this.lastPingAt = new Date().toISOString();
      if (project) this.project = project;
      this.emit('status', this.status());
      return { ok: true, connectMs, latencyMs: ping.latencyMs, leapVersion: ping.leapVersion, project, processor };
    } catch (err) {
      throw new Error(friendly(err));
    } finally {
      client.close();
    }
  }

  /** Reads areas, zones and virtual buttons (Lutron-side scenes) from the processor. */
  async discover() {
    const c = this._requireClient();
    const areasRes = await c.read('/area');
    const areas = (areasRes.Body && areasRes.Body.Areas) || [];
    const byId = {};
    areas.forEach((a) => { byId[idFromHref(a.href)] = { name: a.Name, parent: a.Parent ? idFromHref(a.Parent.href) : null }; });
    const areaPath = (id) => {
      const names = []; let cur = id, guard = 0;
      while (cur && byId[cur] && guard++ < 20) { names.unshift(byId[cur].name); cur = byId[cur].parent; }
      return names.length > 1 ? names.slice(1).join(' / ') : names.join(' / ');
    };
    const zones = [];
    for (const a of areas) {
      const aid = idFromHref(a.href);
      let res;
      try { res = await c.read('/area/' + aid + '/associatedzone'); } catch (e) { continue; }
      ((res.Body && res.Body.Zones) || []).forEach((z) => {
        zones.push({ id: idFromHref(z.href), name: z.Name, area: areaPath(aid), controlType: z.ControlType || '' });
        if (typeof z.Level === 'number' && z.Level >= 0) this.zoneLevels[idFromHref(z.href)] = Math.round(z.Level);
      });
    }
    let buttons = [];
    try {
      const vb = await c.read('/virtualbutton');
      buttons = ((vb.Body && vb.Body.VirtualButtons) || [])
        .filter((b) => b.IsProgrammed !== false)
        .map((b) => ({ id: idFromHref(b.href), name: b.Name || ('Button ' + idFromHref(b.href)) }));
    } catch (e) { /* not every system exposes virtual buttons */ }
    zones.sort((x, y) => (x.area + x.name).localeCompare(y.area + y.name));
    this.discovery = { zones, buttons, readAt: new Date().toISOString() };
    this._writeJson('discovery.json', this.discovery);
    this.emit('status', this.status());
    return this.discovery;
  }

  async setZoneLevel(zoneId, level, fadeSeconds) {
    const c = this._requireClient();
    const z = this.discovery.zones.find((x) => x.id === String(zoneId));
    const fade = fadeSeconds === undefined ? this.settings.fadeSeconds : fadeSeconds;
    const lvl = Math.max(0, Math.min(100, Math.round(level)));
    const url = '/zone/' + zoneId + '/commandprocessor';
    const dimmed = !z || !z.controlType || /dim/i.test(z.controlType);
    if (dimmed) {
      try {
        return await c.create(url, { Command: { CommandType: 'GoToDimmedLevel', DimmedLevelParameters: { Level: lvl, FadeTime: leapDuration(fade) } } });
      } catch (e) {
        if (z && z.controlType) throw e; // known dimmed zone: report the real error
      }
    }
    return c.create(url, { Command: { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: lvl }] } });
  }

  async pressButton(buttonId) {
    const c = this._requireClient();
    return c.create('/virtualbutton/' + buttonId + '/commandprocessor', { Command: { CommandType: 'PressAndRelease' } });
  }

  isConnected() { return !!(this.client && this.client.connected && this.state === 'connected'); }

  _requireClient() {
    if (!this.isConnected()) throw new Error('Not connected to the processor');
    return this.client;
  }

  startPairing() {
    if (this.pairing.stage === 'waiting-button' || this.pairing.stage === 'generating-key' || this.pairing.stage === 'signing' || this.pairing.stage === 'verifying') {
      throw new Error('Pairing is already running');
    }
    if (!this.settings.host) throw new Error('Enter the processor IP address first');
    const lap = this.lapCertificates();
    if (!lap) throw new Error('The LAP pairing certificates are missing. Run "npm run fetch-certs" on the server once (needs internet)');
    this.pairing = { stage: 'connecting', error: '', startedAt: new Date().toISOString() };
    this.emit('status', this.status());
    const host = this.settings.host;
    pair({
      host, lap, pairPort: this.settings.pairPort, leapPort: this.settings.port, displayName: 'wave-lighting',
      onStatus: (stage) => { this.pairing.stage = stage; this.emit('status', this.status()); }
    }).then((res) => {
      fs.writeFileSync(this._file('client.key'), res.key, { mode: 0o600 });
      fs.writeFileSync(this._file('client.crt'), res.cert);
      fs.writeFileSync(this._file('processor-ca.crt'), res.ca);
      this._writeJson('pairing.json', { host, pairedAt: new Date().toISOString(), leapVersion: res.leapVersion });
      this.pairing = { stage: 'done', error: '', startedAt: this.pairing.startedAt };
      this.restart();
    }).catch((err) => {
      this.pairing = { stage: 'failed', error: friendly(err), startedAt: this.pairing.startedAt };
      this.emit('status', this.status());
    });
  }

  unpair() {
    this.stop();
    ['client.key', 'client.crt', 'processor-ca.crt', 'pairing.json'].forEach((n) => { try { fs.unlinkSync(this._file(n)); } catch (e) {} });
    this.pairing = { stage: 'idle', error: '', startedAt: null };
    this.leapVersion = ''; this.project = null; this.latencyMs = null;
    this.start();
  }
}

function summariseProject(p) {
  if (!p) return null;
  return {
    name: p.Name || '',
    productType: p.ProductType || '',
    masterDevices: Array.isArray(p.MasterDeviceList && p.MasterDeviceList.Devices) ? p.MasterDeviceList.Devices.length : undefined
  };
}

function friendly(err) {
  const code = err && err.code;
  const map = {
    ECONNREFUSED: 'The processor refused the connection. Check the IP address and that LEAP is reachable on this port',
    EHOSTUNREACH: 'The processor cannot be reached from this server. Check the network and IP address',
    ENETUNREACH: 'This server has no route to that network',
    ETIMEDOUT: 'Timed out talking to the processor',
    ECONNRESET: 'The processor closed the connection. It may not trust this server: pair again',
    CERT_HAS_EXPIRED: 'The processor certificate has expired',
    CERT_SIGNATURE_FAILURE: 'The processor no longer matches the saved pairing (replaced or reset?). Pair again',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The processor no longer matches the saved pairing (replaced or reset?). Pair again',
    SELF_SIGNED_CERT_IN_CHAIN: 'The processor no longer matches the saved pairing (replaced or reset?). Pair again',
    EPROTO: 'Secure connection failed. Check the port number (LEAP uses 8081)',
    CONNECT_TIMEOUT: 'Could not reach the processor',
    BUTTON_TIMEOUT: 'The Access button was not pressed within 3 minutes'
  };
  if (code && map[code]) return map[code];
  return (err && err.message) || String(err);
}

module.exports = { Lutron };
