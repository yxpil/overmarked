import { invalid } from './errors.js';
import { uuid } from './util.js';

export const PROJECT_KINDS = ['image', 'text', 'audio', 'spatial'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const HOTKEY_RE = /^[1-9a-zA-Z]$/;

export const DEFAULT_COLORS = ['#f5a524', '#4cc9f0', '#48c78e', '#ef5b5b', '#c084fc', '#f472b6'];

export function defaultLabelSchema(kind) {
  const names = {
    image: '目标',
    text: '实体',
    audio: '片段',
    spatial: '区域',
  };
  return {
    labels: [
      { id: 'lb_1', name: names[kind] || '标签', color: DEFAULT_COLORS[0], hotkey: '1' },
    ],
    documentLabels: [],
  };
}

export function requiredString(value, field, { min = 1, max = 200, trim = true } = {}) {
  if (typeof value !== 'string') throw invalid(`${field} 必须是字符串`, { field });
  const s = trim ? value.trim() : value;
  if (s.length < min || s.length > max) {
    throw invalid(`${field} 长度必须在 ${min}..${max} 之间`, { field });
  }
  return s;
}

export function optionalString(value, field, { max = 2000, trim = true, fallback = '' } = {}) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw invalid(`${field} 必须是字符串`, { field });
  const s = trim ? value.trim() : value;
  if (s.length > max) throw invalid(`${field} 不能超过 ${max} 字符`, { field });
  return s;
}

export function validateUsername(value) {
  if (typeof value !== 'string' || !USERNAME_RE.test(value.trim())) {
    throw invalid('用户名需为 3..32 位字母、数字、下划线、点或连字符', { field: 'username' });
  }
  return value.trim();
}

export function validatePassword(value, field = 'password') {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw invalid('密码长度需为 8..128 字符', { field });
  }
  return value;
}

export function validateRole(value, allowed, fallback) {
  if (value === undefined && fallback) return fallback;
  if (!allowed.includes(value)) throw invalid(`角色必须是 ${allowed.join(' / ')} 之一`, { field: 'role' });
  return value;
}

export function validateProjectKind(value) {
  if (!PROJECT_KINDS.includes(value)) {
    throw invalid('数据集类型必须是 image / text / audio / spatial 之一', { field: 'kind' });
  }
  return value;
}

function normalizeLabels(list, { field, max, requireAtLeastOne }) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) throw invalid(`${field} 必须是数组`, { field });
  if (requireAtLeastOne && list.length === 0) throw invalid(`${field} 至少需要 1 个标签`, { field });
  if (list.length > max) throw invalid(`${field} 最多 ${max} 项`, { field });
  const ids = new Set();
  const names = new Set();
  const hotkeys = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') throw invalid(`${field} 项必须是对象`, { field });
    const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
    if (!ID_RE.test(id)) {
      throw invalid(`${field} 的 id 非法（小写字母/数字开头，1..32 位）`, { field, id: raw.id });
    }
    if (ids.has(id)) throw invalid(`标签 id 重复：${id}`, { field });
    ids.add(id);
    const name = requiredString(raw.name, `${field}.name`, { min: 1, max: 40 });
    const key = name.toLowerCase();
    if (names.has(key)) throw invalid(`标签名称重复：${name}`, { field });
    names.add(key);
    const color = raw.color === undefined ? DEFAULT_COLORS[out.length % DEFAULT_COLORS.length] : raw.color;
    if (typeof color !== 'string' || !COLOR_RE.test(color)) {
      throw invalid(`标签颜色必须是 #rrggbb：${name}`, { field, name });
    }
    let hotkey;
    if (raw.hotkey !== undefined && raw.hotkey !== null && raw.hotkey !== '') {
      if (typeof raw.hotkey !== 'string' || !HOTKEY_RE.test(raw.hotkey)) {
        throw invalid(`快捷键必须是单个 1-9 或字母：${name}`, { field, name });
      }
      if (hotkeys.has(raw.hotkey)) throw invalid(`快捷键重复：${raw.hotkey}`, { field });
      hotkeys.add(raw.hotkey);
      hotkey = raw.hotkey;
    }
    out.push(hotkey ? { id, name, color, hotkey } : { id, name, color });
  }
  return out;
}

