'use strict';
/**
 * Fetches the LAP pairing certificates used to pair with Lutron LEAP
 * processors. They ship inside the open-source pylutron-caseta library
 * (Apache-2.0, https://github.com/gurumitts/pylutron-caseta).
 *
 *   npm run fetch-certs                      download from PyPI (needs internet)
 *   npm run fetch-certs -- --from file.tar.gz use a downloaded pylutron_caseta sdist
 *   npm run fetch-certs -- --from assets.py   use the library's assets.py directly
 *
 * The files are written to data/lutron/ and are only used during pairing.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'lutron');

function get(url, redirects) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'wave-lighting' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 5) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/** Finds a file inside a .tar.gz buffer (plain ustar reader). */
function fileFromTarGz(buf, endsWith) {
  const tar = zlib.gunzipSync(buf);
  let off = 0, longName = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const data = tar.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
    else {
      const full = longName || name; longName = null;
      if (full.endsWith(endsWith)) return data.toString('utf8');
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

function extract(py) {
  const pick = (name) => {
    const m = new RegExp(name + '\\s*=\\s*"""\\s*([\\s\\S]*?)"""').exec(py);
    if (!m) throw new Error('Could not find ' + name + ' in assets.py');
    return m[1].trim() + '\n';
  };
  return {
    'lap-ca.pem': pick('LAP_CA_PEM'),
    'lap-cert.pem': pick('LAP_CERT_PEM'),
    'lap-key.pem': pick('LAP_KEY_PEM'),
    'lutron-root-ca.pem': pick('LUTRON_ROOT_CA_PEM')
  };
}

(async () => {
  let py;
  const i = process.argv.indexOf('--from');
  if (i > 0 && process.argv[i + 1]) {
    const f = process.argv[i + 1];
    py = f.endsWith('.py') ? fs.readFileSync(f, 'utf8') : fileFromTarGz(fs.readFileSync(f), 'pylutron_caseta/assets.py');
  } else {
    console.log('Downloading pylutron-caseta from PyPI…');
    const meta = JSON.parse((await get('https://pypi.org/pypi/pylutron-caseta/json')).toString('utf8'));
    const sdist = (meta.urls || []).find((u) => u.packagetype === 'sdist');
    if (!sdist) throw new Error('No source package found on PyPI');
    py = fileFromTarGz(await get(sdist.url), 'pylutron_caseta/assets.py');
  }
  if (!py) throw new Error('assets.py was not found in the package');
  const files = extract(py);
  fs.mkdirSync(OUT, { recursive: true });
  Object.keys(files).forEach((n) => fs.writeFileSync(path.join(OUT, n), files[n], { mode: n.includes('key') ? 0o600 : 0o644 }));
  console.log('LAP certificates saved in ' + OUT);
})().catch((e) => { console.error('Failed: ' + e.message); process.exit(1); });
