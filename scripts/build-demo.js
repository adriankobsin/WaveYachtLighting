'use strict';
/**
 * Builds the browser demo (no mini PC, simulated QSX processor):
 *   npm run build-demo  ->  demo/dist/index.html + demo/dist/img/
 * It is public/index.html with demo/demo-shim.js injected in front of the
 * app script, so the demo always runs the same app code as the server.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'demo', 'dist');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'demo', 'demo-shim.js'), 'utf8');
const i = html.indexOf('<script>');
if (i < 0) throw new Error('No <script> found in public/index.html');
const demo = (html.slice(0, i) + '<script>\n' + shim + '</script>\n' + html.slice(i))
  .replace(/<title>[^<]*<\/title>/, '<title>Albatross Exterior Lighting Control</title>');
fs.mkdirSync(path.join(out, 'img'), { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), demo);
fs.readdirSync(path.join(root, 'public', 'img')).forEach((f) => fs.copyFileSync(path.join(root, 'public', 'img', f), path.join(out, 'img', f)));
fs.copyFileSync(path.join(root, 'defaults', 'config.json'), path.join(out, 'config.json'));
fs.copyFileSync(path.join(root, 'public', 'i18n.js'), path.join(out, 'i18n.js'));
console.log('Demo built in ' + out);
