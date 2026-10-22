export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function hexToRgba(hex, alpha) {
  const value = String(hex || '#f5a524').replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const num = Number.parseInt(normalized, 16);
  if (!Number.isFinite(num)) return `rgba(245,165,36,${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function contrastInk(hex) {
  const value = String(hex || '#f5a524').replace('#', '');
  const num = Number.parseInt(value.length === 3 ? value.split('').map((c) => c + c).join('') : value, 16);
  if (!Number.isFinite(num)) return '#101214';
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#101214' : '#f7f8fa';
}

export function isTyping(target) {
  if (!target || !(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export function flattenPoints(points) {
  return points.flatMap((point) => [point.x, point.y]);
}

export function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = clamp(t, 0, 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function polygonCentroid(points) {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

export function shapeBBox(shape) {
  if (shape.type === 'box') {
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }
  const xs = shape.points.map((p) => p.x);
  const ys = shape.points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export function canvasMetrics(canvas) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height, dpr };
}

export function labelNameMap(schema) {
  return new Map((schema.labels || []).map((label) => [label.id, label]));
}

export function drawLabelTag(ctx, text, x, y, color, ink = null) {
  ctx.font = '10px ui-monospace, Consolas, monospace';
  const padding = 5;
  const width = Math.ceil(ctx.measureText(text).width) + padding * 2;
  const height = 16;
  ctx.fillStyle = color;
  ctx.fillRect(x, y - height, width, height);
  ctx.fillStyle = ink || contrastInk(color);
  ctx.fillText(text, x + padding, y - 4);
}
