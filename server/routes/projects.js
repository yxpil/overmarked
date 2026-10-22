import {
  getProject,
  projectCounts,
  requireProject,
} from '../acl.js';
import { requireUser, requireAdmin } from '../auth.js';
import { tx, parseJsonColumn } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { readJson, sendJson, sendNoContent } from '../http.js';
import { audit, parseAuditRow } from '../audit.js';
import { nowIso, uuid, clampInt, todayIsoDate } from '../util.js';
import { removeProjectFiles } from '../storage.js';
import {
  defaultLabelSchema,
  optionalString,
  requiredString,
  validateLabelSchema,
  validateProjectKind,
  validateRole,
} from '../validation.js';
import { schemaOfProject, serializeMember, serializeProject } from '../serialize.js';

const MEMBER_ROLES = ['manager', 'reviewer', 'annotator'];

function membersOf(db, projectId) {
  return db
    .prepare(
      `SELECT m.*, u.username, u.display_name
         FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = ?
        ORDER BY CASE m.role WHEN 'manager' THEN 0 WHEN 'reviewer' THEN 1 ELSE 2 END, u.username`
    )
    .all(projectId);
}

function managerCount(db, projectId) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM project_members WHERE project_id = ? AND role = 'manager'")
    .get(projectId).c;
}

function collectUsedLabels(db, projectId) {
  const rows = db
    .prepare("SELECT data FROM annotations WHERE project_id = ? AND status != 'draft'")
    .all(projectId);
  const counts = new Map();
  const bump = (id) => {
    if (typeof id === 'string') counts.set(id, (counts.get(id) || 0) + 1);
  };
  for (const row of rows) {
    const data = parseJsonColumn(row.data, {});
    for (const key of ['shapes', 'entities', 'segments', 'features']) {
      if (Array.isArray(data[key])) for (const entry of data[key]) bump(entry.label);
    }
    if (Array.isArray(data.documentLabels)) for (const id of data.documentLabels) bump(id);
  }
  return counts;
}

