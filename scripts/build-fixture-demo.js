// Builds a single self-contained copy of the fixture-view concept demo
// (prototypes/fixtures/index.html) with the deck plans embedded.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'prototypes/fixtures/index.html'), 'utf8');
for (const d of ['sundeck', 'main']) {
  const b64 = fs.readFileSync(path.join(root, 'public/img', d + '.png')).toString('base64');
  html = html.replace(`__IMG_${d}__`, 'data:image/png;base64,' + b64);
}
const out = path.join(root, 'prototypes/fixtures/dist');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('Wrote', path.join(out, 'index.html'), Math.round(html.length / 1024) + ' KB');
