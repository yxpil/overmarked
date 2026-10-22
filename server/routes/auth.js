import {
  createSession,
  deleteSession,
  deleteUserSessions,
  getUserBySession,
  requireUser,
  serializeUser,
  sessionCookie,
  clearSessionCookie,
  verifyUserPassword,
  rateLimited,
} from '../auth.js';
import { hashPassword, burnPasswordCheck } from '../security.js';
import { nowIso } from '../util.js';
import { readJson, sendJson, sendNoContent } from '../http.js';
import { HttpError } from '../errors.js';
import { validatePassword, validateUsername } from '../validation.js';
import { audit } from '../audit.js';

export function registerAuthRoutes(router) {
  router.post('/api/auth/login', async (ctx) => {
    const body = await readJson(ctx.req, 16 * 1024);
    let username;
    try {
      username = validateUsername(body.username);
    } catch {
      throw new HttpError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${ctx.ip}|${username.toLowerCase()}`;
    const gate = ctx.limiter.check(key);
    if (!gate.ok) throw rateLimited(gate.retryAfter);

    const row = ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    let passwordOk = false;
    if (row) {
      passwordOk = verifyUserPassword(row, password);
    } else {
      burnPasswordCheck(password);
    }
    if (!row || !passwordOk) {
      ctx.limiter.fail(key);
      audit(ctx, 'auth.login_failed', 'user', row?.id || null, {
        detail: { username, reason: 'invalid_credentials' },
      });
      throw new HttpError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }
    if (row.status !== 'active') {
      ctx.limiter.fail(key);
      throw new HttpError(403, 'ACCOUNT_DISABLED', '账号已停用，请联系管理员');
    }
    ctx.limiter.reset(key);
    ctx.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
    const { token } = createSession(ctx.db, row.id, {
      ip: ctx.ip,
      userAgent: ctx.req.headers['user-agent'],
      days: ctx.config.sessionDays,
    });
    ctx.user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    audit(ctx, 'auth.login', 'user', row.id, { detail: { username: row.username } });
    sendJson(
      ctx.res,
      200,
      { user: serializeUser(ctx.user) },
      { 'Set-Cookie': sessionCookie(token, ctx.config) }
    );
  });

  router.post('/api/auth/logout', async (ctx) => {
    requireUser(ctx);
    deleteSession(ctx.db, ctx.cookies.om_session);
    audit(ctx, 'auth.logout', 'user', ctx.user.id);
    sendNoContent(ctx.res, { 'Set-Cookie': clearSessionCookie(ctx.config) });
  });

  router.get('/api/auth/me', async (ctx) => {
    const user = requireUser(ctx);
    sendJson(ctx.res, 200, { user: serializeUser(user) });
  });

  router.post('/api/auth/password', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req, 16 * 1024);
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!verifyUserPassword(user, current)) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', '当前密码错误');
    }
    const next = validatePassword(body.newPassword, 'newPassword');
    ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    deleteUserSessions(ctx.db, user.id);
    audit(ctx, 'auth.password', 'user', user.id);
    sendNoContent(ctx.res, { 'Set-Cookie': clearSessionCookie(ctx.config) });
  });
}

export function attachSession(db, cookies) {
  const token = cookies.om_session;
  if (!token) return null;
  return getUserBySession(db, token) || null;
}
