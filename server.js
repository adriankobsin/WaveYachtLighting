'use strict';
/**
 * Wave AVI – exterior lighting control server.
 * Serves the touch-panel web app on the local network and talks to the
 * Lutron HomeWorks QSX processor over LEAP.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Auth, hashPassword } = require('./lib/auth');
const { Lutron } = require('./lib/lutron');

const ROOT = __dirname;
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });

// ---------- storage ----------
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file); }
const F = {
  config: path.join(DATA, 'config.json'),
  settings: path.join(DATA, 'settings.json'),
  admin: path.join(DATA, 'admin.json')
};
for (const name of ['config', 'admin']) {
  if (!fs.existsSync(F[name]) && fs.existsSync(path.join(ROOT, 'defaults', name + '.json'))) {
    fs.copyFileSync(path.join(ROOT, 'defaults', name + '.json'), F[name]);
  }
}
if (!fs.existsSync(F.admin) && process.env.ADMIN_PASSWORD) writeJson(F.admin, hashPassword(process.env.ADMIN_PASSWORD));

let config = readJson(F.config, { decks: [], scenes: [] });
let settings = readJson(F.settings, { lutron: {} });
const auth = new Auth(F.admin);
const lutron = new Lutron({ dataDir: DATA, settings: settings.lutron });

// ---------- live lighting state ----------
let levels = {};          // circuitId -> { on, level }
let sceneBy = {};         // 'all' | deckId -> sceneId
let zoneToCircuits = {};  // zoneId -> [circuitId]
const quietUntil = {};    // circuitId -> ms; ignore processor echoes while our own fade runs

function circuits() {
  const seen = {}, out = [];
  (config.decks || []).forEach((d) => (d.circuits || []).forEach((c) => { if (!seen[c.id]) { seen[c.id] = 1; out.push(c); } }));
  return out;
}
function circuitById(id) { return circuits().find((c) => c.id === id); }
function zonesOf(c) {
  const all = [];
  (config.decks || []).forEach((d) => (d.circuits || []).forEach((x) => {
    if (x.id === c.id && x.lutron && Array.isArray(x.lutron.zones)) x.lutron.zones.forEach((z) => { if (all.indexOf(String(z)) < 0) all.push(String(z)); });
  }));
  return all;
}
function rebuildMaps(keepLevels) {
  const next = {};
  circuits().forEach((c) => {
    next[c.id] = keepLevels && levels[c.id] ? levels[c.id] : { on: !!c.on && !c.ni && (c.def || 0) > 0, level: c.def || 50 };
  });
  levels = next;
  zoneToCircuits = {};
  circuits().forEach((c) => zonesOf(c).forEach((z) => { (zoneToCircuits[z] = zoneToCircuits[z] || []).push(c.id); }));
  // Pick up what the processor already reports for mapped zones.
  Object.keys(zoneToCircuits).forEach((z) => { if (lutron.zoneLevels[z] !== undefined) updateFromZones([z]); });
}
rebuildMaps(false);

function updateFromZones(zoneIds) {
  const touched = {};
  zoneIds.forEach((z) => (zoneToCircuits[z] || []).forEach((cid) => { touched[cid] = 1; }));
  let changed = false;
  Object.keys(touched).forEach((cid) => {
    if (quietUntil[cid] && quietUntil[cid] > Date.now()) return;
    const c = circuitById(cid); if (!c) return;
    const known = zonesOf(c).map((z) => lutron.zoneLevels[z]).filter((v) => typeof v === 'number');
    if (!known.length) return;
    const max = Math.max.apply(null, known);
    const prev = levels[cid] || { on: false, level: 50 };
    const next = max > 0 ? { on: true, level: max } : { on: false, level: prev.level };
    if (next.on !== prev.on || next.level !== prev.level) { levels[cid] = next; changed = true; sceneBy = {}; }
  });
  if (changed) broadcastState();
}
lutron.on('zones', (changed) => updateFromZones(Object.keys(changed)));
lutron.on('status', () => broadcast('lutron', publicLutron()));

/** Sends one circuit's state to its Lutron zones. Returns warnings (never throws). */
async function drive(c, st, fadeSeconds) {
  const zones = zonesOf(c);
  if (!zones.length || c.ni || !lutron.isConnected()) return [];
  const fade = fadeSeconds === undefined ? lutron.settings.fadeSeconds : fadeSeconds;
  quietUntil[c.id] = Date.now() + (Number(fade) || 0) * 1000 + 1500;
  const target = st.on ? st.level : 0;
  const warnings = [];
  await Promise.all(zones.map((z) => lutron.setZoneLevel(z, target, fade).catch((e) => { warnings.push(c.label + ' zone ' + z + ': ' + e.message); })));
  return warnings;
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  clients.forEach((res) => res.write(msg));
}
let stateTimer = null;
function broadcastState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => broadcast('state', { levels, sceneBy }), 60);
}
function publicLutron() {
  const s = lutron.status();
  return { state: s.state, connected: s.state === 'connected', host: s.host, paired: s.paired, lastError: s.lastError };
}
setInterval(() => broadcast('ping', Date.now()), 25000);

