import { conflict, forbidden, notFound } from './errors.js';

const NEEDS = {
  view: ['manager', 'reviewer', 'annotator'],
  annotate: ['manager', 'reviewer', 'annotator'],
  review: ['manager', 'reviewer'],
  manage: ['manager'],
};

export function getProject(db, projectId) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) || null;
}

export function getMember(db, projectId, userId) {
  return (
    db
      .prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, userId) || null
  );
}

export function effectiveRole(db, project, user) {
  if (!project || !user) return null;
  if (user.role === 'admin') return 'admin';
  return getMember(db, project.id, user.id)?.role || null;
}

export function roleAllows(role, need) {
  if (!role) return false;
  if (role === 'admin') return true;
  return (NEEDS[need] || []).includes(role);
}

export function requireProject(ctx, projectId, need = 'view') {
  const project = getProject(ctx.db, projectId);
  if (!project) throw notFound('项目不存在');
  const role = effectiveRole(ctx.db, project, ctx.user);
  if (!roleAllows(role, need)) throw forbidden('没有该项目的操作权限');
  return { project, role };
}

export function assertWritable(project) {
  if (project.archived) throw conflict('项目已归档，当前为只读', 'PROJECT_ARCHIVED');
}

export function isManagerRole(role) {
  return role === 'admin' || role === 'manager';
}

export function canReviewRole(role) {
  return role === 'admin' || role === 'manager' || role === 'reviewer';
}

export function projectCounts(db, projectId) {
  const counts = {
    total: 0,
    pending: 0,
    in_progress: 0,
    submitted: 0,
    approved: 0,
    rejected: 0,
  };
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM items WHERE project_id = ? GROUP BY status')
    .all(projectId);
  for (const row of rows) {
    counts[row.status] = row.c;
    counts.total += row.c;
  }
  return counts;
}