export function validateLabelSchema(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('labelSchema 必须是对象', { field: 'labelSchema' });
  }
  const labels = normalizeLabels(input.labels, {
    field: 'labelSchema.labels',
    max: 64,
    requireAtLeastOne: true,
  });
  if (!labels) throw invalid('labelSchema.labels 必须提供', { field: 'labelSchema.labels' });
  const documentLabels =
    normalizeLabels(input.documentLabels, {
      field: 'labelSchema.documentLabels',
      max: 32,
      requireAtLeastOne: false,
    }) || [];
  const all = new Set(labels.map((l) => l.id));
  for (const label of documentLabels) {
    if (all.has(label.id)) throw invalid(`标签 id 与文档标签冲突：${label.id}`, { field: 'labelSchema' });
    all.add(label.id);
  }
  return { labels, documentLabels };
}

function num(value, field, { min = -1e7, max = 1e7 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${field} 必须是有限数字`, { field });
  }
  if (value < min || value > max) throw invalid(`${field} 超出范围 ${min}..${max}`, { field });
  return value;
}

function int(value, field, { min = 0, max = 1e7 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${field} 必须是 ${min}..${max} 的整数`, { field });
  }
  return value;
}

function normalizeId(raw, field, seen) {
  let id;
  if (raw === undefined || raw === null || raw === '') id = uuid();
  else if (typeof raw === 'string' && raw.length <= 64) id = raw;
  else throw invalid(`${field} 的 id 非法`, { field });
  if (seen.has(id)) throw invalid(`${field} 的 id 重复：${id}`, { field });
  seen.add(id);
  return id;
}

function labelId(value, labelSet, field) {
  if (typeof value !== 'string' || !labelSet.has(value)) {
    throw invalid(`${field} 引用了不存在的标签：${String(value)}`, { field });
  }
  return value;
}

function validateBox(raw, labelSet, seen) {
  const id = normalizeId(raw.id, 'shape', seen);
  return {
    id,
    type: 'box',
    label: labelId(raw.label, labelSet, 'shape.label'),
    x: num(raw.x, 'shape.x'),
    y: num(raw.y, 'shape.y'),
    w: num(raw.w, 'shape.w', { min: 0.000001 }),
    h: num(raw.h, 'shape.h', { min: 0.000001 }),
  };
}

function validatePoint(raw, field) {
  if (!raw || typeof raw !== 'object') throw invalid(`${field} 必须是 {x,y} 对象`, { field });
  return { x: num(raw.x, `${field}.x`), y: num(raw.y, `${field}.y`) };
}

function validatePolygonShape(raw, labelSet, seen) {
  const id = normalizeId(raw.id, 'shape', seen);
  if (!Array.isArray(raw.points) || raw.points.length < 3 || raw.points.length > 10000) {
    throw invalid('多边形至少 3 个点、最多 10000 个点', { field: 'shape.points' });
  }
  return {
    id,
    type: 'polygon',
    label: labelId(raw.label, labelSet, 'shape.label'),
    points: raw.points.map((p, i) => validatePoint(p, `shape.points[${i}]`)),
  };
}

function validateTextData(data, schema, opts) {
  const labelSet = new Set(schema.labels.map((l) => l.id));
  const docSet = new Set((schema.documentLabels || []).map((l) => l.id));
  if (!Array.isArray(data.entities)) throw invalid('entities 必须是数组', { field: 'entities' });
  if (data.entities.length > 2000) throw invalid('实体最多 2000 个', { field: 'entities' });
  if (!Array.isArray(data.documentLabels || [])) {
    throw invalid('documentLabels 必须是数组', { field: 'documentLabels' });
  }
  const seen = new Set();
  const entities = data.entities.map((raw) => {
    if (!raw || typeof raw !== 'object') throw invalid('实体必须是对象', { field: 'entities' });
    const id = normalizeId(raw.id, 'entity', seen);
    const start = int(raw.start, 'entity.start');
    const end = int(raw.end, 'entity.end');
    if (start >= end) throw invalid('实体 start 必须小于 end', { field: 'entities' });
    if (opts.textLength !== undefined && end > opts.textLength) {
      throw invalid('实体区间超出文本长度', { field: 'entities', textLength: opts.textLength });
    }
    return { id, start, end, label: labelId(raw.label, labelSet, 'entity.label') };
  });
  const sorted = [...entities].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw invalid('实体之间不能重叠', {
        field: 'entities',
        conflict: [sorted[i - 1].id, sorted[i].id],
      });
    }
  }
  const documentLabels = [...new Set(data.documentLabels || [])];
  for (const id of documentLabels) {
    if (typeof id !== 'string' || !docSet.has(id)) {
      throw invalid(`文档标签不存在：${String(id)}`, { field: 'documentLabels' });
    }
  }
  if (documentLabels.length > 32) throw invalid('文档标签最多 32 个', { field: 'documentLabels' });
  return { entities, documentLabels, note: optionalString(data.note, 'note', { max: 2000 }) };
}

