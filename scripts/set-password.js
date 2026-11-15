'use strict';
/**
 * Sets a password from the command line, for recovery when nobody can log in.
 *   npm run set-password                    master account (Wave AVI)
 *   npm run set-password -- --user "ETO"    another user (created if missing)
 * Restart the service afterwards so old sessions are dropped.
 */
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { Auth } = require('../lib/auth');

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
  const i = process.argv.indexOf('--user');
  const name = i > 0 ? process.argv[i + 1] : '';
  const auth = new Auth(path.join(DATA, 'users.json'), path.join(DATA, 'admin.json'));
  const who = name || 'Wave AVI (master)';
  const p1 = await ask('New password for ' + who + ': ', true);
  const p2 = await ask('Repeat password: ', true);
  if (p1 !== p2) { console.error('The passwords do not match.'); process.exit(1); }
  try {
    const u = auth.setPasswordOffline(name, p1);
    console.log('Password saved for ' + u.name + '. Restart the service: sudo systemctl restart wave-lighting');
  } catch (e) { console.error(e.message); process.exit(1); }
})();
