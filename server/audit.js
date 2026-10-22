import { nowIso } from './util.js';

export function audit(ctx, action, entity, entityId, { detail = {}, projectId = null } = {}) {
  try {
    let payload = '{}';
    try {
      payload = JSON.stringify(detail ?? {});
    } catch {
      payload = '{}';
    }
    if (payload.length > 8000) payload = JSON.stringify({ truncated: true });
    ctx.db
      .prepare(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, project_id, detail, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ctx.user?.id || null,
        action,
        entity,
        entityId || null,
        projectId || null,
        payload,
        ctx.ip || '',
        nowIso()
      );
  } catch (error) {
    console.error('[audit] write failed:', error.message);
  }
}

export function parseAuditRow(row) {
  let detail = {};
  try {
    detail = row.detail ? JSON.parse(row.detail) : {};
  } catch {
    detail = {};
  }
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name || null,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    projectId: row.project_id,
    detail,
    ip: row.ip,
    createdAt: row.created_at,
  };
}