function validateAudioData(data, schema, opts) {
  const labelSet = new Set(schema.labels.map((l) => l.id));
  if (!Array.isArray(data.segments)) throw invalid('segments 必须是数组', { field: 'segments' });
  if (data.segments.length > 2000) throw invalid('音频区段最多 2000 个', { field: 'segments' });
  const seen = new Set();
  const segments = data.segments.map((raw) => {
    if (!raw || typeof raw !== 'object') throw invalid('区段必须是对象', { field: 'segments' });
    const id = normalizeId(raw.id, 'segment', seen);
    const start = num(raw.start, 'segment.start', { min: 0, max: 86400 });
    const end = num(raw.end, 'segment.end', { min: 0, max: 86400 });
    if (end <= start) throw invalid('区段 end 必须大于 start', { field: 'segments' });
    if (opts.duration !== undefined && end > opts.duration + 0.05) {
      throw invalid('区段超出音频时长', { field: 'segments', duration: opts.duration });
    }
    return { id, start, end, label: labelId(raw.label, labelSet, 'segment.label') };
  });
  return { segments, note: optionalString(data.note, 'note', { max: 2000 }) };
}

function validateCoordinatePair(pair, field, crs) {
  if (!Array.isArray(pair) || pair.length < 2) {
    throw invalid(`${field} 必须是 [x,y]`, { field });
  }
  let x = num(pair[0], `${field}[0]`);
  let y = num(pair[1], `${field}[1]`);
  if (crs === 'EPSG:4326') {
    if (x < -180 || x > 180 || y < -90 || y > 90) {
      throw invalid(`${field} 超出经纬度范围`, { field });
    }
  }
  return [x, y];
}

function validateGeometry(geometry, field, crs) {
  if (!geometry || typeof geometry !== 'object') throw invalid(`${field} 必须是对象`, { field });
  const type = geometry.type;
  if (!['Point', 'LineString', 'Polygon'].includes(type)) {
    throw invalid('几何类型仅支持 Point / LineString / Polygon', { field });
  }
  const c = geometry.coordinates;
  if (type === 'Point') {
    return { type, coordinates: validateCoordinatePair(c, `${field}.coordinates`, crs) };
  }
  if (type === 'LineString') {
    if (!Array.isArray(c) || c.length < 2 || c.length > 10000) {
      throw invalid('LineString 需要 2..10000 个坐标点', { field });
    }
    return {
      type,
      coordinates: c.map((pair, i) => validateCoordinatePair(pair, `${field}.coordinates[${i}]`, crs)),
    };
  }
  if (!Array.isArray(c) || c.length < 1 || c.length > 100) {
    throw invalid('Polygon 需要 1..100 个环', { field });
  }
  const rings = c.map((ring, ri) => {
    if (!Array.isArray(ring) || ring.length < 3 || ring.length > 10000) {
      throw invalid('Polygon 环至少 3 个坐标点', { field });
    }
    const points = ring.map((pair, i) =>
      validateCoordinatePair(pair, `${field}.coordinates[${ri}][${i}]`, crs)
    );
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
    if (points.length < 4) throw invalid('Polygon 环闭合后至少 4 个坐标点', { field });
    return points;
  });
  return { type, coordinates: rings };
}