// ---------- HTTP helpers ----------
function send(res, status, body, headers) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function cookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
function isAdmin(req) { return auth.check(cookie(req, 'wl_session')); }
function clientIp(req) { return (req.socket && req.socket.remoteAddress) || 'unknown'; }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': p === '/index.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- validation ----------
function num(v, lo, hi, d) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; }
function str(v, max) { return String(v == null ? '' : v).slice(0, max); }
function cleanConfig(body) {
  if (!body || !Array.isArray(body.decks) || !Array.isArray(body.scenes)) throw Object.assign(new Error('Layout must have decks and scenes'), { status: 400 });
  const decks = body.decks.slice(0, 20).map((d) => ({
    id: str(d.id, 40), name: str(d.name, 60), fr: str(d.fr, 60), img: str(d.img, 200), r: num(d.r, 0.2, 20, 4), note: str(d.note, 600),
    circuits: (Array.isArray(d.circuits) ? d.circuits : []).slice(0, 200).map((c) => {
      const o = {
        id: str(c.id, 40), label: str(c.label, 12), name: str(c.name, 60), ref: str(c.ref, 80), tag: str(c.tag, 20),
        def: num(c.def, 0, 100, 50), on: !!c.on,
        z: (Array.isArray(c.z) ? c.z : []).slice(0, 40).map((p) => (Array.isArray(p) ? p : []).slice(0, 60).map((q) => [num(q && q[0], 0, 100, 0), num(q && q[1], 0, 100, 0)])),
        lutron: { zones: ((c.lutron && Array.isArray(c.lutron.zones)) ? c.lutron.zones : []).map((z) => str(z, 12).replace(/[^0-9]/g, '')).filter(Boolean).slice(0, 32) }
      };
      if (c.ni) o.ni = true;
      return o;
    })
  }));
  const scenes = body.scenes.slice(0, 50).map((s) => {
    const lv = {};
    Object.keys(s.levels || {}).slice(0, 500).forEach((k) => { const v = num(s.levels[k], -1, 100, 0); lv[str(k, 40)] = v < 0 ? -1 : Math.round(v); });
    const o = { id: str(s.id, 40), name: str(s.name, 40), levels: lv };
    if (s.lutronButton) o.lutronButton = str(s.lutronButton, 12).replace(/[^0-9]/g, '');
    return o;
  });
  return { decks, scenes, updatedAt: new Date().toISOString() };
}

