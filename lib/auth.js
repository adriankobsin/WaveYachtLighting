'use strict';
/**
 * Admin users and sessions.
 *
 * data/users.json holds the users. The master account ("Wave AVI") always
 * exists and cannot be deleted; only the master can change the master
 * password. Other users (engineer, ETO…) have full admin access otherwise.
 * Passwords are stored as scrypt hashes. Login is by password only, so every
 * user's password must be different.
 */
const crypto = require('crypto');
const fs = require('fs');

const SESSION_HOURS = 12;
const MIN_LENGTH = 8;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { algo: 'scrypt', N: 16384, r: 8, p: 1, salt, hash };
}

function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = crypto.scryptSync(String(password), rec.salt, 64, { N: rec.N || 16384, r: rec.r || 8, p: rec.p || 1 });
  const want = Buffer.from(rec.hash, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(want, h);
}

function fail(message, status) { return Object.assign(new Error(message), { status: status || 400 }); }

class Auth {
  /**
   * @param {string} usersFile   data/users.json
   * @param {string} legacyFile  data/admin.json (single master hash from v1.0), migrated once
   */
  constructor(usersFile, legacyFile) {
    this.file = usersFile;
    this.sessions = new Map(); // token -> { userId, exp }
    this.attempts = new Map();
    if (!fs.existsSync(usersFile) && legacyFile && fs.existsSync(legacyFile)) {
      try {
        const rec = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
        this._write({ users: [Object.assign({ id: 'master', name: 'Wave AVI', master: true, createdAt: new Date().toISOString() }, { password: rec })] });
      } catch (e) { /* leave unconfigured */ }
    }
  }

  _read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return { users: [] }; } }
  _write(db) { fs.writeFileSync(this.file + '.tmp', JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  configured() { return this._read().users.some((u) => u.master); }

  publicUser(u) { return u ? { id: u.id, name: u.name, master: !!u.master, createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null, passwordChangedAt: u.passwordChangedAt || null } : null; }
  list() { return this._read().users.map((u) => this.publicUser(u)); }

  _checkNew(db, password, exceptId) {
    password = String(password || '');
    if (password.length < MIN_LENGTH) throw fail('Use at least ' + MIN_LENGTH + ' characters');
    if (password.length > 200) throw fail('That password is too long');
    // Login is by password only, so two users cannot share one.
    if (db.users.some((u) => u.id !== exceptId && verifyPassword(password, u.password))) throw fail('Another user already has that password. Choose a different one');
    return password;
  }
  _cleanName(name) {
    const n = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!n) throw fail('Enter a name');
    return n;
  }

  /** Returns { token, user }. */
  login(password, ip) {
    const now = Date.now();
    const a = (this.attempts.get(ip) || []).filter((t) => now - t < 60000);
    if (a.length >= 5) throw fail('Too many attempts. Wait a minute and try again', 429);
    const db = this._read();
    const user = db.users.find((u) => verifyPassword(password, u.password));
    if (!user) {
      a.push(now); this.attempts.set(ip, a);
      throw fail('Wrong password', 401);
    }
    this.attempts.delete(ip);
    user.lastLoginAt = new Date().toISOString();
    this._write(db);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { userId: user.id, exp: now + SESSION_HOURS * 3600 * 1000 });
    return { token, user: this.publicUser(user) };
  }

  /** The logged-in user for a session token, or null. */
  user(token) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.exp < Date.now()) { this.sessions.delete(token); return null; }
    const u = this._read().users.find((x) => x.id === s.userId);
    if (!u) { this.sessions.delete(token); return null; }
    return this.publicUser(u);
  }
  check(token) { return !!this.user(token); }
  logout(token) { this.sessions.delete(token); }
  _dropSessions(userId, keepToken) { for (const [t, s] of this.sessions) if (s.userId === userId && t !== keepToken) this.sessions.delete(t); }

  addUser(actor, name, password) {
    const db = this._read();
    const n = this._cleanName(name);
    if (db.users.some((u) => u.name.toLowerCase() === n.toLowerCase())) throw fail('There is already a user called ' + n);
    if (db.users.length >= 20) throw fail('Up to 20 users');
    const pw = this._checkNew(db, password);
    const u = { id: 'u' + crypto.randomBytes(6).toString('hex'), name: n, master: false, password: hashPassword(pw), createdAt: new Date().toISOString(), createdBy: actor.name, passwordChangedAt: new Date().toISOString() };
    db.users.push(u);
    this._write(db);
    return this.publicUser(u);
  }

  renameUser(actor, id, name) {
    const db = this._read();
    const u = db.users.find((x) => x.id === id);
    if (!u) throw fail('User not found', 404);
    if (u.master) throw fail('The master account name cannot be changed', 403);
    const n = this._cleanName(name);
    if (db.users.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) throw fail('There is already a user called ' + n);
    u.name = n;
    this._write(db);
    return this.publicUser(u);
  }

  /**
   * Changing your own password needs your current one. Admins can set a new
   * password for other users, except the master, which only the master can change.
   */
  setPassword(actor, id, password, currentPassword, actorToken) {
    const db = this._read();
    const u = db.users.find((x) => x.id === id);
    if (!u) throw fail('User not found', 404);
    const self = actor.id === id;
    if (u.master && !self) throw fail('Only the Wave AVI master account can change the master password', 403);
    if (self && !verifyPassword(currentPassword, u.password)) throw fail('Your current password is wrong', 401);
    const pw = this._checkNew(db, password, id);
    u.password = hashPassword(pw);
    u.passwordChangedAt = new Date().toISOString();
    this._write(db);
    this._dropSessions(id, self ? actorToken : null);
    return this.publicUser(u);
  }

  deleteUser(actor, id) {
    const db = this._read();
    const u = db.users.find((x) => x.id === id);
    if (!u) throw fail('User not found', 404);
    if (u.master) throw fail('The master account cannot be deleted', 403);
    if (actor.id === id) throw fail('You cannot delete the account you are logged in with', 400);
    db.users = db.users.filter((x) => x.id !== id);
    this._write(db);
    this._dropSessions(id);
  }

  /** Command-line use (npm run set-password): set or create a user's password without logging in. */
  setPasswordOffline(name, password) {
    const db = this._read();
    let u = name ? db.users.find((x) => x.name.toLowerCase() === String(name).toLowerCase()) : db.users.find((x) => x.master);
    const pw = this._checkNew(db, password, u && u.id);
    if (!u) {
      u = name
        ? { id: 'u' + crypto.randomBytes(6).toString('hex'), name: this._cleanName(name), master: false, createdAt: new Date().toISOString() }
        : { id: 'master', name: 'Wave AVI', master: true, createdAt: new Date().toISOString() };
      db.users.push(u);
    }
    u.password = hashPassword(pw);
    u.passwordChangedAt = new Date().toISOString();
    this._write(db);
    return this.publicUser(u);
  }
}

module.exports = { Auth, hashPassword, verifyPassword, MIN_LENGTH };