function validateSpatialData(data, schema, opts) {
  const labelSet = new Set(schema.labels.map((l) => l.id));
  if (!Array.isArray(data.features)) throw invalid('features 必须是数组', { field: 'features' });
  if (data.features.length > 3000) throw invalid('空间要素最多 3000 个', { field: 'features' });
  const crs = opts.crs === 'EPSG:4326' ? 'EPSG:4326' : 'pixel';
  const seen = new Set();
  const features = data.features.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw invalid('要素必须是对象', { field: 'features' });
    const id = normalizeId(raw.id, 'feature', seen);
    return {
      id,
      label: labelId(raw.label, labelSet, 'feature.label'),
      geometry: validateGeometry(raw.geometry, `feature[${index}].geometry`, crs),
    };
  });
  return { features, note: optionalString(data.note, 'note', { max: 2000 }) };
}

export function validateAnnotationData(kind, data, schema, opts = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalid('data 必须是对象', { field: 'data' });
  }
  let normalized;
  if (kind === 'image') {
    const labelSet = new Set(schema.labels.map((l) => l.id));
    if (!Array.isArray(data.shapes)) throw invalid('shapes 必须是数组', { field: 'shapes' });
    if (data.shapes.length > 5000) throw invalid('图元最多 5000 个', { field: 'shapes' });
    const seen = new Set();
    const shapes = data.shapes.map((raw) => {
      if (!raw || typeof raw !== 'object') throw invalid('图元必须是对象', { field: 'shapes' });
      if (raw.type === 'box') return validateBox(raw, labelSet, seen);
      if (raw.type === 'polygon') return validatePolygonShape(raw, labelSet, seen);
      throw invalid('图元类型仅支持 box / polygon', { field: 'shapes' });
    });
    normalized = { shapes, note: optionalString(data.note, 'note', { max: 2000 }) };
  } else if (kind === 'text') {
    normalized = validateTextData(data, schema, opts);
  } else if (kind === 'audio') {
    normalized = validateAudioData(data, schema, opts);
  } else if (kind === 'spatial') {
    normalized = validateSpatialData(data, schema, opts);
  } else {
    throw invalid('未知项目类型');
  }
  return normalized;
}

const META_KEYS = new Set(['width', 'height', 'duration', 'bounds', 'crs', 'featureCount']);

export function validateMetaPatch(kind, current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw invalid('meta 必须是对象', { field: 'meta' });
  }
  const next = { ...(current || {}) };
  for (const key of Object.keys(patch)) {
    if (!META_KEYS.has(key)) throw invalid(`meta.${key} 不允许修改`, { field: `meta.${key}` });
    const value = patch[key];
    if (key === 'width' || key === 'height') {
      next[key] = int(value, `meta.${key}`, { min: 1, max: 200000 });
    } else if (key === 'duration') {
      next.duration = num(value, 'meta.duration', { min: 0, max: 86400 });
    } else if (key === 'featureCount') {
      next.featureCount = int(value, 'meta.featureCount', { min: 0, max: 1e7 });
    } else if (key === 'crs') {
      if (!['EPSG:4326', 'pixel'].includes(value)) {
        throw invalid('meta.crs 只能是 EPSG:4326 或 pixel', { field: 'meta.crs' });
      }
      next.crs = value;
    } else if (key === 'bounds') {
      if (!Array.isArray(value) || value.length !== 4) {
        throw invalid('meta.bounds 必须是 [west,south,east,north]', { field: 'meta.bounds' });
      }
      const [w, s, e, n] = value.map((v, i) => num(v, `meta.bounds[${i}]`));
      if (w >= e || s >= n) throw invalid('meta.bounds 必须满足 west<east 且 south<north', { field: 'meta.bounds' });
      if (next.crs === 'EPSG:4326' && (w < -180 || e > 180 || s < -90 || n > 90)) {
        throw invalid('EPSG:4326 包围盒超出经纬度范围', { field: 'meta.bounds' });
      }
      next.bounds = [w, s, e, n];
    }
  }
  return next;
}

export function validateStatusFilter(value) {
  if (!value) return null;
  const allowed = ['pending', 'in_progress', 'submitted', 'approved', 'rejected'];
  const list = String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  for (const status of list) {
    if (!allowed.includes(status)) throw invalid(`未知状态：${status}`, { field: 'status' });
  }
  return list.length ? list : null;
}
