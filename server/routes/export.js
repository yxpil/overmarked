import { requireProject } from '../acl.js';
import { parseJsonColumn } from '../db.js';
import { invalid } from '../errors.js';
import { audit } from '../audit.js';
import { readTextFile } from '../storage.js';
import { schemaOfProject } from '../serialize.js';

const DEFAULT_FORMAT = { image: 'coco', text: 'ner', audio: 'audio', spatial: 'geojson' };

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function polygonBBox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

function buildCoco(project, rows, schema) {
  const categories = schema.labels.map((label, index) => ({
    id: index + 1,
    name: label.name,
    color: label.color,
  }));
  const catId = new Map(schema.labels.map((label, index) => [label.id, index + 1]));
  const images = [];
  const annotations = [];
  let annId = 1;
  for (const row of rows) {
    const data = parseJsonColumn(row.ann_data, {});
    const meta = parseJsonColumn(row.meta, {});
    images.push({
      id: row.seq,
      file_name: row.original_name,
      width: meta.width || 0,
      height: meta.height || 0,
    });
    for (const shape of data.shapes || []) {
      const categoryId = catId.get(shape.label);
      if (!categoryId) continue;
      if (shape.type === 'box') {
        annotations.push({
          id: annId++,
          image_id: row.seq,
          category_id: categoryId,
          bbox: [shape.x, shape.y, shape.w, shape.h],
          area: shape.w * shape.h,
          iscrowd: 0,
          segmentation: [],
        });
      } else {
        const points = shape.points || [];
        if (points.length < 3) continue;
        const bbox = polygonBBox(points);
        annotations.push({
          id: annId++,
          image_id: row.seq,
          category_id: categoryId,
          bbox,
          area: polygonArea(points),
          iscrowd: 0,
          segmentation: [points.flatMap((p) => [p.x, p.y])],
        });
      }
    }
  }
  return {
    info: {
      description: project.name,
      date_created: new Date().toISOString(),
      overmarked_format: 'coco',
    },
    images,
    annotations,
    categories,
  };
}

async function buildNer(config, project, rows, schema) {
  const labelName = new Map(schema.labels.map((l) => [l.id, l.name]));
  const docName = new Map((schema.documentLabels || []).map((l) => [l.id, l.name]));
  const lines = [];
  for (const row of rows) {
    const text = await readTextFile(config, project.id, row.storage_key, config.textMaxBytes);
    const data = parseJsonColumn(row.ann_data, {});
    lines.push(
      JSON.stringify({
        id: row.seq,
        filename: row.original_name,
        text,
        entities: (data.entities || []).map((entity) => ({
          start: entity.start,
          end: entity.end,
          label: labelName.get(entity.label) || entity.label,
          labelId: entity.label,
        })),
        documentLabels: (data.documentLabels || []).map((id) => docName.get(id) || id),
      })
    );
  }
  return lines.map((line) => `${line}\n`).join('');
}

function buildAudio(rows, schema) {
  const labelName = new Map(schema.labels.map((l) => [l.id, l.name]));
  const lines = [];
  for (const row of rows) {
    const data = parseJsonColumn(row.ann_data, {});
    const meta = parseJsonColumn(row.meta, {});
    lines.push(
      JSON.stringify({
        id: row.seq,
        filename: row.original_name,
        duration: meta.duration ?? null,
        segments: (data.segments || []).map((segment) => ({
          start: segment.start,
          end: segment.end,
          label: labelName.get(segment.label) || segment.label,
          labelId: segment.label,
        })),
      })
    );
  }
  return lines.map((line) => `${line}\n`).join('');
}

function buildGeoJson(project, rows, schema) {
  const labelName = new Map(schema.labels.map((l) => [l.id, l.name]));
  const features = [];
  const crsSet = new Set();
  for (const row of rows) {
    const data = parseJsonColumn(row.ann_data, {});
    const meta = parseJsonColumn(row.meta, {});
    const crs = meta.crs || 'pixel';
    crsSet.add(crs);
    for (const feature of data.features || []) {
      features.push({
        type: 'Feature',
        geometry: feature.geometry,
        properties: {
          label: feature.label,
          labelName: labelName.get(feature.label) || feature.label,
          itemId: row.id,
          seq: row.seq,
          filename: row.original_name,
          crs,
        },
      });
    }
  }
  const output = {
    type: 'FeatureCollection',
    name: project.name,
    features,
  };
  if (crsSet.size === 1) {
    output.crs = { type: 'name', properties: { name: [...crsSet][0] } };
  }
  return output;
}

