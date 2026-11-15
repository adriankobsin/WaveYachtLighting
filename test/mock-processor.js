'use strict';
/**
 * Development-only mock of a HomeWorks QSX processor's LEAP endpoints.
 *   npm run mock-processor            (writes test certificates to ./test-data)
 *   DATA_DIR=test-data npm start      (in a second terminal)
 * Then in Lutron setup use IP 127.0.0.1 and LEAP port 18081. The mock also
 * writes test-data/settings.json with pairPort 18083 so pairing goes to it.
 * Never point the mock at the real data folder: it replaces the LAP files.
 * The "Access button" is pressed automatically 1.5 s after a pairing connection.
 */
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const OUT = process.argv[2] || path.join(__dirname, '..', 'test-data');
const PAIR_PORT = 18083, LEAP_PORT = 18081;

function makeCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000); cert.validity.notAfter = new Date(Date.now() + 3650 * 86400000);
  const attrs = [{ name: 'commonName', value: 'mock-lutron-root' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}
function issue(ca, publicKey, cn, serial) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey; cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 86400000); cert.validity.notAfter = new Date(Date.now() + 3650 * 86400000);
  cert.setSubject([{ name: 'commonName', value: cn }]); cert.setIssuer(ca.cert.subject.attributes);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

const ca = makeCa();
const caPem = forge.pki.certificateToPem(ca.cert);
const srvKeys = forge.pki.rsa.generateKeyPair(2048);
const srvKey = forge.pki.privateKeyToPem(srvKeys.privateKey);
const srvCert = issue(ca, srvKeys.publicKey, 'mock-processor', '02');
const lapKeys = forge.pki.rsa.generateKeyPair(2048);
fs.mkdirSync(path.join(OUT, 'lutron'), { recursive: true });
const settingsFile = path.join(OUT, 'settings.json');
let st = {}; try { st = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) {}
st.lutron = Object.assign({ host: '127.0.0.1', port: LEAP_PORT, fadeSeconds: 2, enabled: true }, st.lutron || {}, { pairPort: PAIR_PORT });
fs.writeFileSync(settingsFile, JSON.stringify(st, null, 2));
fs.writeFileSync(path.join(OUT, 'lutron', 'lap-ca.pem'), caPem);
fs.writeFileSync(path.join(OUT, 'lutron', 'lutron-root-ca.pem'), caPem);
fs.writeFileSync(path.join(OUT, 'lutron', 'lap-cert.pem'), issue(ca, lapKeys.publicKey, 'lap-client', '03'));
fs.writeFileSync(path.join(OUT, 'lutron', 'lap-key.pem'), forge.pki.privateKeyToPem(lapKeys.privateKey));

const zones = {
  '101': { name: 'Main deck side deck port', area: 2, type: 'Dimmed', level: 0 },
  '102': { name: 'Main deck side deck stbd', area: 2, type: 'Dimmed', level: 0 },
  '201': { name: 'Bridge floods', area: 3, type: 'Switched', level: 0 }
};
const areas = [{ href: '/area/1', Name: 'Yacht' }, { href: '/area/2', Name: 'Main deck', Parent: { href: '/area/1' } }, { href: '/area/3', Name: 'Bridge deck', Parent: { href: '/area/1' } }];
const subscribers = new Set();
const log = (...a) => console.log('[mock]', ...a);

function lines(sock, onMsg) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onMsg(JSON.parse(l)); } });
  sock.on('error', () => {});
}
const send = (sock, o) => sock.write(JSON.stringify(o) + '\r\n');
const zstatus = (id) => ({ href: '/zone/' + id + '/status', Zone: { href: '/zone/' + id }, Level: zones[id].level, StatusAccuracy: 'Good' });

tls.createServer({ key: srvKey, cert: srvCert, ca: caPem, requestCert: true, rejectUnauthorized: true }, (sock) => {
  log('pairing connection');
  const t = setTimeout(() => send(sock, { Header: { StatusCode: '200 OK', ContentType: 'status;plurality=single' }, Body: { Status: { Permissions: ['Public', 'PhysicalAccess'] } } }), 1500);
  lines(sock, (m) => {
    if (m.Header && m.Header.Url === '/pair' && m.Body && m.Body.CommandType === 'CSR') {
      const csr = forge.pki.certificationRequestFromPem(m.Body.Parameters.CSR);
      const cert = issue(ca, csr.publicKey, 'paired-client', '1' + Date.now());
      log('signed CSR for', m.Body.Parameters.DisplayName);
      send(sock, { Header: { StatusCode: '200 OK', ClientTag: 'get-cert', ContentType: 'signing-result;plurality=single' }, Body: { SigningResult: { Certificate: cert, RootCertificate: caPem } } });
    }
  });
  sock.on('close', () => clearTimeout(t));
}).listen(PAIR_PORT, () => log('pairing on', PAIR_PORT));

