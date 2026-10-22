import { hashPassword } from '../security.js';
import { nowIso, uuid } from '../util.js';
import { readJson, sendJson } from '../http.js';
import { conflict, invalid, notFound } from '../errors.js';
import {
  isLastActiveAdmin,
  requireAdmin,
  requireUser,
  serializeUser,
  deleteUserSessions,
} from '../auth.js';
import {
  requiredString,
  validatePassword,
  validateRole,
  validateUsername,
} from '../validation.js';
import { audit } from '../audit.js';

const USER_ROLES = ['admin', 'user'];
const USER_STATUSES = ['active', 'disabled'];

function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function registerUserRoutes(router) {
  router.get('/api/directory', async (ctx) => {
    requireUser(ctx);
    const q = String(ctx.query.get('q') || '').trim();
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = ctx.db
      .prepare(
        `SELECT id, username, display_name FROM users
          WHERE status = 'active' AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
          ORDER BY username COLLATE NOCASE LIMIT 20`
      )
      .all(like, like);
    sendJson(ctx.res, 200, {
      users: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name })),
    });
  });

  router.get('/api/users', async (ctx) => {
    requireAdmin(ctx);
    const q = String(ctx.query.get('q') || '').trim();
    const status = ctx.query.get('status');
    const clauses = [];
    const params = [];
    if (q) {
      clauses.push("(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like);
    }
    if (status) {
      if (!USER_STATUSES.includes(status)) throw invalid('status 非法');
      clauses.push('status = ?');
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = ctx.db.prepare(`SELECT * FROM users ${where} ORDER BY created_at ASC`).all(...params);
    sendJson(ctx.res, 200, { users: rows.map(serializeUser) });
  });

  router.post('/api/users', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const username = validateUsername(body.username);
    const displayName = requiredString(body.displayName ?? username, 'displayName', { min: 1, max: 40 });
    const password = validatePassword(body.password);
    const role = validateRole(body.role, USER_ROLES, 'user');
    if (ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      throw conflict('用户名已存在');
    }
    const id = uuid();
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      )
      .run(id, username, displayName, hashPassword(password), role, now);
    audit(ctx, 'user.create', 'user', id, { detail: { username, role } });
    sendJson(ctx.res, 201, { user: serializeUser(getUser(ctx.db, id)) });
  });

  router.patch('/api/users/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const target = getUser(ctx.db, ctx.params.id);
    if (!target) throw notFound('用户不存在');
    const body = await readJson(ctx.req);
    const updates = [];
    const params = [];
    let revokeSessions = false;
    let detail = {};

    if (body.displayName !== undefined) {
      const displayName = requiredString(body.displayName, 'displayName', { min: 1, max: 40 });
      updates.push('display_name = ?');
      params.push(displayName);
      detail.displayName = displayName;
    }
    if (body.role !== undefined) {
      const role = validateRole(body.role, USER_ROLES);
      if (role !== 'admin' && isLastActiveAdmin(ctx.db, target.id)) {
        throw conflict('不能降级最后一个启用中的管理员');
      }
      updates.push('role = ?');
      params.push(role);
      detail.role = role;
    }
    if (body.status !== undefined) {
      if (!USER_STATUSES.includes(body.status)) throw invalid('status 非法', { field: 'status' });
      if (body.status === 'disabled' && target.id === admin.id) {
        throw conflict('不能停用当前登录的账号');
      }
      if (body.status !== 'active' && isLastActiveAdmin(ctx.db, target.id)) {
        throw conflict('不能停用最后一个启用中的管理员');
      }
      updates.push('status = ?');
      params.push(body.status);
      if (body.status !== 'active') revokeSessions = true;
      detail.status = body.status;
    }
    if (body.password !== undefined) {
      const password = validatePassword(body.password);
      updates.push('password_hash = ?');
      params.push(hashPassword(password));
      revokeSessions = true;
      detail.passwordReset = true;
    }
    if (!updates.length) throw invalid('没有可更新的字段');
    params.push(target.id);
    ctx.db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (revokeSessions) deleteUserSessions(ctx.db, target.id);
    audit(ctx, 'user.update', 'user', target.id, { detail });
    sendJson(ctx.res, 200, { user: serializeUser(getUser(ctx.db, target.id)) });
  });

  router.delete('/api/users/:id', async () => {
    throw conflict('v1 不支持删除用户，请停用账号以保留审计与标注归属', 'NOT_IMPLEMENTED');
  });
}