// ---------- routes ----------
async function api(req, res, url) {
  const m = req.method;
  const admin = isAdmin(req);
  const need = () => { if (!admin) throw Object.assign(new Error('Admin login required'), { status: 401 }); };

  if (url === '/api/bootstrap' && m === 'GET') {
    return send(res, 200, { config, levels, sceneBy, admin, lutron: publicLutron(), adminConfigured: auth.configured() });
  }
  if (url === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    res.write('event: state\ndata: ' + JSON.stringify({ levels, sceneBy }) + '\n\n');
    res.write('event: lutron\ndata: ' + JSON.stringify(publicLutron()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url === '/api/circuit' && m === 'POST') {
    const b = await readBody(req, 10000);
    const c = circuitById(str(b.id, 40));
    if (!c || c.ni) throw Object.assign(new Error('Unknown circuit'), { status: 404 });
    const prev = levels[c.id] || { on: false, level: 50 };
    const st = { on: b.on === undefined ? prev.on : !!b.on, level: b.level === undefined ? prev.level : num(b.level, 0, 100, prev.level) };
    if (b.level !== undefined && b.on === undefined) st.on = st.level > 0;
    if (st.on && st.level === 0) st.level = 50;
    levels[c.id] = st; sceneBy = {};
    broadcastState();
    const warnings = await drive(c, st);
    return send(res, 200, { ok: true, warnings });
  }
  if (url === '/api/scene' && m === 'POST') {
    const b = await readBody(req, 10000);
    const sc = (config.scenes || []).find((s) => s.id === b.id);
    if (!sc) throw Object.assign(new Error('Unknown scene'), { status: 404 });
    const scope = str(b.scope || 'all', 40);
    let list;
    if (scope === 'all') list = circuits();
    else { const d = (config.decks || []).find((x) => x.id === scope); if (!d) throw Object.assign(new Error('Unknown deck'), { status: 404 }); list = d.circuits || []; }
    let warnings = [];
    const useButton = scope === 'all' && sc.lutronButton && lutron.isConnected();
    // A level of -1 means "don't change" for that circuit.
    list = list.filter((c) => !c.ni && !((sc.levels || {})[c.id] < 0));
    list.forEach((c) => {
      const v = (sc.levels || {})[c.id] || 0;
      const prev = levels[c.id] || { level: 50 };
      levels[c.id] = v > 0 ? { on: true, level: v } : { on: false, level: prev.level };
    });
    if (scope === 'all') { sceneBy = { all: sc.id }; (config.decks || []).forEach((d) => { sceneBy[d.id] = sc.id; }); }
    else { sceneBy = Object.assign({}, sceneBy, { all: null }); sceneBy[scope] = sc.id; }
    broadcastState();
    if (useButton) {
      await lutron.pressButton(sc.lutronButton).catch((e) => warnings.push('Lutron scene button ' + sc.lutronButton + ': ' + e.message));
    } else {
      const results = await Promise.all(list.map((c) => drive(c, levels[c.id])));
      warnings = [].concat.apply([], results);
    }
    return send(res, 200, { ok: true, warnings });
  }
  if (url === '/api/alloff' && m === 'POST') {
    circuits().forEach((c) => { const p = levels[c.id] || { level: 50 }; levels[c.id] = { on: false, level: p.level }; });
    sceneBy = {};
    broadcastState();
    const results = await Promise.all(circuits().filter((c) => !c.ni).map((c) => drive(c, levels[c.id])));
    return send(res, 200, { ok: true, warnings: [].concat.apply([], results) });
  }
  if (url === '/api/login' && m === 'POST') {
    const b = await readBody(req, 2000);
    if (!auth.configured()) throw Object.assign(new Error('No admin password is set on the server. Run "npm run set-password"'), { status: 503 });
    const token = auth.login(str(b.password, 200), clientIp(req));
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'wl_session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' });
  }
  if (url === '/api/logout' && m === 'POST') {
    auth.logout(cookie(req, 'wl_session'));
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'wl_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  // ----- admin only -----
  if (url === '/api/config' && m === 'PUT') {
    need();
    const next = cleanConfig(await readBody(req, 3 * 1024 * 1024));
    if (fs.existsSync(F.config)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(F.config, path.join(DATA, 'backups', 'config-' + stamp + '.json'));
      const backups = fs.readdirSync(path.join(DATA, 'backups')).filter((f) => f.startsWith('config-')).sort();
      backups.slice(0, Math.max(0, backups.length - 30)).forEach((f) => fs.unlinkSync(path.join(DATA, 'backups', f)));
    }
    writeJson(F.config, next);
    config = next;
    rebuildMaps(true);
    broadcast('config', config);
    broadcastState();
    return send(res, 200, { ok: true, updatedAt: next.updatedAt });
  }
  if (url === '/api/lutron' && m === 'GET') {
    need();
    return send(res, 200, { status: lutron.status(), discovery: lutron.discovery, zoneLevels: lutron.zoneLevels });
  }
  if (url === '/api/lutron/settings' && m === 'PUT') {
    need();
    const b = await readBody(req, 5000);
    const host = str(b.host, 100).trim();
    if (host && !/^[A-Za-z0-9.\-:]+$/.test(host)) throw Object.assign(new Error('Enter a valid IP address or host name'), { status: 400 });
    const next = Object.assign({}, settings.lutron || {}, { host, port: num(b.port, 1, 65535, 8081), fadeSeconds: num(b.fadeSeconds, 0, 3600, 2), enabled: b.enabled !== false });
    settings.lutron = next;
    writeJson(F.settings, settings);
    lutron.applySettings(next);
    return send(res, 200, { ok: true, status: lutron.status() });
  }
  if (url === '/api/lutron/test' && m === 'POST') {
    need();
    try { return send(res, 200, await lutron.test()); } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }
  if (url === '/api/lutron/pair' && m === 'POST') { need(); lutron.startPairing(); return send(res, 200, { ok: true, status: lutron.status() }); }
  if (url === '/api/lutron/unpair' && m === 'POST') { need(); lutron.unpair(); return send(res, 200, { ok: true, status: lutron.status() }); }
  if (url === '/api/lutron/reconnect' && m === 'POST') { need(); lutron.restart(); return send(res, 200, { ok: true }); }
  if (url === '/api/lutron/discover' && m === 'POST') {
    need();
    const d = await lutron.discover();
    rebuildMaps(true);
    return send(res, 200, { ok: true, discovery: d, zoneLevels: lutron.zoneLevels });
  }
  if (url === '/api/lutron/zone-test' && m === 'POST') {
    need();
    const b = await readBody(req, 5000);
    const zones = (Array.isArray(b.zones) ? b.zones : []).map((z) => str(z, 12).replace(/[^0-9]/g, '')).filter(Boolean).slice(0, 32);
    if (!zones.length) throw Object.assign(new Error('Enter at least one zone ID'), { status: 400 });
    const level = num(b.level, 0, 100, 100);
    const results = await Promise.all(zones.map((z) => lutron.setZoneLevel(z, level, 0).then(() => ({ zone: z, ok: true })).catch((e) => ({ zone: z, ok: false, error: e.message }))));
    return send(res, 200, { ok: results.every((r) => r.ok), results });
  }
  if (url === '/api/lutron/button-test' && m === 'POST') {
    need();
    const b = await readBody(req, 2000);
    const id = str(b.id, 12).replace(/[^0-9]/g, '');
    if (!id) throw Object.assign(new Error('Enter a button ID'), { status: 400 });
    await lutron.pressButton(id);
    return send(res, 200, { ok: true });
  }
  throw Object.assign(new Error('Not found'), { status: 404 });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    api(req, res, url).catch((err) => {
      if (res.headersSent) return res.end();
      send(res, err.status || 500, { ok: false, error: err.message || 'Server error' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log('Wave lighting control running on http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  if (!auth.configured()) console.warn('No admin password set. Run "npm run set-password" to create one.');
  lutron.start();
});

function shutdown() { lutron.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
