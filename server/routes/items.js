import fs from 'node:fs';
import { assertWritable, isManagerRole, requireProject, roleAllows } from '../acl.js';
import { tx, parseJsonColumn } from '../db.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { readJson, sendJson, sendNoContent, parseRange } from '../http.js';
import { audit } from '../audit.js';
import { clampInt, nowIso, uuid } from '../util.js';
import {
  assertAllowedForKind,
  contentTypeForItem,
  extensionOf,
  inspectStoredFile,
  maxBytesFor,
  removeStoredFile,
  resolveStoredPath,
  sanitizeOriginalName,
  saveUpload,
} from '../storage.js';
import {
  validateMetaPatch,
  validateStatusFilter,
} from '../validation.js';
import {
  serializeAnnotation,
  serializeItem,
  serializeReview,
} from '../serialize.js';

const ITEM_SELECT = `
  SELECT i.*, a.display_name AS assignee_name, up.display_name AS uploaded_by_name,
         an.status AS annotation_status, an.version AS annotation_version
    FROM items i
    LEFT JOIN users a  ON a.id = i.assignee_id
    LEFT JOIN users up ON up.id = i.uploaded_by
    LEFT JOIN annotations an ON an.item_id = i.id
`;

export function itemRow(db, id) {
  return db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) || null;
}

export function annotationRow(db, itemId) {
  return (
    db
      .prepare(
        `SELECT an.*, u.display_name AS updated_by_name
           FROM annotations an LEFT JOIN users u ON u.id = an.updated_by
          WHERE an.item_id = ?`
      )
      .get(itemId) || null
  );
}

export function loadItemAccess(ctx, itemId, need) {
  const row = itemRow(ctx.db, itemId);
  if (!row) throw notFound('条目不存在');
  const { project, role } = requireProject(ctx, row.project_id, need);
  return { row, project, role };
}

function itemDetailPayload(ctx, row, role, project) {
  const annotation = annotationRow(ctx.db, row.id);
  const reviews = ctx.db
    .prepare(
      `SELECT r.*, u.display_name AS reviewer_name
         FROM reviews r LEFT JOIN users u ON u.id = r.reviewer_id
        WHERE r.item_id = ? ORDER BY r.id DESC LIMIT 20`
    )
    .all(row.id);
  const canAnnotate =
    roleAllows(role, 'annotate') &&
    !project.archived &&
    (row.status !== 'approved' || isManagerRole(role));
  return {
    item: serializeItem(row),
    annotation: serializeAnnotation(annotation),
    reviews: reviews.map(serializeReview),
    can: {
      annotate: canAnnotate,
      review:
        roleAllows(role, 'review') &&
        !project.archived &&
        (row.status === 'submitted' || (row.status === 'approved' && isManagerRole(role))),
      manage: roleAllows(role, 'manage') && !project.archived,
    },
  };
}