function buildRaw(project, rows, schema, reviewsByItem) {
  return {
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      kind: project.kind,
      labelSchema: schema,
    },
    items: rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      filename: row.original_name,
      meta: parseJsonColumn(row.meta, {}),
      status: row.status,
      annotation: {
        data: parseJsonColumn(row.ann_data, {}),
        status: row.ann_status,
        version: row.ann_version,
        updatedBy: row.ann_updated_by,
        submittedAt: row.ann_submitted_at,
        reviewedAt: row.ann_reviewed_at,
      },
      reviews: (reviewsByItem.get(row.id) || []).map((review) => ({
        decision: review.decision,
        note: review.note,
        reviewerId: review.reviewer_id,
        createdAt: review.created_at,
      })),
    })),
  };
}

function attachmentName(project, format, ext) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const pretty = `${project.name}-${format}-${date}.${ext}`;
  const ascii = `overmarked-${format}-${date}.${ext}`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(pretty)}`;
}

export function registerExportRoutes(router) {
  router.get('/api/projects/:id/export', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.id, 'view');
    const format = ctx.query.get('format') || DEFAULT_FORMAT[project.kind];
    const scope = ctx.query.get('scope') || 'approved';
    const allowed =
      {
        image: ['coco', 'raw'],
        text: ['ner', 'raw'],
        audio: ['audio', 'raw'],
        spatial: ['geojson', 'raw'],
      }[project.kind] || [];
    if (!allowed.includes(format)) {
      throw invalid(`format 必须是 ${allowed.join(' / ')}`, { field: 'format', allowed });
    }
    if (!['approved', 'all'].includes(scope)) {
      throw invalid('scope 必须是 approved 或 all', { field: 'scope' });
    }
    const schema = schemaOfProject(project);
    const scopeClause = scope === 'approved' ? "AND an.status = 'approved'" : '';
    const rows = ctx.db
      .prepare(
        `SELECT i.*, an.data AS ann_data, an.status AS ann_status, an.version AS ann_version,
                an.updated_by AS ann_updated_by, an.submitted_at AS ann_submitted_at,
                an.reviewed_at AS ann_reviewed_at
           FROM items i JOIN annotations an ON an.item_id = i.id
          WHERE i.project_id = ? ${scopeClause}
          ORDER BY i.seq ASC`
      )
      .all(project.id);

    let payload;
    let contentType = 'application/json; charset=utf-8';
    let ext = 'json';
    if (format === 'coco') {
      payload = JSON.stringify(buildCoco(project, rows, schema));
    } else if (format === 'ner') {
      payload = await buildNer(ctx.config, project, rows, schema);
      contentType = 'application/x-ndjson; charset=utf-8';
      ext = 'jsonl';
    } else if (format === 'audio') {
      payload = buildAudio(rows, schema);
      contentType = 'application/x-ndjson; charset=utf-8';
      ext = 'jsonl';
    } else if (format === 'geojson') {
      payload = JSON.stringify(buildGeoJson(project, rows, schema));
      ext = 'geojson';
    } else {
      const reviewsByItem = new Map();
      if (rows.length) {
        const placeholders = rows.map(() => '?').join(',');
        const reviews = ctx.db
          .prepare(
            `SELECT * FROM reviews WHERE item_id IN (${placeholders}) ORDER BY id ASC`
          )
          .all(...rows.map((r) => r.id));
        for (const review of reviews) {
          if (!reviewsByItem.has(review.item_id)) reviewsByItem.set(review.item_id, []);
          reviewsByItem.get(review.item_id).push(review);
        }
      }
      payload = JSON.stringify(buildRaw(project, rows, schema, reviewsByItem), null, 2);
    }

    audit(ctx, 'export.download', 'project', project.id, {
      detail: { format, scope, count: rows.length },
      projectId: project.id,
    });
    ctx.res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': attachmentName(project, format, ext),
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    });
    ctx.res.end(payload);
  });
}
