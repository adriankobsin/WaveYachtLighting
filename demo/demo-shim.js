/* Browser demo: stands in for the mini-PC server and a HomeWorks QSX processor.
   The real app code is unchanged; fetch('/api/…') and EventSource('/api/events')
   are answered here. The layout is saved in the artifact's shared store. */
(function () {
  'use strict';
  var PASS_HASH = 'b962512ccc59d87393f9d996dd268c8ce68a1187e8bb60e63f9a098e976d0748';
  var realFetch = window.fetch.bind(window);
  var db = null, docRef = null;
  var config = null, levels = {}, sceneBy = {}, admin = false, me = null;
  var listeners = [];
  var proc = { online: true, accessPressed: false, zoneLevels: {} };
  var lx = {
    settings: { host: '', port: 8081, fadeSeconds: 2, enabled: true },
    paired: false, pairedHost: '', connected: false, state: 'idle', lastError: '', leapVersion: '', project: null,
    latencyMs: null, lastPingAt: null, pairing: { stage: 'idle', error: '', startedAt: null },
    discovery: { zones: [], buttons: [], readAt: null }
  };
  try { var saved = JSON.parse(localStorage.getItem('wl-demo-lutron') || 'null'); if (saved) { lx.settings = saved.settings; lx.paired = saved.paired; lx.pairedHost = saved.pairedHost; lx.discovery = saved.discovery || lx.discovery; } } catch (e) {}
  function persistLx() { try { localStorage.setItem('wl-demo-lutron', JSON.stringify({ settings: lx.settings, paired: lx.paired, pairedHost: lx.pairedHost, discovery: lx.discovery })); } catch (e) {} }

  function emit(ev, data) { listeners.forEach(function (l) { if (l.ev === ev) { try { l.fn({ data: JSON.stringify(data) }); } catch (e) {} } }); }
  function pub() { return { state: lx.state, connected: lx.state === 'connected', host: lx.settings.host, paired: lx.paired, lastError: lx.lastError }; }
  function full() {
    return { state: lx.state, host: lx.settings.host, port: lx.settings.port, fadeSeconds: lx.settings.fadeSeconds, enabled: lx.settings.enabled, paired: lx.paired, pairedHost: lx.pairedHost, lapReady: true,
      leapVersion: lx.leapVersion, project: lx.project, latencyMs: lx.latencyMs, lastPingAt: lx.lastPingAt, lastError: lx.lastError, pairing: lx.pairing,
      discovery: { zones: lx.discovery.zones.length, buttons: lx.discovery.buttons.length, readAt: lx.discovery.readAt } };
  }
  function setState(s, err) { lx.state = s; if (err !== undefined) lx.lastError = err; emit('lutron', pub()); renderPanel(); }
  function validIp(h) { return /^(\d{1,3}\.){3}\d{1,3}$/.test(h) && h.split('.').every(function (n) { return +n <= 255; }); }
  function reachable() { return proc.online && validIp(lx.settings.host) && Number(lx.settings.port) === 8081; }

  function connect() {
    if (!lx.settings.enabled) return setState('disabled', '');
    if (!lx.settings.host) return setState('idle', '');
    if (!lx.paired) return setState('unpaired', '');
    setState('connecting');
    setTimeout(function () {
      if (!reachable()) { setState('error', !proc.online ? 'Timed out talking to the processor' : Number(lx.settings.port) !== 8081 ? 'The processor refused the connection. Check the IP address and that LEAP is reachable on this port' : 'Enter a valid IP address'); return; }
      if (lx.pairedHost && lx.pairedHost !== lx.settings.host) { setState('error', 'The processor no longer matches the saved pairing (replaced or reset?). Pair again'); return; }
      lx.leapVersion = '1.123'; lx.project = { name: 'MY Albatross (demo)', productType: 'Lutron HWQS Project' };
      lx.latencyMs = 3 + Math.floor(Math.random() * 6); lx.lastPingAt = new Date().toISOString();
      setState('connected', '');
    }, 900);
  }

  // ---------- circuits ----------
  function circuits() { var seen = {}, out = []; ((config && config.decks) || []).forEach(function (d) { (d.circuits || []).forEach(function (c) { if (!seen[c.id]) { seen[c.id] = 1; out.push(c); } }); }); return out; }
  function circuitById(id) { return circuits().filter(function (c) { return c.id === id; })[0]; }
  function zonesOf(c) { var all = []; ((config && config.decks) || []).forEach(function (d) { (d.circuits || []).forEach(function (x) { if (x.id === c.id && x.lutron && x.lutron.zones) x.lutron.zones.forEach(function (z) { if (all.indexOf(String(z)) < 0) all.push(String(z)); }); }); }); return all; }
  function initLevels(keep) { var n = {}; circuits().forEach(function (c) { n[c.id] = keep && levels[c.id] ? levels[c.id] : { on: !!c.on && !c.ni && (c.def || 0) > 0, level: c.def || 50 }; }); levels = n; }
  function knownZone(z) { return lx.discovery.zones.some(function (x) { return x.id === z; }) || procZones().some(function (x) { return x.id === z; }); }
  var _pz = null;
  function procZones() {
    if (_pz) return _pz;
    var out = [], n = 1100;
    ((config && config.decks) || []).forEach(function (d) {
      (d.circuits || []).forEach(function (c) {
        if (c.ni) return;
        var sides = /P\/S/.test(c.name) ? [' port', ' stbd'] : [''];
        sides.forEach(function (s) { out.push({ id: String(n++), name: c.name.replace(/ ?P\/S/, '') + s, area: d.name, controlType: c.tag === 'flood' ? 'Switched' : 'Dimmed' }); });
      });
    });
    _pz = out; return out;
  }
  function drive(c, st) {
    var w = [];
    if (lx.state !== 'connected') return w;
    zonesOf(c).forEach(function (z) {
      if (!knownZone(z)) { w.push(c.label + ' zone ' + z + ': Zone not found'); return; }
      var pz = procZones().filter(function (x) { return x.id === z; })[0];
      var v = st.on ? st.level : 0;
      proc.zoneLevels[z] = pz && pz.controlType === 'Switched' ? (v > 0 ? 100 : 0) : v;
    });
    return w;
  }
  function stateEv() { emit('state', { levels: levels, sceneBy: sceneBy }); }

  // ---------- API ----------
  function json(status, body) { return Promise.resolve(new Response(JSON.stringify(body), { status: status, headers: { 'Content-Type': 'application/json' } })); }
  function err(status, msg) { return json(status, { ok: false, error: msg }); }
  function sha256(str) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (b) { return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- demo users (PBKDF2 in the shared store; same rules as the server) ----------
  var usersRef = null, usersDoc = null;
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function pbkdf2(pw, saltHex) {
    var salt = new Uint8Array(saltHex.match(/../g).map(function (h) { return parseInt(h, 16); }));
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
      .then(function (k) { return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: 150000 }, k, 256); }).then(hex);
  }
  function makeHash(pw) { var salt = hex(crypto.getRandomValues(new Uint8Array(16))); return pbkdf2(pw, salt).then(function (h) { return { salt: salt, hash: h }; }); }
  function verify(pw, u) { if (u.sha) return sha256(pw).then(function (h) { return h === u.sha; }); return pbkdf2(pw, u.pw.salt).then(function (h) { return h === u.pw.hash; }); }
  function pubUser(u) { return u ? { id: u.id, name: u.name, master: !!u.master, createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null, passwordChangedAt: u.passwordChangedAt || null } : null; }
  function loadUsers() {
    if (usersDoc) return Promise.resolve(usersDoc);
    var fallback = function () { usersDoc = { users: [{ id: 'master', name: 'Wave AVI', master: true, sha: PASS_HASH, createdAt: null }] }; return usersDoc; };
    if (!usersRef) return Promise.resolve(fallback());
    return usersRef.get().then(function (snap) { var d = snap.exists ? snap.data() : null; if (d && d.users) { usersDoc = JSON.parse(JSON.stringify(d)); return usersDoc; } return fallback(); }).catch(fallback);
  }
  function saveUsers() { return usersRef ? usersRef.set(JSON.parse(JSON.stringify(usersDoc))) : Promise.resolve(); }
  function findByPassword(pw, exceptId) {
    var list = usersDoc.users.filter(function (u) { return u.id !== exceptId; });
    return Promise.all(list.map(function (u) { return verify(pw, u); })).then(function (r) { var i = r.indexOf(true); return i < 0 ? null : list[i]; });
  }
  function checkNew(pw, exceptId) {
    pw = String(pw || '');
    if (pw.length < 8) return Promise.reject('Use at least 8 characters');
    return findByPassword(pw, exceptId).then(function (u) { if (u) throw 'Another user already has that password. Choose a different one'; return pw; });
  }
  function usersApi(method, url, body) {
    return loadUsers().then(function () {
      if (!me) return err(401, 'Admin login required');
      if (url === '/api/users' && method === 'GET') return json(200, { users: usersDoc.users.map(pubUser), me: me });
      if (url === '/api/users' && method === 'POST') {
        var n = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (!n) return err(400, 'Enter a name');
        if (usersDoc.users.some(function (u) { return u.name.toLowerCase() === n.toLowerCase(); })) return err(400, 'There is already a user called ' + n);
        return checkNew(body.password).then(makeHash).then(function (h) {
          var u = { id: 'u' + hex(crypto.getRandomValues(new Uint8Array(6))), name: n, master: false, pw: h, createdAt: new Date().toISOString(), passwordChangedAt: new Date().toISOString() };
          usersDoc.users.push(u); return saveUsers().then(function () { return json(200, { ok: true, user: pubUser(u) }); });
        }).catch(function (m) { return err(400, String(m)); });
      }
      var mm = /^\/api\/users\/([A-Za-z0-9]+)(\/password)?$/.exec(url);
      if (!mm) return err(404, 'Not found');
      var u = usersDoc.users.filter(function (x) { return x.id === mm[1]; })[0];
      if (!u) return err(404, 'User not found');
      if (mm[2]) {
        var self = u.id === me.id;
        if (u.master && !self) return err(403, 'Only the Wave AVI master account can change the master password');
        return (self ? verify(String(body.currentPassword || ''), u) : Promise.resolve(true)).then(function (ok) {
          if (!ok) return err(401, 'Your current password is wrong');
          return checkNew(body.password, u.id).then(makeHash).then(function (h) {
            delete u.sha; u.pw = h; u.passwordChangedAt = new Date().toISOString();
            return saveUsers().then(function () { return json(200, { ok: true, user: pubUser(u) }); });
          }).catch(function (m) { return err(400, String(m)); });
        });
      }
      if (method === 'PUT') {
        if (u.master) return err(403, 'The master account name cannot be changed');
        var nn = String(body.name || '').trim().slice(0, 40); if (!nn) return err(400, 'Enter a name');
        u.name = nn; if (me.id === u.id) me.name = nn;
        return saveUsers().then(function () { return json(200, { ok: true, user: pubUser(u) }); });
      }
      if (method === 'DELETE') {
        if (u.master) return err(403, 'The master account cannot be deleted');
        if (u.id === me.id) return err(400, 'You cannot delete the account you are logged in with');
        usersDoc.users = usersDoc.users.filter(function (x) { return x.id !== u.id; });
        return saveUsers().then(function () { return json(200, { ok: true }); });
      }
      return err(404, 'Not found');
    });
  }

  // Decks added to the standard layout in an update are added to the saved layout once,
  // in their standard position (same rule as the server). Nothing else is changed.
  var deckCheckDone = false;
  function addNewDefaultDecks() {
    realFetch('config.json').then(function (r) { return r.json(); }).then(function (def) {
      if (!def || !def.decks || !config || !docRef) return;
      var have = {}; config.decks.forEach(function (d) { have[d.id] = 1; });
      var seen = {}; (config.knownDefaultDecks || []).forEach(function (id) { seen[id] = 1; });
      var added = false;
      def.decks.forEach(function (d, i) {
        if (have[d.id] || seen[d.id]) return;
        var prev = def.decks.slice(0, i).reverse().filter(function (x) { return have[x.id]; })[0];
        var at = prev ? config.decks.map(function (x) { return x.id; }).indexOf(prev.id) + 1 : config.decks.length;
        config.decks.splice(at, 0, JSON.parse(JSON.stringify(d))); have[d.id] = 1; added = true;
      });
      var known = def.decks.map(function (d) { return d.id; });
      if (!added && (config.knownDefaultDecks || []).join() === known.join()) return;
      config.knownDefaultDecks = known; _pz = null; initLevels(true);
      docRef.update({ decks: JSON.parse(JSON.stringify(config.decks)), knownDefaultDecks: known }).catch(function () {});
      emit('config', config); stateEv();
    }).catch(function () {});
  }

  // Layout: the shared store on claude.ai; elsewhere config.json next to the page.
  function loadFallback() {
    return realFetch('config.json').then(function (r) { return r.json(); })
      .then(function (c) { if (!config && c && c.decks) { config = c; _pz = null; initLevels(false); } })
      .catch(function () {});
  }
  var ready = new Promise(function (resolve) {
    var done = false, finish = function () { if (done) return; done = true; (config ? Promise.resolve() : loadFallback()).then(resolve); };
    setTimeout(finish, 10000);
    if (!(window.claude && window.claude.use)) return finish();
    window.claude.use('db').then(function (ns) {
      if (!ns) return finish();
      db = ns; docRef = db.doc('config/layout'); usersRef = db.doc('auth/users');
      docRef.onSnapshot(function (snap) {
        var data = snap.exists ? snap.data() : null;
        if (data && data.decks) {
          var first = !config;
          config = JSON.parse(JSON.stringify(data)); _pz = null; initLevels(!first);
          if (!first) emit('config', config);
          if (!deckCheckDone && !snap.metadata.fromCache) { deckCheckDone = true; addNewDefaultDecks(); }
        }
        if (!snap.metadata.fromCache) finish();
      }, function () { docRef = null; finish(); });
    }).catch(finish);
  });

  function handle(method, url, body) {
    if (url === '/api/bootstrap') return ready.then(function () {
      if (!config) return err(503, 'The lighting layout could not be loaded');
      return json(200, { config: config, levels: levels, sceneBy: sceneBy, admin: admin, user: me, lutron: pub(), adminConfigured: true });
    });
    var need = function () { if (!admin) throw 401; };
    if (url.indexOf('/api/users') === 0) return usersApi(method, url, body);
    try {
      switch (url) {
        case '/api/login':
          return loadUsers().then(function () { return findByPassword(String(body.password || '')); }).then(function (u) {
            if (!u) return err(401, 'Wrong password');
            u.lastLoginAt = new Date().toISOString(); saveUsers().catch(function () {});
            admin = true; me = pubUser(u); return json(200, { ok: true, user: me });
          });
        case '/api/logout': admin = false; me = null; return json(200, { ok: true });
        case '/api/circuit': {
          var c = circuitById(body.id); if (!c || c.ni) return err(404, 'Unknown circuit — save the layout first');
          var prev = levels[c.id] || { on: false, level: 50 };
          var st = { on: body.on === undefined ? prev.on : !!body.on, level: body.level === undefined ? prev.level : Math.max(0, Math.min(100, +body.level)) };
          if (body.level !== undefined && body.on === undefined) st.on = st.level > 0;
          if (st.on && st.level === 0) st.level = 50;
          levels[c.id] = st; sceneBy = {}; stateEv();
          return json(200, { ok: true, warnings: drive(c, st) });
        }
        case '/api/scene': {
          var sc = (config.scenes || []).filter(function (s) { return s.id === body.id; })[0]; if (!sc) return err(404, 'Unknown scene');
          var scope = body.scope || 'all', list;
          if (scope === 'all') list = circuits(); else { var dk = config.decks.filter(function (x) { return x.id === scope; })[0]; list = dk ? dk.circuits : []; }
          var w = [];
          list.forEach(function (x) { if (x.ni || (sc.levels || {})[x.id] < 0) return; var v = (sc.levels || {})[x.id] || 0, p = levels[x.id] || { level: 50 }; levels[x.id] = v > 0 ? { on: true, level: v } : { on: false, level: p.level }; w = w.concat(drive(x, levels[x.id])); });
          if (scope === 'all') { sceneBy = { all: sc.id }; config.decks.forEach(function (d) { sceneBy[d.id] = sc.id; }); } else { sceneBy = Object.assign({}, sceneBy, { all: null }); sceneBy[scope] = sc.id; }
          stateEv();
          return json(200, { ok: true, warnings: scope === 'all' && sc.lutronButton && lx.state === 'connected' ? [] : w });
        }
        case '/api/alloff': {
          var w2 = [];
          circuits().forEach(function (x) { var p = levels[x.id] || { level: 50 }; levels[x.id] = { on: false, level: p.level }; if (!x.ni) w2 = w2.concat(drive(x, levels[x.id])); });
          sceneBy = {}; stateEv();
          return json(200, { ok: true, warnings: w2 });
        }
        case '/api/config': {
          need();
          var next = { decks: body.decks, scenes: body.scenes, knownDefaultDecks: (config && config.knownDefaultDecks) || [], updatedAt: new Date().toISOString() };
          if (!docRef) { config = next; _pz = null; initLevels(true); return json(200, { ok: true }); }
          return docRef.set(JSON.parse(JSON.stringify(next))).then(function () { config = next; _pz = null; initLevels(true); stateEv(); return json(200, { ok: true }); })
            .catch(function (e) { return err(500, e && e.code === 'invalid_argument' ? 'This account cannot save changes. Ask the owner for edit access' : 'Save failed: ' + ((e && e.message) || e)); });
        }
        case '/api/lutron': need(); return json(200, { status: full(), discovery: lx.discovery, zoneLevels: proc.zoneLevels });
        case '/api/lutron/settings':
          need();
          if (body.host && !/^[A-Za-z0-9.\-:]+$/.test(body.host)) return err(400, 'Enter a valid IP address or host name');
          lx.settings = { host: body.host || '', port: +body.port || 8081, fadeSeconds: +body.fadeSeconds || 0, enabled: body.enabled !== false };
          persistLx(); connect();
          return json(200, { ok: true, status: full() });
        case '/api/lutron/test':
          need();
          if (!lx.settings.host) return json(200, { ok: false, error: 'Enter the processor IP address first' });
          if (!lx.paired) return json(200, { ok: false, error: 'Not paired yet. Pair with the processor first' });
          return wait(700).then(function () {
            if (!proc.online) return json(200, { ok: false, error: 'Timed out talking to the processor' });
            if (!reachable()) return json(200, { ok: false, error: 'The processor refused the connection. Check the IP address and that LEAP is reachable on this port' });
            lx.latencyMs = 2 + Math.floor(Math.random() * 6); lx.lastPingAt = new Date().toISOString(); lx.leapVersion = '1.123';
            lx.project = { name: 'MY Albatross (demo)', productType: 'Lutron HWQS Project' };
            return json(200, { ok: true, connectMs: 8 + Math.floor(Math.random() * 20), latencyMs: lx.latencyMs, leapVersion: '1.123', project: lx.project, processor: { name: 'Processor 001', model: 'HQP7-2', serial: 'DEMO-0042', type: 'HWQSProcessor' } });
          });
        case '/api/lutron/pair': {
          need();
          if (['connecting', 'generating-key', 'waiting-button', 'signing', 'verifying'].indexOf(lx.pairing.stage) >= 0) return err(409, 'Pairing is already running');
          if (!lx.settings.host) return err(400, 'Enter the processor IP address first');
          lx.pairing = { stage: 'connecting', error: '', startedAt: new Date().toISOString() };
          proc.accessPressed = false; renderPanel();
          runPairing();
          return json(200, { ok: true, status: full() });
        }
        case '/api/lutron/unpair': need(); lx.paired = false; lx.pairedHost = ''; lx.pairing = { stage: 'idle', error: '', startedAt: null }; lx.leapVersion = ''; lx.project = null; persistLx(); connect(); return json(200, { ok: true });
        case '/api/lutron/reconnect': need(); connect(); return json(200, { ok: true });
        case '/api/lutron/discover':
          need();
          if (lx.state !== 'connected') return err(500, 'Not connected to the processor');
          return wait(900).then(function () {
            _pz = null;
            var bid = 7;
            lx.discovery = { zones: procZones().slice().sort(function (a, b) { return (a.area + a.name).localeCompare(b.area + b.name); }), buttons: (config.scenes || []).filter(function (s) { return s.id !== 'off'; }).map(function (s) { return { id: String(bid++), name: s.name }; }), readAt: new Date().toISOString() };
            lx.discovery.zones.forEach(function (z) { if (proc.zoneLevels[z.id] === undefined) proc.zoneLevels[z.id] = 0; });
            persistLx(); renderPanel();
            return json(200, { ok: true, discovery: lx.discovery, zoneLevels: proc.zoneLevels });
          });
        case '/api/lutron/zone-test': {
          need();
          if (lx.state !== 'connected') return err(500, 'Not connected to the processor');
          var zs = (body.zones || []).map(String).filter(Boolean);
          if (!zs.length) return err(400, 'Enter at least one zone ID');
          var res = zs.map(function (z) { if (!knownZone(z)) return { zone: z, ok: false, error: 'Zone not found' }; proc.zoneLevels[z] = +body.level; return { zone: z, ok: true }; });
          flash(L('Zones ', 'Зоны ') + zs.join(', ') + ' → ' + (+body.level ? L('ON', 'ВКЛ') : L('OFF', 'ВЫКЛ')));
          return json(200, { ok: res.every(function (r) { return r.ok; }), results: res });
        }
        case '/api/lutron/button-test':
          need();
          if (lx.state !== 'connected') return err(500, 'Not connected to the processor');
          flash(L('Lutron scene #' + body.id + ' pressed', 'Нажата сцена Lutron №' + body.id));
          return json(200, { ok: true });
      }
    } catch (e) { if (e === 401) return err(401, 'Admin login required'); return err(500, String(e)); }
    return err(404, 'Not found');
  }

  function runPairing() {
    var t0 = Date.now();
    var step = function (s) { lx.pairing.stage = s; renderPanel(); };
    setTimeout(function () {
      if (!reachable()) { lx.pairing = { stage: 'failed', error: !proc.online ? 'Could not reach the processor' : 'The processor refused the connection. Check the IP address and port', startedAt: lx.pairing.startedAt }; renderPanel(); return; }
      step('generating-key');
      setTimeout(function () {
        step('waiting-button');
        var iv = setInterval(function () {
          if (proc.accessPressed) {
            clearInterval(iv); step('signing');
            setTimeout(function () { step('verifying'); setTimeout(function () {
              lx.paired = true; lx.pairedHost = lx.settings.host; lx.pairing.stage = 'done'; persistLx(); connect();
            }, 700); }, 700);
          } else if (Date.now() - t0 > 180000) {
            clearInterval(iv); lx.pairing = { stage: 'failed', error: 'The Access button was not pressed within 3 minutes', startedAt: lx.pairing.startedAt }; renderPanel();
          }
        }, 300);
      }, 600);
    }, 700);
  }

  // ---------- fetch / EventSource stand-ins ----------
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    var path = url.replace(location.origin, '');
    if (path.indexOf('/api/') !== 0) return realFetch(input, init);
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) {}
    return handle((init && init.method) || 'GET', path.split('?')[0], body);
  };
  window.EventSource = function () { var self = this; this.addEventListener = function (ev, fn) { listeners.push({ ev: ev, fn: fn }); }; this.close = function () {}; setTimeout(function () { stateEv(); emit('lutron', pub()); }, 0); return self; };

  // Simulated keypad activity: GR24 pressed on a Lutron keypad every 45 s while connected.
  setInterval(function () {
    if (lx.state !== 'connected' || !config) return;
    var c = circuitById('GR24'); if (!c || !zonesOf(c).length) return;
    var p = levels.GR24 || { level: 60 };
    levels.GR24 = p.on ? { on: false, level: p.level } : { on: true, level: p.level || 60 };
    zonesOf(c).forEach(function (z) { proc.zoneLevels[z] = levels.GR24.on ? levels.GR24.level : 0; });
    sceneBy = {}; stateEv(); flash(L('Keypad: GR24 turned ' + (levels.GR24.on ? 'on' : 'off'), 'Кнопочная панель: GR24 ' + (levels.GR24.on ? 'включена' : 'выключена')));
  }, 45000);
  setInterval(function () { if (lx.state === 'connected' && !proc.online) { setState('error', 'Connection to the processor was lost'); } }, 2000);

  // ---------- floating "simulated processor" panel ----------
  var panel = null, flashMsg = '', flashT = null, panelLang = '';
  function ru() { return document.documentElement.lang === 'ru'; }
  function L(en, r) { return ru() ? r : en; }
  function flash(m) { flashMsg = m; renderPanel(); clearTimeout(flashT); flashT = setTimeout(function () { flashMsg = ''; renderPanel(); }, 3000); }
  // Only admins see the simulated processor, and only on the Lutron setup page.
  function updateVisibility() {
    if (!panel) return;
    var show = admin && !!document.querySelector('[data-act="lxSave"]');
    panel.style.display = show ? 'flex' : 'none';
  }
  function renderPanel() {
    if (!panel) return;
    updateVisibility();
    var waiting = lx.pairing.stage === 'waiting-button';
    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><b style="font:600 13px Inter,sans-serif;letter-spacing:.06em">' + L('DEMO · SIMULATED QSX', 'ДЕМО · ИМИТАЦИЯ QSX') + '</b>' +
      '<button type="button" data-demo="min" aria-label="' + (panel.dataset.min ? L('Expand demo panel', 'Развернуть панель') : L('Minimise demo panel', 'Свернуть панель')) + '" style="height:28px;min-width:28px;border-radius:6px;border:1px solid #3A5069;background:transparent;color:#E7EEF5;cursor:pointer">' + (panel.dataset.min ? '+' : '–') + '</button></div>' +
      (panel.dataset.min ? '' :
      '<div style="font-size:12px;color:#C9D6E3;line-height:1.45">' + L('No real processor is connected here. Use any valid IP (e.g. 192.168.10.20) and port 8081 in <b>Lutron setup</b>.', 'Реальный процессор не подключён. Укажите любой правильный IP (напр. 192.168.10.20) и порт 8081 в разделе <b>Настройка Lutron</b>.') + '</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" data-demo="online"' + (proc.online ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:#F2B45A">' + L('Processor online', 'Процессор в сети') + '</label>' +
      '<button type="button" data-demo="access" style="height:44px;border-radius:10px;border:1px solid ' + (waiting ? '#F2B45A' : '#3A5069') + ';background:' + (waiting ? '#F2B45A' : '#16283A') + ';color:' + (waiting ? '#0B1622' : '#9FB2C6') + ';font:600 14px Inter,sans-serif;cursor:pointer"' + (waiting ? '' : ' disabled') + '>' + L('Press Access button', 'Нажать кнопку Access') + '</button>' +
      '<div style="font-size:12px;color:#9FB2C6">' + L('Link: ', 'Связь: ') + (ru() ? ({ idle: 'не настроен', unpaired: 'не сопряжён', connecting: 'подключение', connected: 'подключён', error: 'ошибка', disabled: 'выключен' }[lx.state] || lx.state) : lx.state) + (lx.paired ? L(' · paired', ' · сопряжён') : '') + '</div>') +
      (flashMsg ? '<div role="status" style="font-size:12px;color:#F6D8A8">' + flashMsg.replace(/</g, '&lt;') + '</div>' : '');
  }
  function mountPanel() {
    panel = document.createElement('aside');
    panel.setAttribute('aria-label', 'Simulated processor');
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;width:250px;z-index:30;background:#1A1408;border:1px solid #6B4E1E;border-radius:12px;padding:12px;display:none;flex-direction:column;gap:10px;color:#F6D8A8;font-family:Inter,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45)';
    document.body.appendChild(panel);
    panel.addEventListener('click', function (e) {
      var t = e.target.closest('[data-demo]'); if (!t) return;
      var a = t.getAttribute('data-demo');
      if (a === 'access') { proc.accessPressed = true; flash(L('Access button pressed', 'Кнопка Access нажата')); }
      if (a === 'min') { if (panel.dataset.min) delete panel.dataset.min; else panel.dataset.min = '1'; renderPanel(); }
    });
    panel.addEventListener('change', function (e) {
      if (e.target.getAttribute('data-demo') === 'online') { proc.online = e.target.checked; if (proc.online && lx.paired) connect(); renderPanel(); }
    });
    renderPanel();
    var app = document.getElementById('app');
    if (app && window.MutationObserver) new MutationObserver(function () { if (panelLang !== document.documentElement.lang) { panelLang = document.documentElement.lang; renderPanel(); } else updateVisibility(); }).observe(app, { childList: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPanel); else mountPanel();
  connect();
})();
