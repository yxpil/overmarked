import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from './security.js';
import { nowIso, randomToken, sha256, uuid } from './util.js';
import { HttpError, forbidden, unauthenticated } from './errors.js';

export const SESSION_COOKIE = 'om_session';

export function serializeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function countActiveAdmins(db) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'")
    .get().c;
}

export function isLastActiveAdmin(db, userId) {
  const user = db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(userId);
  if (!user || user.role !== 'admin' || user.status !== 'active') return false;
  return countActiveAdmins(db) <= 1;
}

export function ensureAdmin(db, config) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (c > 0) return null;
  const password = config.adminPassword || randomToken(12);
  const username = config.adminUsername || 'admin';
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, status, created_at)
     VALUES (?, ?, ?, ?, 'admin', 'active', ?)`
  ).run(uuid(), username, '管理员', hashPassword(password), now);

  let passwordFile = null;
  if (!config.adminPassword) {
    passwordFile = path.join(config.dataDir, 'initial-admin.txt');
    fs.writeFileSync(
      passwordFile,
      `OVERMARKED 初始管理员\n用户名: ${username}\n密码: ${password}\n登录后请立即修改密码并删除此文件。\n`,
      { mode: 0o600 }
    );
  }
  return { username, password, passwordFile };
}

export function createSession(db, userId, { ip, userAgent, days }) {
  const token = randomToken(32);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sha256(token), userId, createdAt, expiresAt, ip || '', String(userAgent || '').slice(0, 300));
  return { token, expiresAt };
}

export function getUserBySession(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`
    )
    .get(sha256(token), nowIso());
  return row || null;
}

export function deleteSession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function deleteUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function pruneSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}

export function sessionCookie(token, config) {
  const maxAge = config.sessionDays * 86400;
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(config) {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthenticated();
  return ctx.user;
}

export function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') throw forbidden('仅系统管理员可执行此操作');
  return user;
}

export function verifyUserPassword(row, password) {
  return verifyPassword(password, row.password_hash);
}

export function createLoginLimiter({ windowMs = 10 * 60 * 1000, max = 8 } = {}) {
  const state = new Map();

  function entry(key, now) {
    const existing = state.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh = { failures: 0, resetAt: now + windowMs };
      state.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  return {
    check(key) {
      const now = Date.now();
      const e = entry(key, now);
      if (e.failures >= max) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
      }
      return { ok: true };
    },
    fail(key) {
      const now = Date.now();
      const e = entry(key, now);
      e.failures += 1;
    },
    reset(key) {
      state.delete(key);
    },
    throttle(key) {
      const now = Date.now();
      const e = entry(key, now);
      e.failures = Math.max(e.failures, max);
      return Math.max(1, Math.ceil((e.resetAt - now) / 1000));
    },
    sweep() {
      const now = Date.now();
      for (const [key, value] of state) if (value.resetAt <= now) state.delete(key);
    },
    size() {
      return state.size;
    },
  };
}

export function rateLimited(retryAfter) {
  const error = new HttpError(429, 'RATE_LIMITED', '尝试次数过多，请稍后再试');
  error.retryAfter = retryAfter;
  return error;
}

export function safeEqualUser(a, b) {
  return a && b && a.id === b.id;
}

export { randomBytes };
