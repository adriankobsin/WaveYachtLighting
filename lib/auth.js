'use strict';
const crypto = require('crypto');
const fs = require('fs');

const SESSION_HOURS = 12;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { algo: 'scrypt', N: 16384, r: 8, p: 1, salt, hash };
}

function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = crypto.scryptSync(String(password), rec.salt, 64, { N: rec.N || 16384, r: rec.r || 8, p: rec.p || 1 });
  const want = Buffer.from(rec.hash, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(want, h);
}

class Auth {
  constructor(file) {
    this.file = file;
    this.sessions = new Map();
    this.attempts = new Map();
  }
  record() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return null; } }
  configured() { return !!this.record(); }

  /** Returns a session token, or throws with a message for the user. */
  login(password, ip) {
    const now = Date.now();
    const a = (this.attempts.get(ip) || []).filter((t) => now - t < 60000);
    if (a.length >= 5) throw Object.assign(new Error('Too many attempts. Wait a minute and try again'), { status: 429 });
    if (!verifyPassword(password, this.record())) {
      a.push(now); this.attempts.set(ip, a);
      throw Object.assign(new Error('Wrong password'), { status: 401 });
    }
    this.attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, now + SESSION_HOURS * 3600 * 1000);
    return token;
  }
  check(token) {
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) { this.sessions.delete(token); return false; }
    return true;
  }
  logout(token) { this.sessions.delete(token); }
}

module.exports = { Auth, hashPassword, verifyPassword };