tls.createServer({ key: srvKey, cert: srvCert, ca: caPem, requestCert: true, rejectUnauthorized: true }, (sock) => {
  log('LEAP connection');
  lines(sock, (m) => {
    const h = m.Header || {}, tag = h.ClientTag, url = h.Url;
    const reply = (status, body, type) => send(sock, { CommuniqueType: type || 'ReadResponse', Header: { StatusCode: status, ClientTag: tag, Url: url, MessageBodyType: 'x' }, Body: body });
    if (m.CommuniqueType === 'ReadRequest') {
      if (url === '/server/1/status/ping') return reply('200 OK', { PingResponse: { LEAPVersion: 1.123 } });
      if (url === '/project') return reply('200 OK', { Project: { Name: 'MY Albatross (mock)', ProductType: 'Lutron HWQS Project' } });
      if (url === '/device?where=IsThisDevice:true') return reply('200 OK', { Devices: [{ href: '/device/1', Name: 'Processor 001', ModelNumber: 'HQP7-2', SerialNumber: 12345678, DeviceType: 'HWQSProcessor', AssociatedArea: { href: '/area/1' } }] });
      if (url === '/area') return reply('200 OK', { Areas: areas });
      let mm = /^\/area\/(\d+)\/associatedzone$/.exec(url);
      if (mm) return reply('200 OK', { Zones: Object.keys(zones).filter((id) => String(zones[id].area) === mm[1]).map((id) => ({ href: '/zone/' + id, Name: zones[id].name, ControlType: zones[id].type, Level: zones[id].level })) });
      if (url === '/virtualbutton') return reply('200 OK', { VirtualButtons: [{ href: '/virtualbutton/7', Name: 'Evening', IsProgrammed: true }, { href: '/virtualbutton/8', Name: '', IsProgrammed: false }] });
      return reply('404 NotFound', { Message: 'No such resource' }, 'ExceptionResponse');
    }
    if (m.CommuniqueType === 'SubscribeRequest' && url === '/zone/status') {
      subscribers.add({ sock, tag });
      return reply('200 OK', { ZoneStatuses: Object.keys(zones).map(zstatus) }, 'SubscribeResponse');
    }
    if (m.CommuniqueType === 'CreateRequest') {
      let mm = /^\/zone\/(\d+)\/commandprocessor$/.exec(url);
      if (mm) {
        const z = zones[mm[1]];
        if (!z) return reply('404 NotFound', { Message: 'Zone not found' }, 'ExceptionResponse');
        const cmd = m.Body.Command;
        if (cmd.CommandType === 'GoToDimmedLevel' && z.type !== 'Dimmed') return reply('400 BadRequest', { Message: 'Command not supported for this zone' }, 'ExceptionResponse');
        const lvl = cmd.CommandType === 'GoToDimmedLevel' ? cmd.DimmedLevelParameters.Level : cmd.Parameter[0].Value;
        z.level = z.type === 'Switched' ? (lvl > 0 ? 100 : 0) : lvl;
        log('zone', mm[1], cmd.CommandType, '->', z.level, cmd.DimmedLevelParameters ? 'fade ' + cmd.DimmedLevelParameters.FadeTime : '');
        reply('201 Created', { CommandProcessor: { href: url } }, 'CreateResponse');
        subscribers.forEach((s) => { if (!s.sock.destroyed) send(s.sock, { CommuniqueType: 'ReadResponse', Header: { StatusCode: '200 OK', ClientTag: s.tag, Url: '/zone/' + mm[1] + '/status' }, Body: { ZoneStatus: zstatus(mm[1]) } }); });
        return;
      }
      mm = /^\/virtualbutton\/(\d+)\/commandprocessor$/.exec(url);
      if (mm) { log('virtual button', mm[1], 'pressed'); return reply('201 Created', {}, 'CreateResponse'); }
    }
    reply('400 BadRequest', { Message: 'Unsupported' }, 'ExceptionResponse');
  });
  sock.on('close', () => subscribers.forEach((s) => { if (s.sock === sock) subscribers.delete(s); }));
}).listen(LEAP_PORT, () => log('LEAP on', LEAP_PORT));

// Simulate someone using a Lutron keypad: change zone 101 every 20 s.
setInterval(() => {
  zones['101'].level = zones['101'].level > 0 ? 0 : 75;
  subscribers.forEach((s) => { if (!s.sock.destroyed) send(s.sock, { CommuniqueType: 'ReadResponse', Header: { StatusCode: '200 OK', ClientTag: s.tag, Url: '/zone/101/status' }, Body: { ZoneStatus: zstatus('101') } }); });
}, 20000);
