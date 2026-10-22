import { assertWritable, isManagerRole } from '../acl.js';
import { parseJsonColumn, tx } from '../db.js';
import { conflict, invalid, tooLarge } from '../errors.js';
import { readJson, sendJson } from '../http.js';
import { audit } from '../audit.js';
import { nowIso } from '../util.js';
import { readTextFile } from '../storage.js';
import {
  optionalString,
  requiredString,
  validateAnnotationData,
} from '../validation.js';
import {
  countFigures,
  schemaOfProject,
  serializeAnnotation,
  serializeItem,
  serializeReview,
} from '../serialize.js';
import { annotationRow, itemRow, loadItemAccess } from './items.js';

const MAX_ANNOTATION_BYTES = 4 * 1024 * 1024;

export function registerAnnotationRoutes(router) {
  router.put('/api/items/:id/annotation', async (ctx) => {
    const { row, project, role } = loadItemAccess(ctx, ctx.params.id, 'annotate');
    assertWritable(project);
    if (row.status === 'approved' && !isManagerRole(role)) {
      throw conflict('该条目已通过审核，需由 manager 重新打开后才能修改', 'ITEM_APPROVED');
    }
    const body = await readJson(ctx.req, 8 * 1024 * 1024);
    const schema = schemaOfProject(project);
    const meta = parseJsonColumn(row.meta, {});
    const opts = { crs: meta.crs };
    if (project.kind === 'text') {
      const text = await readTextFile(ctx.config, project.id, row.storage_key, ctx.config.textMaxBytes);
      opts.textLength = text.length;
    }
    if (project.kind === 'audio' && typeof meta.duration === 'number') {
      opts.duration = meta.duration;
    }
    const data = validateAnnotationData(project.kind, body.data, schema, opts);
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > MAX_ANNOTATION_BYTES) {
      throw tooLarge('标注数据不能超过 4 MB');
    }
    const submit = body.submit === true;
    const now = nowIso();
    const existing = annotationRow(ctx.db, row.id);
    const version = (existing?.version || 0) + 1;
    const status = submit ? 'submitted' : 'draft';

    tx(ctx.db, () => {
      if (existing) {
        ctx.db
          .prepare(
            `UPDATE annotations
                SET data = ?, status = ?, version = ?, updated_by = ?, updated_at = ?, submitted_at = ?
              WHERE item_id = ?`
          )
          .run(serialized, status, version, ctx.user.id, now, submit ? now : null, row.id);
      } else {
        ctx.db
          .prepare(
            `INSERT INTO annotations (item_id, project_id, data, status, version, created_by, updated_by, created_at, updated_at, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.id,
            project.id,
            serialized,
            status,
            version,
            ctx.user.id,
            ctx.user.id,
            now,
            now,
            submit ? now : null
          );
      }
      ctx.db
        .prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?')
        .run(submit ? 'submitted' : 'in_progress', now, row.id);
      if (submit) {
        ctx.db
          .prepare(
            `INSERT INTO annotation_versions (item_id, version, data, status, author_id, created_at)
             VALUES (?, ?, ?, 'submitted', ?, ?)`
          )
          .run(row.id, version, serialized, ctx.user.id, now);
      }
    });

    audit(ctx, submit ? 'annotation.submit' : 'annotation.save', 'item', row.id, {
      detail: {
        version,
        figures: countFigures(project.kind, data),
        status,
      },
      projectId: project.id,
    });

    const freshItem = itemRow(ctx.db, row.id);
    const freshAnnotation = annotationRow(ctx.db, row.id);
    sendJson(ctx.res, 200, {
      annotation: serializeAnnotation(freshAnnotation),
      item: serializeItem(freshItem),
    });
  });

  router.get('/api/items/:id/history', async (ctx) => {
    loadItemAccess(ctx, ctx.params.id, 'view');
    const versions = ctx.db
      .prepare(
        `SELECT v.version, v.status, v.author_id, v.created_at, u.display_name AS author_name
           FROM annotation_versions v LEFT JOIN users u ON u.id = v.author_id
          WHERE v.item_id = ? ORDER BY v.version DESC LIMIT 100`
      )
      .all(ctx.params.id);
    const reviews = ctx.db
      .prepare(
        `SELECT r.*, u.display_name AS reviewer_name
           FROM reviews r LEFT JOIN users u ON u.id = r.reviewer_id
          WHERE r.item_id = ? ORDER BY r.id DESC`
      )
      .all(ctx.params.id);
    sendJson(ctx.res, 200, {
      versions: versions.map((v) => ({
        version: v.version,
        status: v.status,
        authorId: v.author_id,
        authorName: v.author_name,
        createdAt: v.created_at,
      })),
      reviews: reviews.map(serializeReview),
    });
  });

  router.post('/api/items/:id/review', async (ctx) => {
    const { row, project, role } = loadItemAccess(ctx, ctx.params.id, 'review');
    assertWritable(project);
    const body = await readJson(ctx.req, 64 * 1024);
    const decision =
      body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : null;
    if (!decision) throw invalid('decision 必须是 approve 或 reject', { field: 'decision' });
    if (row.status === 'approved') {
      if (!isManagerRole(role)) throw conflict('只有 manager 可以撤销通过', 'INVALID_STATE');
    } else if (row.status !== 'submitted') {
      throw conflict('仅已提交的条目可以复核', 'INVALID_STATE');
    }
    const note =
      decision === 'rejected'
        ? requiredString(body.note, 'note', { min: 1, max: 2000 })
        : optionalString(body.note, 'note', { max: 2000 });
    const existing = annotationRow(ctx.db, row.id);
    if (!existing) throw conflict('该条目尚无标注可复核', 'INVALID_STATE');
    const now = nowIso();
    const version = existing.version + 1;
    let reviewId;
    tx(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE annotations SET status = ?, version = ?, reviewed_at = ?, updated_at = ? WHERE item_id = ?`
        )
        .run(decision, version, now, now, row.id);
      ctx.db
        .prepare(
          'UPDATE items SET status = ?, updated_at = ? WHERE id = ?'
        )
        .run(decision, now, row.id);
      const result = ctx.db
        .prepare(
          'INSERT INTO reviews (item_id, reviewer_id, decision, note, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(row.id, ctx.user.id, decision, note, now);
      reviewId = Number(result.lastInsertRowid);
      ctx.db
        .prepare(
          `INSERT INTO annotation_versions (item_id, version, data, status, author_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(row.id, version, existing.data, decision, ctx.user.id, now);
    });
    audit(ctx, decision === 'approved' ? 'review.approve' : 'review.reject', 'item', row.id, {
      detail: { note: note.slice(0, 500), version },
      projectId: project.id,
    });
    const freshItem = itemRow(ctx.db, row.id);
    const freshAnnotation = annotationRow(ctx.db, row.id);
    const review = ctx.db
      .prepare(
        `SELECT r.*, u.display_name AS reviewer_name FROM reviews r LEFT JOIN users u ON u.id = r.reviewer_id WHERE r.id = ?`
      )
      .get(reviewId);
    sendJson(ctx.res, 200, {
      item: serializeItem(freshItem),
      annotation: serializeAnnotation(freshAnnotation),
      review: serializeReview(review),
    });
  });
}
