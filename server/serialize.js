import { parseJsonColumn } from './db.js';

export function schemaOfProject(row) {
  return parseJsonColumn(row.label_schema, { labels: [], documentLabels: [] });
}

export function serializeProject(row, { role = null, counts = null, members = null } = {}) {
  const schema = schemaOfProject(row);
  const project = {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    labelSchema: schema,
    archived: Boolean(row.archived),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    labelsCount: schema.labels?.length || 0,
    role,
  };
  if (counts) project.counts = counts;
  if (members) project.members = members;
  return project;
}

export function serializeMember(row) {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function serializeItem(row, extra = {}) {
  const item = {
    id: row.id,
    projectId: row.project_id,
    seq: row.seq,
    filename: row.original_name,
    mime: row.mime,
    size: row.size,
    meta: parseJsonColumn(row.meta, {}),
    status: row.status,
    assigneeId: row.assignee_id || null,
    assigneeName: row.assignee_name || null,
    uploadedBy: row.uploaded_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.annotation_status !== undefined) {
    item.annotationStatus = row.annotation_status || null;
    item.annotationVersion = row.annotation_version ?? null;
  }
  return { ...item, ...extra };
}

export function serializeAnnotation(row) {
  if (!row) return null;
  return {
    itemId: row.item_id,
    data: parseJsonColumn(row.data, {}),
    status: row.status,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    updatedByName: row.updated_by_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    reviewedAt: row.reviewed_at || null,
  };
}

export function serializeReview(row) {
  return {
    id: row.id,
    reviewerId: row.reviewer_id,
    reviewerName: row.reviewer_name || null,
    decision: row.decision,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function countFigures(kind, data) {
  if (!data) return 0;
  if (kind === 'image') return data.shapes?.length || 0;
  if (kind === 'text') return data.entities?.length || 0;
  if (kind === 'audio') return data.segments?.length || 0;
  if (kind === 'spatial') return data.features?.length || 0;
  return 0;
}
