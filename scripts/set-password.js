'use strict';
// Sets the admin password: npm run set-password
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { hashPassword } = require('../lib/auth');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = function (s) { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const p1 = process.argv[2] || await ask('New admin password: ', true);
  const p2 = process.argv[2] || await ask('Repeat password: ', true);
  if (!p1 || p1.length < 8) { console.error('Use at least 8 characters.'); process.exit(1); }
  if (p1 !== p2) { console.error('The passwords do not match.'); process.exit(1); }
  fs.writeFileSync(path.join(DATA, 'admin.json'), JSON.stringify(hashPassword(p1), null, 2));
  console.log('Admin password saved. Restart the server for open sessions to be dropped.');
})();