export function registerItemRoutes(router) {
  router.get('/api/projects/:id/items', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'view');
    const statusList = validateStatusFilter(ctx.query.get('status'));
    const q = String(ctx.query.get('q') || '').trim();
    const assignee = String(ctx.query.get('assignee') || '').trim();
    const page = clampInt(ctx.query.get('page'), 1, 1, 1e6);
    const limit = clampInt(ctx.query.get('limit'), 50, 1, 200);

    const clauses = ['i.project_id = ?'];
    const params = [project.id];
    if (statusList) {
      clauses.push(`i.status IN (${statusList.map(() => '?').join(',')})`);
      params.push(...statusList);
    }
    if (q) {
      clauses.push("i.original_name LIKE ? ESCAPE '\\'");
      params.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    if (assignee) {
      clauses.push('i.assignee_id = ?');
      params.push(assignee === 'me' ? ctx.user.id : assignee);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const { c } = ctx.db.prepare(`SELECT COUNT(*) AS c FROM items i ${where}`).get(...params);
    const rows = ctx.db
      .prepare(`${ITEM_SELECT} ${where} ORDER BY i.seq ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, (page - 1) * limit);
    sendJson(ctx.res, 200, {
      items: rows.map((row) => serializeItem(row)),
      page,
      limit,
      total: c,
    });
  });

  router.post('/api/projects/:id/items', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'annotate');
    assertWritable(project);
    const rawName = ctx.query.get('filename');
    if (!rawName) throw invalid('缺少 filename 查询参数', { field: 'filename' });
    const filename = sanitizeOriginalName(rawName);
    const ext = assertAllowedForKind(project.kind, filename);
    const maxBytes = maxBytesFor(ctx.config, project.kind, ext);
    const stored = await saveUpload(ctx.req, {
      config: ctx.config,
      projectId: project.id,
      filename,
      maxBytes,
    });
    let meta = {};
    try {
      meta = await inspectStoredFile({
        kind: project.kind,
        ext,
        filePath: resolveStoredPath(ctx.config, project.id, stored.storageKey),
        size: stored.size,
      });
    } catch (error) {
      await removeStoredFile(ctx.config, project.id, stored.storageKey).catch(() => {});
      throw error;
    }
    const now = nowIso();
    const id = tx(ctx.db, () => {
      const seq =
        ctx.db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM items WHERE project_id = ?')
          .get(project.id).next;
      const itemId = uuid();
      ctx.db
        .prepare(
          `INSERT INTO items (id, project_id, seq, original_name, storage_key, mime, size, meta, status, assignee_id, uploaded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`
        )
        .run(
          itemId,
          project.id,
          seq,
          filename,
          stored.storageKey,
          stored.mime,
          stored.size,
          JSON.stringify(meta),
          ctx.user.id,
          now,
          now
        );
      return itemId;
    });
    audit(ctx, 'item.upload', 'item', id, {
      detail: { filename, size: stored.size, seq: itemRow(ctx.db, id)?.seq },
      projectId: project.id,
    });
    const row = itemRow(ctx.db, id);
    sendJson(ctx.res, 201, {
      item: serializeItem(row),
      annotation: null,
    });
  });

  router.get('/api/items/:id', async (ctx) => {
    const { row, project, role } = loadItemAccess(ctx, ctx.params.id, 'view');
    sendJson(ctx.res, 200, itemDetailPayload(ctx, row, role, project));
  });

  router.patch('/api/items/:id', async (ctx) => {
    const { row, project, role } = loadItemAccess(ctx, ctx.params.id, 'annotate');
    assertWritable(project);
    const body = await readJson(ctx.req, 256 * 1024);
    const updates = [];
    const params = [];

    if (body.status !== undefined) {
      if (!roleAllows(role, 'manage')) throw forbidden('只有 manager 可以修改条目状态');
      if (body.status !== 'in_progress') throw invalid('手工状态只能设置为 in_progress', { field: 'status' });
      if (!['pending', 'submitted', 'approved', 'rejected', 'in_progress'].includes(row.status)) {
        throw conflict('当前状态不允许重新打开', 'INVALID_STATE');
      }
      if (row.status !== 'in_progress') {
        const now = nowIso();
        ctx.db
          .prepare("UPDATE annotations SET status = 'draft', version = version + 1, updated_at = ? WHERE item_id = ?")
          .run(now, row.id);
        audit(ctx, 'item.status', 'item', row.id, {
          detail: { from: row.status, to: 'in_progress' },
          projectId: project.id,
        });
      }
      updates.push('status = ?');
      params.push('in_progress');
    }

    if (body.assigneeId !== undefined) {
      let assigneeId = body.assigneeId;
      if (assigneeId !== null && typeof assigneeId !== 'string') {
        throw invalid('assigneeId 必须是用户 id 或 null', { field: 'assigneeId' });
      }
      if (assigneeId !== null) {
        if (!roleAllows(role, 'manage') && assigneeId !== ctx.user.id) {
          throw forbidden('只能将任务指派给自己');
        }
        const member = ctx.db
          .prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?')
          .get(project.id, assigneeId);
        if (!member) throw invalid('指派对象不是项目成员', { field: 'assigneeId' });
      }
      updates.push('assignee_id = ?');
      params.push(assigneeId);
      audit(ctx, 'item.assign', 'item', row.id, {
        detail: { from: row.assignee_id, to: assigneeId },
        projectId: project.id,
      });
    }

    if (body.meta !== undefined) {
      const current = parseJsonColumn(row.meta, {});
      const next = validateMetaPatch(project.kind, current, body.meta);
      updates.push('meta = ?');
      params.push(JSON.stringify(next));
      audit(ctx, 'item.meta', 'item', row.id, {
        detail: { keys: Object.keys(body.meta) },
        projectId: project.id,
      });
    }

    if (!updates.length) throw invalid('没有可更新的字段');
    updates.push('updated_at = ?');
    params.push(nowIso(), row.id);
    ctx.db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const fresh = itemRow(ctx.db, row.id);
    sendJson(ctx.res, 200, {
      item: serializeItem(fresh),
    });
  });

  router.delete('/api/items/:id', async (ctx) => {
    const { row, project } = loadItemAccess(ctx, ctx.params.id, 'manage');
    assertWritable(project);
    ctx.db.prepare('DELETE FROM items WHERE id = ?').run(row.id);
    await removeStoredFile(ctx.config, project.id, row.storage_key).catch((error) => {
      console.error('[storage] failed to remove file:', error.message);
    });
    audit(ctx, 'item.delete', 'item', row.id, {
      detail: { filename: row.original_name, seq: row.seq },
      projectId: project.id,
    });
    sendNoContent(ctx.res);
  });

  router.get('/api/items/:id/file', async (ctx) => {
    const { row, project } = loadItemAccess(ctx, ctx.params.id, 'view');
    const filePath = resolveStoredPath(ctx.config, project.id, row.storage_key);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) throw notFound('原始文件缺失');
    const ext = extensionOf(row.original_name);
    const contentType = contentTypeForItem(project.kind, ext);
    const total = stat.size;
    const range = parseRange(ctx.req.headers.range, total);
    if (range?.invalid) {
      ctx.res.writeHead(416, {
        'Content-Range': `bytes */${total}`,
        'Content-Type': 'text/plain; charset=utf-8',
      });
      ctx.res.end('Range Not Satisfiable');
      return;
    }
    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    };
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`;
      headers['Content-Length'] = range.end - range.start + 1;
      ctx.res.writeHead(206, headers);
      fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(ctx.res);
    } else {
      headers['Content-Length'] = total;
      ctx.res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(ctx.res);
    }
  });
}