export function registerProjectRoutes(router) {
  router.get('/api/projects', async (ctx) => {
    const user = requireUser(ctx);
    const kind = ctx.query.get('kind');
    const archived = ctx.query.get('archived');
    if (kind) validateProjectKind(kind);
    if (archived !== null && !['0', '1'].includes(archived)) throw invalid('archived 只能是 0 或 1');

    const params = [];
    let sql;
    if (user.role === 'admin') {
      sql = 'SELECT p.*, NULL AS member_role FROM projects p';
      const clauses = [];
      if (kind) {
        clauses.push('p.kind = ?');
        params.push(kind);
      }
      if (archived !== null) {
        clauses.push('p.archived = ?');
        params.push(Number(archived));
      }
      if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    } else {
      sql = 'SELECT p.*, m.role AS member_role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ?';
      params.push(user.id);
      if (kind) {
        sql += ' AND p.kind = ?';
        params.push(kind);
      }
      if (archived !== null) {
        sql += ' AND p.archived = ?';
        params.push(Number(archived));
      }
    }
    sql += ' ORDER BY p.updated_at DESC';
    const rows = ctx.db.prepare(sql).all(...params);

    const countRows =
      user.role === 'admin'
        ? ctx.db
            .prepare('SELECT project_id, status, COUNT(*) AS c FROM items GROUP BY project_id, status')
            .all()
        : ctx.db
            .prepare(
              `SELECT i.project_id, i.status, COUNT(*) AS c
                 FROM items i JOIN project_members m ON m.project_id = i.project_id AND m.user_id = ?
                GROUP BY i.project_id, i.status`
            )
            .all(user.id);
    const countMap = new Map();
    for (const row of countRows) {
      if (!countMap.has(row.project_id)) {
        countMap.set(row.project_id, {
          total: 0,
          pending: 0,
          in_progress: 0,
          submitted: 0,
          approved: 0,
          rejected: 0,
        });
      }
      const bucket = countMap.get(row.project_id);
      bucket[row.status] = row.c;
      bucket.total += row.c;
    }
    const projects = rows.map((row) =>
      serializeProject(row, {
        role: user.role === 'admin' ? 'admin' : row.member_role,
        counts:
          countMap.get(row.id) || {
            total: 0,
            pending: 0,
            in_progress: 0,
            submitted: 0,
            approved: 0,
            rejected: 0,
          },
      })
    );
    sendJson(ctx.res, 200, { projects });
  });

  router.post('/api/projects', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const name = requiredString(body.name, 'name', { min: 1, max: 80 });
    const kind = validateProjectKind(body.kind);
    const description = optionalString(body.description, 'description', { max: 2000 });
    const labelSchema = body.labelSchema
      ? validateLabelSchema(body.labelSchema)
      : defaultLabelSchema(kind);
    const id = uuid();
    const now = nowIso();
    tx(ctx.db, () => {
      ctx.db
        .prepare(
          `INSERT INTO projects (id, name, description, kind, label_schema, archived, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(id, name, description, kind, JSON.stringify(labelSchema), user.id, now, now);
      ctx.db
        .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'manager', ?)")
        .run(id, user.id, now);
    });
    audit(ctx, 'project.create', 'project', id, { detail: { name, kind }, projectId: id });
    const project = getProject(ctx.db, id);
    sendJson(ctx.res, 201, {
      project: serializeProject(project, { role: user.role === 'admin' ? 'admin' : 'manager' }),
    });
  });

  router.get('/api/projects/:id', async (ctx) => {
    const { project, role } = requireProject(ctx, ctx.params.id, 'view');
    const members = membersOf(ctx.db, project.id);
    const counts = projectCounts(ctx.db, project.id);
    sendJson(ctx.res, 200, {
      project: serializeProject(project, { role, counts }),
      role,
      counts,
      members: members.map(serializeMember),
    });
  });

  router.patch('/api/projects/:id', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'manage');
    const body = await readJson(ctx.req, 4 * 1024 * 1024);
    const updates = [];
    const params = [];
    const detail = {};

    if (body.name !== undefined) {
      const name = requiredString(body.name, 'name', { min: 1, max: 80 });
      updates.push('name = ?');
      params.push(name);
      detail.name = name;
    }
    if (body.description !== undefined) {
      const description = optionalString(body.description, 'description', { max: 2000 });
      updates.push('description = ?');
      params.push(description);
      detail.description = true;
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw invalid('archived 必须是布尔值', { field: 'archived' });
      updates.push('archived = ?');
      params.push(body.archived ? 1 : 0);
      detail.archived = body.archived;
    }
    if (body.labelSchema !== undefined) {
      const schema = validateLabelSchema(body.labelSchema);
      const oldSchema = schemaOfProject(project);
      const nextIds = new Set([
        ...schema.labels.map((l) => l.id),
        ...schema.documentLabels.map((l) => l.id),
      ]);
      const removed = [
        ...oldSchema.labels.map((l) => l.id),
        ...(oldSchema.documentLabels || []).map((l) => l.id),
      ].filter((id) => !nextIds.has(id));
      if (removed.length) {
        const used = collectUsedLabels(ctx.db, project.id);
        const blocked = removed.filter((id) => (used.get(id) || 0) > 0);
        if (blocked.length) {
          throw conflict('仍有标注引用这些标签，无法删除', 'LABEL_IN_USE', {
            labels: blocked,
            count: blocked.reduce((sum, id) => sum + used.get(id), 0),
          });
        }
      }
      updates.push('label_schema = ?');
      params.push(JSON.stringify(schema));
      detail.labelsCount = schema.labels.length;
    }
    if (!updates.length) throw invalid('没有可更新的字段');
    updates.push('updated_at = ?');
    params.push(nowIso(), project.id);
    ctx.db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    audit(ctx, 'project.update', 'project', project.id, { detail, projectId: project.id });
    const fresh = getProject(ctx.db, project.id);
    sendJson(ctx.res, 200, {
      project: serializeProject(fresh, { role: ctx.user.role === 'admin' ? 'admin' : 'manager' }),
    });
  });

  router.delete('/api/projects/:id', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'manage');
    const body = await readJson(ctx.req, 16 * 1024);
    if (body.confirmName !== project.name) {
      throw invalid('请输入完整项目名以确认删除', { field: 'confirmName' });
    }
    await removeProjectFiles(ctx.config, project.id);
    ctx.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    audit(ctx, 'project.delete', 'project', project.id, {
      detail: { name: project.name, kind: project.kind },
      projectId: null,
    });
    sendNoContent(ctx.res);
  });

  router.get('/api/projects/:id/members', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'view');
    sendJson(ctx.res, 200, { members: membersOf(ctx.db, project.id).map(serializeMember) });
  });

  router.post('/api/projects/:id/members', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'manage');
    const body = await readJson(ctx.req, 16 * 1024);
    if (typeof body.userId !== 'string' || !body.userId) throw invalid('userId 必填', { field: 'userId' });
    const role = validateRole(body.role, MEMBER_ROLES, 'annotator');
    const target = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(body.userId);
    if (!target) throw notFound('用户不存在');
    if (target.status !== 'active') throw conflict('不能添加已停用的账号', 'ACCOUNT_DISABLED');
    if (ctx.db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(project.id, target.id)) {
      throw conflict('该用户已是项目成员');
    }
    ctx.db
      .prepare('INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, target.id, role, nowIso());
    audit(ctx, 'member.add', 'member', target.id, {
      detail: { userId: target.id, username: target.username, role },
      projectId: project.id,
    });
    const member = ctx.db
      .prepare(
        'SELECT m.*, u.username, u.display_name FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND m.user_id = ?'
      )
      .get(project.id, target.id);
    sendJson(ctx.res, 201, { member: serializeMember(member) });
  });

  router.patch('/api/projects/:id/members/:userId', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'manage');
    const member = ctx.db
      .prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(project.id, ctx.params.userId);
    if (!member) throw notFound('成员不存在');
    const body = await readJson(ctx.req, 16 * 1024);
    const role = validateRole(body.role, MEMBER_ROLES);
    if (member.role === 'manager' && role !== 'manager' && managerCount(ctx.db, project.id) <= 1) {
      throw conflict('项目至少需要保留一名 manager');
    }
    ctx.db
      .prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?')
      .run(role, project.id, member.user_id);
    audit(ctx, 'member.update', 'member', member.user_id, {
      detail: { from: member.role, to: role },
      projectId: project.id,
    });
    const fresh = ctx.db
      .prepare(
        'SELECT m.*, u.username, u.display_name FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND m.user_id = ?'
      )
      .get(project.id, member.user_id);
    sendJson(ctx.res, 200, { member: serializeMember(fresh) });
  });

  router.delete('/api/projects/:id/members/:userId', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'manage');
    const member = ctx.db
      .prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(project.id, ctx.params.userId);
    if (!member) throw notFound('成员不存在');
    if (member.role === 'manager' && managerCount(ctx.db, project.id) <= 1) {
      throw conflict('项目至少需要保留一名 manager');
    }
    ctx.db
      .prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
      .run(project.id, member.user_id);
    audit(ctx, 'member.remove', 'member', member.user_id, {
      detail: { role: member.role },
      projectId: project.id,
    });
    sendNoContent(ctx.res);
  });

  router.get('/api/projects/:id/stats', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'view');
    const counts = projectCounts(ctx.db, project.id);
    const schema = schemaOfProject(project);
    const nameMap = new Map(schema.labels.map((l) => [l.id, l.name]));
    for (const label of schema.documentLabels || []) nameMap.set(label.id, label.name);

    const annotators = ctx.db
      .prepare(
        `SELECT u.id, u.display_name AS name, COUNT(a.item_id) AS annotated,
                CAST(SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) AS INTEGER) AS approved
           FROM annotations a JOIN users u ON u.id = a.updated_by
          WHERE a.project_id = ?
          GROUP BY u.id ORDER BY annotated DESC`
      )
      .all(project.id);

    const rows = ctx.db
      .prepare("SELECT data FROM annotations WHERE project_id = ? AND status != 'draft'")
      .all(project.id);
    const labelCounts = new Map();
    for (const row of rows) {
      const data = parseJsonColumn(row.data, {});
      for (const key of ['shapes', 'entities', 'segments', 'features']) {
        if (!Array.isArray(data[key])) continue;
        for (const entry of data[key]) {
          if (typeof entry.label === 'string') {
            labelCounts.set(entry.label, (labelCounts.get(entry.label) || 0) + 1);
          }
        }
      }
    }
    const labels = [...labelCounts.entries()]
      .map(([labelId, count]) => ({ labelId, name: nameMap.get(labelId) || labelId, count }))
      .sort((a, b) => b.count - a.count);

    const startDate = todayIsoDate(-13);
    const trendRows = ctx.db
      .prepare(
        `SELECT substr(v.created_at, 1, 10) AS date, v.status, COUNT(*) AS c
           FROM annotation_versions v JOIN items i ON i.id = v.item_id
          WHERE i.project_id = ? AND substr(v.created_at, 1, 10) >= ?
          GROUP BY date, v.status`
      )
      .all(project.id, startDate);
    const trendMap = new Map();
    for (let i = 13; i >= 0; i--) {
      trendMap.set(todayIsoDate(-i), { date: todayIsoDate(-i), submitted: 0, approved: 0 });
    }
    for (const row of trendRows) {
      const entry = trendMap.get(row.date);
      if (!entry) continue;
      if (row.status === 'submitted') entry.submitted += row.c;
      if (row.status === 'approved') entry.approved += row.c;
    }

    sendJson(ctx.res, 200, {
      total: counts.total,
      byStatus: {
        pending: counts.pending,
        in_progress: counts.in_progress,
        submitted: counts.submitted,
        approved: counts.approved,
        rejected: counts.rejected,
      },
      approvedPct: counts.total ? Math.round((counts.approved / counts.total) * 1000) / 10 : 0,
      annotators: annotators.map((row) => ({
        userId: row.id,
        name: row.name,
        annotated: row.annotated,
        approved: row.approved,
      })),
      labels,
      trend: [...trendMap.values()],
    });
  });

  router.get('/api/projects/:id/audit', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'manage');
    const limit = clampInt(ctx.query.get('limit'), 100, 1, 500);
    const rows = ctx.db
      .prepare(
        `SELECT a.*, u.display_name AS actor_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.project_id = ? ORDER BY a.id DESC LIMIT ?`
      )
      .all(project.id, limit);
    sendJson(ctx.res, 200, { entries: rows.map(parseAuditRow) });
  });

  router.get('/api/admin/audit', async (ctx) => {
    requireAdmin(ctx);
    const limit = clampInt(ctx.query.get('limit'), 100, 1, 500);
    const action = String(ctx.query.get('action') || '');
    const actor = String(ctx.query.get('actor') || '');
    const clauses = [];
    const params = [];
    if (action) {
      clauses.push('a.action = ?');
      params.push(action);
    }
    if (actor) {
      clauses.push('(u.username = ? OR u.display_name = ?)');
      params.push(actor, actor);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    const rows = ctx.db
      .prepare(
        `SELECT a.*, u.display_name AS actor_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
           ${where} ORDER BY a.id DESC LIMIT ?`
      )
      .all(...params);
    sendJson(ctx.res, 200, { entries: rows.map(parseAuditRow) });
  });
}
