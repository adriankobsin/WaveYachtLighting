'use strict';
/**
 * LEAP pairing with a HomeWorks QSX / RadioRA 3 processor.
 *
 * 1. Connect with TLS to port 8083 using the LAP ("Lutron Authentication
 *    Protocol") client certificate.
 * 2. Wait until the processor reports PhysicalAccess, which happens when
 *    someone presses the Access button on the processor.
 * 3. Send a certificate signing request (CSR) for our own new key.
 * 4. The processor returns a signed client certificate and its root CA.
 * 5. Verify by connecting to the LEAP port (8081) and sending a ping.
 *
 * The flow follows the open-source pylutron-caseta library (Apache-2.0).
 */
const tls = require('tls');
const crypto = require('crypto');
const forge = require('node-forge');
const { LeapClient } = require('./leap');

const VERIFY_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE'
]);

function makeKeyAndCsr(commonName) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.publicKeyFromPem(publicKey);
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { keyPem: privateKey, csrPem: forge.pki.certificationRequestToPem(csr) };
}

function requestCertificate({ host, port, lap, ca, csrPem, displayName, onStatus, buttonTimeoutMs, connectTimeoutMs }) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stage = 'connecting';
    let finished = false;
    const finish = (err, val) => {
      if (finished) return;
      finished = true;
      clearTimeout(connTimer);
      clearTimeout(buttonTimer);
      sock.destroy();
      if (err) reject(err); else resolve(val);
    };
    const connTimer = setTimeout(() => finish(Object.assign(new Error('Could not reach the processor on port ' + port), { code: 'CONNECT_TIMEOUT' })), connectTimeoutMs);
    let buttonTimer = null;

    const sock = tls.connect({
      host, port,
      key: lap.key, cert: lap.cert, ca,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined
    });
    sock.setEncoding('utf8');
    sock.on('secureConnect', () => {
      clearTimeout(connTimer);
      stage = 'waiting-button';
      onStatus('waiting-button');
      buttonTimer = setTimeout(() => finish(Object.assign(new Error('The Access button was not pressed in time'), { code: 'BUTTON_TIMEOUT' })), buttonTimeoutMs);
    });
    sock.on('error', (err) => finish(err));
    sock.on('close', () => finish(new Error(stage === 'waiting-button' ? 'The processor closed the pairing connection' : 'Pairing connection closed')));
    sock.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + (buffer[i] === '\r' ? 2 : 1));
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        const header = msg.Header || {};
        if (stage === 'waiting-button') {
          const perms = (msg.Body && msg.Body.Status && msg.Body.Status.Permissions) || [];
          if (String(header.ContentType || '').startsWith('status;') && perms.indexOf('PhysicalAccess') >= 0) {
            clearTimeout(buttonTimer);
            stage = 'signing';
            onStatus('signing');
            sock.write(JSON.stringify({
              Header: { RequestType: 'Execute', Url: '/pair', ClientTag: 'get-cert' },
              Body: {
                CommandType: 'CSR',
                Parameters: { CSR: csrPem, DisplayName: displayName, DeviceUID: '000000000000', Role: 'Admin' }
              }
            }) + '\r\n');
            buttonTimer = setTimeout(() => finish(new Error('The processor did not return a certificate')), 15000);
          }
        } else if (stage === 'signing' && header.ClientTag === 'get-cert') {
          const r = msg.Body && msg.Body.SigningResult;
          if (!r || !r.Certificate) return finish(new Error('The processor refused the pairing request'));
          finish(null, { cert: r.Certificate, rootCa: r.RootCertificate });
        }
      }
    });
  });
}

/**
 * @param {object} o
 * @param {string} o.host
 * @param {{ca:string, cert:string, key:string, root:string}} o.lap  LAP certificates
 * @param {(stage:string)=>void} [o.onStatus]
 * @returns {Promise<{key:string, cert:string, ca:string, leapVersion:string}>}
 */
async function pair(o) {
  const onStatus = o.onStatus || function () {};
  const displayName = o.displayName || 'wave-lighting';
  const pairPort = o.pairPort || 8083;
  const leapPort = o.leapPort || 8081;
  onStatus('generating-key');
  const { keyPem, csrPem } = makeKeyAndCsr(displayName);
  const base = {
    host: o.host, port: pairPort, lap: o.lap, csrPem, displayName, onStatus,
    buttonTimeoutMs: o.buttonTimeoutMs || 180000, connectTimeoutMs: o.connectTimeoutMs || 10000
  };

  let signed, ca;
  try {
    signed = await requestCertificate(Object.assign({ ca: o.lap.ca }, base));
    ca = signed.rootCa;
  } catch (err) {
    if (!VERIFY_ERRORS.has(err.code)) throw err;
    // HomeWorks QSX / RadioRA 3 processors are signed by the Lutron root CA
    // rather than the LAP CA: retry against it.
    signed = await requestCertificate(Object.assign({ ca: o.lap.root }, base));
    ca = o.lap.root;
  }

  onStatus('verifying');
  const client = new LeapClient({ host: o.host, port: leapPort, key: keyPem, cert: signed.cert, ca });
  try {
    await client.connect();
    const ping = await client.ping();
    return { key: keyPem, cert: signed.cert, ca, leapVersion: ping.leapVersion };
  } finally {
    client.close();
  }
}

module.exports = { pair, makeKeyAndCsr };
