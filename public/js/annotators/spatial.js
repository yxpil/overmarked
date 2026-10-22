import { api } from '../api.js';
import { clear, el, field, icon, option, toast } from '../ui.js';
import {
  canvasMetrics,
  clamp,
  distanceToSegment,
  drawLabelTag,
  hexToRgba,
  isTyping,
  labelNameMap,
  newId,
  pointInPolygon,
  polygonCentroid,
  round,
} from './shared.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRasterName(filename) {
  return /\.(png|jpe?g|webp)$/i.test(String(filename || ''));
}

function sameBounds(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  return a.every((value, index) => Math.abs(Number(value) - Number(b[index])) < 1e-9);
}

function niceStep(span, pixels, targetPixels = 92) {
  const target = span / Math.max(1, pixels / targetPixels);
  if (!Number.isFinite(target) || target <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(target));
  for (const factor of [1, 2, 5, 10]) {
    if (factor * power >= target) return factor * power;
  }
  return 10 * power;
}

function extractGeometries(value, sink = []) {
  if (!value || typeof value !== 'object' || sink.length >= 6000) return sink;
  if (value.type === 'FeatureCollection') {
    for (const feature of value.features || []) extractGeometries(feature, sink);
  } else if (value.type === 'Feature') {
    extractGeometries(value.geometry, sink);
  } else if (value.type === 'GeometryCollection') {
    for (const child of value.geometries || []) extractGeometries(child, sink);
  } else if (value.type && value.coordinates) {
    sink.push(value);
  }
  return sink;
}

function collectPositions(value, sink) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    sink.push(value);
    return;
  }
  for (const child of value) collectPositions(child, sink);
}

function boundsOfGeometries(geometries) {
  const positions = [];
  for (const geometry of geometries) collectPositions(geometry.coordinates, positions);
  if (!positions.length) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [x, y] of positions) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    west = Math.min(west, x);
    east = Math.max(east, x);
    south = Math.min(south, y);
    north = Math.max(north, y);
  }
  if (!Number.isFinite(west)) return null;
  if (west === east) {
    west -= 0.5;
    east += 0.5;
  }
  if (south === north) {
    south -= 0.5;
    north += 0.5;
  }
  return [west, south, east, north];
}

export function createSpatialAnnotator(host, { item, schema, data, readOnly = false, onChange, onSelect }) {
  const labelMap = labelNameMap(schema);
  const labels = schema.labels || [];
  const raster = isRasterName(item.filename);
  const defaultCrs = raster ? 'pixel' : 'EPSG:4326';

  const root = el('div', { className: 'spatial-annotator' });
  const toolDefs = [
    ['select', 'cursor', '选择 / 拖动顶点 (V)'],
    ['point', 'point', '点要素 (P)'],
    ['line', 'line', '线要素 (L)'],
    ['polygon', 'polygon', '面要素 (G)'],
  ];
  const toolButtons = new Map();
  const toolGroup = el('div', { className: 'inline', style: { gap: '2px' } });
  for (const [id, iconName, title] of toolDefs) {
    const button = el(
      'button',
      {
        className: `tool-btn${id === 'select' ? ' active' : ''}`,
        type: 'button',
        title,
        onClick: () => setTool(id),
      },
      icon(iconName)
    );
    if (readOnly && id !== 'select') button.hidden = true;
    toolButtons.set(id, button);
    toolGroup.append(button);
  }
  const fitButton = el(
    'button',
    { className: 'tool-btn', type: 'button', title: '适配范围', onClick: fitView },
    icon('fit')
  );
  const crsBadge = el('span', { className: 'badge' });
  const regButton = el(
    'button',
    { className: 'btn btn-sm', type: 'button', title: '配准与坐标系', onClick: toggleRegPanel },
    icon('settings'),
    '配准'
  );
  const toolbar = el(
    'div',
    { className: 'annotator-toolbar' },
    toolGroup,
    el('div', { className: 'tool-sep', style: { height: '20px' } }),
    fitButton,
    el('div', { className: 'spacer' }),
    crsBadge,
    raster && !readOnly ? regButton : null
  );

  const wrap = el('div', { className: 'annotator-canvas-wrap' });
  const canvas = el('canvas');
  const hud = el('div', { className: 'spatial-hud' });
  wrap.append(canvas, hud);

  const regError = el('div', { className: 'form-error', hidden: true });
  const crsSelect = el('select', { className: 'select' });
  crsSelect.append(option('pixel', '像素坐标 (pixel)', defaultCrs === 'pixel'), option('EPSG:4326', 'WGS84 经纬度 (EPSG:4326)', defaultCrs === 'EPSG:4326'));
  const westInput = el('input', { className: 'input', type: 'number', attrs: { step: 'any' } });
  const southInput = el('input', { className: 'input', type: 'number', attrs: { step: 'any' } });
  const eastInput = el('input', { className: 'input', type: 'number', attrs: { step: 'any' } });
  const northInput = el('input', { className: 'input', type: 'number', attrs: { step: 'any' } });
  const regPanel = el(
    'div',
    { className: 'reg-panel', hidden: true },
    el('h4', { text: '配准与坐标系' }),
    el('p', { className: 'field-hint', text: '栅格底图需要设置四至范围；已有要素时不可修改配准。', style: { margin: '0 0 8px' } }),
    regError,
    field('坐标系', crsSelect),
    el('div', { className: 'form-row' }, field('西 / left', westInput), field('东 / right', eastInput)),
    el('div', { className: 'form-row' }, field('南 / bottom', southInput), field('北 / top', northInput)),
    el(
      'div',
      { className: 'actions' },
      el('button', { className: 'btn btn-sm btn-ghost', type: 'button', text: '取消', onClick: closeRegPanel }),
      el('button', { className: 'btn btn-sm btn-primary', type: 'button', text: '应用配准', onClick: applyRegistration })
    )
  );
  wrap.append(regPanel);
  root.append(toolbar, wrap);
  host.append(root);

  const meta = item.meta || {};
  let crs = meta.crs || defaultCrs;
  let bounds = initialBounds();
  let view = { ...bounds };
  let features = clone(Array.isArray(data?.features) ? data.features : []);
  let note = typeof data?.note === 'string' ? data.note : '';
  let currentLabel = features[0]?.label || labels[0]?.id || null;
  let selectedId = null;
  let tool = 'select';
  let draft = null;
  let mouse = { x: 0, y: 0, coord: null, inside: false };
  let viewDrag = null;
  let vertexDrag = null;
  let finishGuard = 0;
  let baseImage = null;
  let baseGeometries = [];
  let baseVersion = 0;
  let baseTruncated = false;
  const baseCanvas = document.createElement('canvas');
  let baseKey = '';
  let rafId = 0;
  let loadToken = 0;
  const history = [];
  const future = [];

  function initialBounds() {
    if (Array.isArray(meta.bounds) && meta.bounds.length === 4) {
      const [w, s, e, n] = meta.bounds.map(Number);
      if ([w, s, e, n].every(Number.isFinite) && w < e && s < n) return { west: w, south: s, east: e, north: n };
    }
    if (raster) {
      const width = Number(meta.width) || 1000;
      const height = Number(meta.height) || 1000;
      return { west: 0, south: 0, east: width, north: height };
    }
    return { west: -180, south: -90, east: 180, north: 90 };
  }

  function snapshot() {
    return JSON.stringify(features);
  }

  function geometryForOutput(geometry) {
    const digits = crs === 'EPSG:4326' ? 6 : 2;
    if (geometry.type === 'Point') {
      return { type: 'Point', coordinates: [round(geometry.coordinates[0], digits), round(geometry.coordinates[1], digits)] };
    }
    if (geometry.type === 'LineString') {
      return {
        type: 'LineString',
        coordinates: geometry.coordinates.map((pair) => [round(pair[0], digits), round(pair[1], digits)]),
      };
    }
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map((ring) => ring.map((pair) => [round(pair[0], digits), round(pair[1], digits)])),
    };
  }

  function getData() {
    return {
      features: features.map((feature) => ({
        id: feature.id,
        label: feature.label,
        geometry: geometryForOutput(feature.geometry),
      })),
      note,
    };
  }

  function getMetaPatch() {
    const patch = {};
    if (crs !== (meta.crs || defaultCrs)) patch.crs = crs;
    if (!sameBounds(boundsToArray(bounds), meta.bounds)) {
      patch.bounds = boundsToArray(bounds).map((value) => round(value, crs === 'EPSG:4326' ? 8 : 3));
    }
    return Object.keys(patch).length ? patch : null;
  }

  function boundsToArray(value) {
    return [value.west, value.south, value.east, value.north];
  }

  function notifyChange() {
    updateHud();
    onChange?.(getData());
  }

  function pushHistory(snap = snapshot()) {
    history.push(snap);
    if (history.length > 100) history.shift();
    future.length = 0;
  }

  function colorOf(labelId) {
    return labelMap.get(labelId)?.color || '#f5a524';
  }

  function nameOf(labelId) {
    return labelMap.get(labelId)?.name || labelId;
  }

  function byId(id) {
    return features.find((feature) => feature.id === id) || null;
  }

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    onSelect?.(id);
    requestDraw();
  }

  function setTool(next) {
    if (readOnly && next !== 'select') return;
    if (draft) draft = null;
    tool = next;
    for (const [id, button] of toolButtons) button.classList.toggle('active', id === tool);
    canvas.style.cursor = 'crosshair';
    updateHud();
    requestDraw();
  }

  function projection(w, h) {
    const spanX = Math.max(1e-9, view.east - view.west);
    const spanY = Math.max(1e-9, view.north - view.south);
    const scale = Math.min(w / spanX, h / spanY);
    const mapW = spanX * scale;
    const mapH = spanY * scale;
    return { scale, ox: (w - mapW) / 2, oy: (h - mapH) / 2, w: mapW, h: mapH };
  }

  function coordToScreen(pair, proj) {
    return {
      x: proj.ox + (pair[0] - view.west) * proj.scale,
      y: proj.oy + (view.north - pair[1]) * proj.scale,
    };
  }

  function screenToCoord(x, y, proj) {
    let lon = view.west + (x - proj.ox) / proj.scale;
    let lat = view.north - (y - proj.oy) / proj.scale;
    if (crs === 'EPSG:4326') {
      lon = clamp(lon, -180, 180);
      lat = clamp(lat, -90, 90);
    } else {
      lon = clamp(lon, bounds.west, bounds.east);
      lat = clamp(lat, bounds.south, bounds.north);
    }
    return [lon, lat];
  }

  function formatCoord(pair, digits = null) {
    if (!pair) return '—';
    const d = digits ?? (crs === 'EPSG:4326' ? 5 : 1);
    return `${pair[0].toFixed(d)}, ${pair[1].toFixed(d)}`;
  }

  function gridLabel(value, step) {
    const digits = step >= 1 ? (crs === 'EPSG:4326' ? 1 : 0) : Math.min(6, Math.ceil(-Math.log10(step)) + 1);
    return Number(value.toFixed(digits)).toString();
  }

  function updateHud() {
    const crsLabel = crs === 'EPSG:4326' ? 'EPSG:4326' : 'pixel';
    if (draft) {
      const typeName = draft.type === 'LineString' ? '线' : '面';
      hud.textContent = `绘制${typeName} · ${draft.points.length} 点 · 双击或 Enter 完成 · Esc 取消`;
      return;
    }
    const cursor = mouse.inside ? formatCoord(mouse.coord) : '—';
    hud.textContent = `${crsLabel} · 光标 ${cursor} · ${features.length} 要素${baseTruncated ? ' · 底图已裁剪' : ''}`;
  }

  function renderBase(w, h, dpr, proj) {
    baseCanvas.width = Math.max(1, Math.round(w * dpr));
    baseCanvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = baseCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0d0f';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0d1215';
    ctx.fillRect(proj.ox, proj.oy, proj.w, proj.h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(proj.ox, proj.oy, proj.w, proj.h);
    ctx.clip();

    if (baseImage) {
      ctx.globalAlpha = 0.86;
      ctx.drawImage(baseImage, proj.ox, proj.oy, proj.w, proj.h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(8,12,14,0.18)';
      ctx.fillRect(proj.ox, proj.oy, proj.w, proj.h);
    }

    if (baseGeometries.length) {
      ctx.strokeStyle = 'rgba(124,140,152,0.55)';
      ctx.fillStyle = 'rgba(124,140,152,0.08)';
      ctx.lineWidth = 0.9;
      for (const geometry of baseGeometries) drawGeometryBase(ctx, geometry, proj);
    }

    const spanX = view.east - view.west;
    const spanY = view.north - view.south;
    const step = niceStep(spanX, w);
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.fillStyle = 'rgba(139,148,158,0.72)';
    const startX = Math.ceil(view.west / step) * step;
    for (let x = startX; x <= view.east + step * 0.001; x += step) {
      const sx = Math.round(proj.ox + (x - view.west) * proj.scale) + 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, proj.oy);
      ctx.lineTo(sx, proj.oy + proj.h);
      ctx.stroke();
      ctx.fillText(gridLabel(x, step), sx + 3, proj.oy + 11);
    }
    const startY = Math.ceil(view.south / step) * step;
    for (let y = startY; y <= view.north + step * 0.001; y += step) {
      const sy = Math.round(proj.oy + (view.north - y) * proj.scale) + 0.5;
      ctx.beginPath();
      ctx.moveTo(proj.ox, sy);
      ctx.lineTo(proj.ox + proj.w, sy);
      ctx.stroke();
      ctx.fillText(gridLabel(y, step), proj.ox + 4, sy - 3);
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(54,62,70,0.9)';
    ctx.strokeRect(proj.ox + 0.5, proj.oy + 0.5, proj.w - 1, proj.h - 1);
  }

  function drawGeometryBase(ctx, geometry, proj) {
    if (!geometry) return;
    const type = geometry.type;
    if (type === 'GeometryCollection') {
      for (const child of geometry.geometries || []) drawGeometryBase(ctx, child, proj);
      return;
    }
    if (!geometry.coordinates) return;
    const rings = (coordinates) => {
      const points = coordinates.map((pair) => coordToScreen(pair, proj));
      if (!points.length) return;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    };
    const polygon = (poly) => {
      ctx.beginPath();
      for (const ring of poly) {
        const points = ring.map((pair) => coordToScreen(pair, proj));
        if (!points.length) continue;
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.stroke();
    };
    if (type === 'Point') {
      const point = coordToScreen(geometry.coordinates, proj);
      ctx.beginPath();
      ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'MultiPoint') {
      for (const pair of geometry.coordinates) {
        const point = coordToScreen(pair, proj);
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (type === 'LineString') {
      rings(geometry.coordinates);
    } else if (type === 'MultiLineString') {
      for (const line of geometry.coordinates) rings(line);
    } else if (type === 'Polygon') {
      polygon(geometry.coordinates);
    } else if (type === 'MultiPolygon') {
      for (const poly of geometry.coordinates) polygon(poly);
    }
  }

  function featureScreenPoints(feature, proj) {
    const geometry = feature.geometry;
    if (geometry.type === 'Point') return [coordToScreen(geometry.coordinates, proj)];
    if (geometry.type === 'LineString') return geometry.coordinates.map((pair) => coordToScreen(pair, proj));
    return geometry.coordinates[0].map((pair) => coordToScreen(pair, proj));
  }

  function drawFeature(ctx, feature, proj, selected) {
    const color = colorOf(feature.label);
    const geometry = feature.geometry;
    ctx.lineWidth = selected ? 2.5 : 1.8;
    ctx.strokeStyle = selected ? '#f4f6f8' : color;
    ctx.fillStyle = hexToRgba(color, selected ? 0.28 : 0.17);

    if (geometry.type === 'Point') {
      const point = coordToScreen(geometry.coordinates, proj);
      ctx.beginPath();
      ctx.arc(point.x, point.y, selected ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = selected ? '#f4f6f8' : '#0a0d0f';
      ctx.lineWidth = 2;
      ctx.stroke();
      drawLabelTag(ctx, nameOf(feature.label), point.x + 9, point.y - 8, color);
      return;
    }

    const points = featureScreenPoints(feature, proj);
    if (!points.length) return;
    if (geometry.type === 'Polygon') {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const center = polygonCentroid(points.slice(0, -1).length >= 3 ? points.slice(0, -1) : points);
      drawLabelTag(ctx, nameOf(feature.label), center.x, center.y, color);
    } else {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
      drawLabelTag(ctx, nameOf(feature.label), points[0].x + 4, points[0].y - 6, color);
    }

    if (selected) {
      ctx.fillStyle = '#f4f6f8';
      const vertices =
        geometry.type === 'Polygon'
          ? points.slice(0, -1)
          : geometry.type === 'Point'
            ? points
            : points;
      for (const point of vertices) ctx.fillRect(point.x - 2.5, point.y - 2.5, 5, 5);
    }
  }

  function drawDraft(ctx, proj) {
    if (!draft) return;
    const color = colorOf(currentLabel);
    const points = draft.points.map((pair) => coordToScreen(pair, proj));
    if (!points.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (draft.type === 'Polygon' && mouse.inside) {
      ctx.lineTo(mouse.x, mouse.y);
      ctx.lineTo(points[0].x, points[0].y);
    } else if (mouse.inside) {
      ctx.lineTo(mouse.x, mouse.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(244,246,248,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  function draw() {
    rafId = 0;
    const { ctx, w, h, dpr } = canvasMetrics(canvas);
    if (!w || !h) return;
    const proj = projection(w, h);
    const key = [
      w,
      h,
      dpr,
      view.west,
      view.south,
      view.east,
      view.north,
      baseVersion,
    ].join('|');
    if (key !== baseKey) {
      renderBase(w, h, dpr, proj);
      baseKey = key;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(baseCanvas, 0, 0, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(proj.ox, proj.oy, proj.w, proj.h);
    ctx.clip();
    for (const feature of features) {
      if (feature.id === selectedId) continue;
      drawFeature(ctx, feature, proj, false);
    }
    const selected = byId(selectedId);
    if (selected) drawFeature(ctx, selected, proj, true);
    drawDraft(ctx, proj);
    ctx.restore();

    if (mouse.inside) {
      const x = Math.round(mouse.x) + 0.5;
      const y = Math.round(mouse.y) + 0.5;
      ctx.strokeStyle = 'rgba(244,246,248,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, proj.oy);
      ctx.lineTo(x, proj.oy + proj.h);
      ctx.moveTo(proj.ox, y);
      ctx.lineTo(proj.ox + proj.w, y);
      ctx.stroke();
    }
  }

  function requestDraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(draw);
  }

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hitVertex(feature, point, proj) {
    const geometry = feature.geometry;
    if (geometry.type === 'Point') {
      const screen = coordToScreen(geometry.coordinates, proj);
      return Math.hypot(screen.x - point.x, screen.y - point.y) <= 7 ? 0 : -1;
    }
    const coordinates =
      geometry.type === 'Polygon' ? geometry.coordinates[0].slice(0, -1) : geometry.coordinates;
    for (let i = 0; i < coordinates.length; i++) {
      const screen = coordToScreen(coordinates[i], proj);
      if (Math.abs(screen.x - point.x) <= 6 && Math.abs(screen.y - point.y) <= 6) return i;
    }
    return -1;
  }

  function hitFeature(point, proj) {
    const tolerance = 7;
    for (let i = features.length - 1; i >= 0; i--) {
      const feature = features[i];
      const geometry = feature.geometry;
      if (geometry.type === 'Point') {
        const screen = coordToScreen(geometry.coordinates, proj);
        if (Math.hypot(screen.x - point.x, screen.y - point.y) <= 9) return feature;
        continue;
      }
      const points = featureScreenPoints(feature, proj);
      if (geometry.type === 'LineString') {
        for (let j = 1; j < points.length; j++) {
          if (distanceToSegment(point, points[j - 1], points[j]) <= tolerance) return feature;
        }
      } else {
        if (pointInPolygon(point, points.slice(0, -1))) return feature;
        for (let j = 1; j < points.length; j++) {
          if (distanceToSegment(point, points[j - 1], points[j]) <= tolerance) return feature;
        }
      }
    }
    return null;
  }

  function coordRounded(pair) {
    const digits = crs === 'EPSG:4326' ? 6 : 2;
    return [round(pair[0], digits), round(pair[1], digits)];
  }

  function addPointFeature(coord) {
    if (readOnly) return;
    pushHistory();
    const feature = {
      id: newId(),
      label: currentLabel,
      geometry: { type: 'Point', coordinates: coordRounded(coord) },
    };
    features.push(feature);
    selectedId = feature.id;
    onSelect?.(feature.id);
    notifyChange();
    requestDraw();
  }

  function addDraftPoint(coord) {
    if (performance.now() - finishGuard < 320) return;
    if (!draft) {
      draft = {
        type: tool === 'line' ? 'LineString' : 'Polygon',
        points: [],
      };
    }
    const proj = projection(canvas.clientWidth, canvas.clientHeight);
    if (draft.points.length) {
      const last = coordToScreen(draft.points[draft.points.length - 1], proj);
      const next = coordToScreen(coord, proj);
      if (Math.hypot(last.x - next.x, last.y - next.y) < 4) return;
    }
    if (draft.type === 'Polygon' && draft.points.length >= 3) {
      const first = coordToScreen(draft.points[0], proj);
      const next = coordToScreen(coord, proj);
      if (Math.hypot(first.x - next.x, first.y - next.y) <= 8) {
        finishDraft();
        return;
      }
    }
    draft.points.push(coordRounded(coord));
    updateHud();
    requestDraw();
  }

  function finishDraft() {
    if (!draft) return;
    if (draft.type === 'LineString' && draft.points.length < 2) {
      toast('线要素至少需要 2 个点', 'error');
      return;
    }
    if (draft.type === 'Polygon' && draft.points.length < 3) {
      toast('面要素至少需要 3 个点', 'error');
      return;
    }
    const points = draft.points.map((pair) => [...pair]);
    const geometry =
      draft.type === 'LineString'
        ? { type: 'LineString', coordinates: points }
        : { type: 'Polygon', coordinates: [[...points, [...points[0]]]] };
    pushHistory();
    const feature = { id: newId(), label: currentLabel, geometry };
    features.push(feature);
    selectedId = feature.id;
    onSelect?.(feature.id);
    draft = null;
    finishGuard = performance.now();
    notifyChange();
    requestDraw();
  }

  function cancelDraft() {
    if (!draft) return;
    draft = null;
    updateHud();
    requestDraw();
  }

  function removeFeature(id) {
    if (readOnly) return;
    if (!byId(id)) return;
    pushHistory();
    features = features.filter((feature) => feature.id !== id);
    if (selectedId === id) {
      selectedId = null;
      onSelect?.(null);
    }
    notifyChange();
    requestDraw();
  }

  function changeLabel(id, labelId) {
    const feature = byId(id);
    if (!feature || feature.label === labelId) return;
    pushHistory();
    feature.label = labelId;
    notifyChange();
    requestDraw();
  }

  function undo() {
    if (!history.length) return;
    future.push(snapshot());
    features = JSON.parse(history.pop());
    draft = null;
    selectedId = null;
    onSelect?.(null);
    notifyChange();
    requestDraw();
  }

  function redo() {
    if (!future.length) return;
    history.push(snapshot());
    features = JSON.parse(future.pop());
    draft = null;
    selectedId = null;
    onSelect?.(null);
    notifyChange();
    requestDraw();
  }

  function onPointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    const point = localPoint(event);
    const proj = projection(canvas.clientWidth, canvas.clientHeight);
    canvas.setPointerCapture?.(event.pointerId);

    if (event.button === 1) {
      viewDrag = {
        startX: point.x,
        startY: point.y,
        view: { ...view },
        scale: proj.scale,
        moved: false,
      };
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (tool === 'select') {
      const selected = byId(selectedId);
      if (selected && !readOnly) {
        const index = hitVertex(selected, point, proj);
        if (index >= 0) {
          vertexDrag = {
            feature: selected,
            index,
            startX: point.x,
            startY: point.y,
            snapshot: snapshot(),
            changed: false,
          };
          return;
        }
      }
      const hit = hitFeature(point, proj);
      if (hit) {
        select(hit.id);
        return;
      }
      viewDrag = {
        startX: point.x,
        startY: point.y,
        view: { ...view },
        scale: proj.scale,
        moved: false,
      };
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (readOnly) return;
    const inside = point.x >= proj.ox && point.x <= proj.ox + proj.w && point.y >= proj.oy && point.y <= proj.oy + proj.h;
    if (!inside) return;
    const coord = screenToCoord(point.x, point.y, proj);
    if (tool === 'point') addPointFeature(coord);
    else if (tool === 'line' || tool === 'polygon') addDraftPoint(coord);
  }

  function onPointerMove(event) {
    const point = localPoint(event);
    const rect = canvas.getBoundingClientRect();
    const proj = projection(rect.width, rect.height);
    mouse = {
      x: point.x,
      y: point.y,
      inside: point.x >= proj.ox && point.x <= proj.ox + proj.w && point.y >= proj.oy && point.y <= proj.oy + proj.h,
      coord: screenToCoord(point.x, point.y, proj),
    };

    if (viewDrag) {
      const dx = point.x - viewDrag.startX;
      const dy = point.y - viewDrag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) viewDrag.moved = true;
      if (viewDrag.moved) {
        const spanX = viewDrag.view.east - viewDrag.view.west;
        const spanY = viewDrag.view.north - viewDrag.view.south;
        view.west = viewDrag.view.west - dx / viewDrag.scale;
        view.east = view.west + spanX;
        view.north = viewDrag.view.north + dy / viewDrag.scale;
        view.south = view.north - spanY;
      }
    } else if (vertexDrag) {
      if (
        !vertexDrag.changed &&
        Math.hypot(point.x - vertexDrag.startX, point.y - vertexDrag.startY) < 2
      ) {
        return;
      }
      vertexDrag.changed = true;
      const geometry = vertexDrag.feature.geometry;
      const next = coordRounded(mouse.coord);
      if (geometry.type === 'Point') {
        geometry.coordinates = next;
      } else if (geometry.type === 'LineString') {
        geometry.coordinates[vertexDrag.index] = next;
      } else if (geometry.type === 'Polygon') {
        const ring = geometry.coordinates[0];
        ring[vertexDrag.index] = next;
        ring[ring.length - 1] = [...ring[0]];
      }
    } else if (draft) {
      updateHud();
    } else {
      const hit = hitFeature(point, proj);
      canvas.style.cursor = hit ? 'pointer' : tool === 'select' ? 'grab' : 'crosshair';
    }
    updateHud();
    requestDraw();
  }

  function onPointerUp(event) {
    if (viewDrag) {
      const wasMoved = viewDrag.moved;
      viewDrag = null;
      canvas.style.cursor = tool === 'select' ? 'grab' : 'crosshair';
      if (!wasMoved && tool === 'select') select(null);
      requestDraw();
      return;
    }
    if (vertexDrag) {
      const finished = vertexDrag;
      vertexDrag = null;
      if (finished.changed) {
        pushHistory(finished.snapshot);
        notifyChange();
      }
      requestDraw();
      return;
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const proj = projection(rect.width, rect.height);
    const anchor = screenToCoord(point.x, point.y, proj);
    const spanX = view.east - view.west;
    const spanY = view.north - view.south;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const baseSpanX = Math.abs(bounds.east - bounds.west) || 1;
    const nextSpanX = clamp(spanX / factor, baseSpanX / 4000, baseSpanX * 10);
    const scaleRatio = nextSpanX / spanX;
    const fx = (anchor[0] - view.west) / spanX;
    const fy = (view.north - anchor[1]) / spanY;
    const nextSpanY = spanY * scaleRatio;
    view.west = anchor[0] - fx * nextSpanX;
    view.east = view.west + nextSpanX;
    view.north = anchor[1] + fy * nextSpanY;
    view.south = view.north - nextSpanY;
    requestDraw();
  }

  function onDoubleClick(event) {
    if (event.button !== 0) return;
    if (draft) {
      event.preventDefault();
      finishDraft();
    }
  }

  function fitView() {
    view = { ...bounds };
    requestDraw();
  }

  function openRegPanel() {
    if (!raster) return;
    regError.hidden = true;
    crsSelect.value = crs;
    westInput.value = String(round(bounds.west, 8));
    southInput.value = String(round(bounds.south, 8));
    eastInput.value = String(round(bounds.east, 8));
    northInput.value = String(round(bounds.north, 8));
    regPanel.hidden = false;
  }

  function closeRegPanel() {
    regPanel.hidden = true;
  }

  function toggleRegPanel() {
    if (regPanel.hidden) openRegPanel();
    else closeRegPanel();
  }

  function applyRegistration() {
    regError.hidden = true;
    const nextCrs = crsSelect.value === 'EPSG:4326' ? 'EPSG:4326' : 'pixel';
    const values = [westInput.value, southInput.value, eastInput.value, northInput.value].map(Number);
    if (!values.every(Number.isFinite)) {
      regError.textContent = '四至范围必须是数字';
      regError.hidden = false;
      return;
    }
    const [west, south, east, north] = values;
    if (west >= east || south >= north) {
      regError.textContent = '必须满足 west < east 且 south < north';
      regError.hidden = false;
      return;
    }
    if (nextCrs === 'EPSG:4326' && (west < -180 || east > 180 || south < -90 || north > 90)) {
      regError.textContent = '经纬度范围超出 [-180,180] × [-90,90]';
      regError.hidden = false;
      return;
    }
    const nextBounds = { west, south, east, north };
    if (features.length && (nextCrs !== crs || !sameBounds(boundsToArray(nextBounds), boundsToArray(bounds)))) {
      regError.textContent = `已有 ${features.length} 个要素，修改坐标系或范围会使既有坐标语义改变。请先删除要素。`;
      regError.hidden = false;
      return;
    }
    crs = nextCrs;
    bounds = nextBounds;
    view = { ...nextBounds };
    regPanel.hidden = true;
    updateCrsBadge();
    baseKey = '';
    toast('配准已更新，保存草稿后写入元数据', 'ok');
    notifyChange();
    requestDraw();
  }

  function updateCrsBadge() {
    crsBadge.textContent = crs === 'EPSG:4326' ? 'EPSG:4326' : '像素坐标';
    crsBadge.className = `badge ${crs === 'EPSG:4326' ? 'badge-info' : 'badge-accent'}`;
  }

  function focus(id) {
    const feature = byId(id);
    if (!feature) return;
    select(id);
    const positions = [];
    collectPositions(feature.geometry.coordinates, positions);
    if (!positions.length) return;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [x, y] of positions) {
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
    }
    const spanX = view.east - view.west;
    const spanY = view.north - view.south;
    if (west < view.west || east > view.east || south < view.south || north > view.north) {
      const padX = Math.max((east - west) * 0.35, spanX * 0.12);
      const padY = Math.max((north - south) * 0.35, spanY * 0.12);
      view = { west: west - padX, south: south - padY, east: east + padX, north: north + padY };
      requestDraw();
    }
    updateHud();
  }

  function onKeyDown(event) {
    if (isTyping(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key === 'Escape') {
      if (!regPanel.hidden) {
        closeRegPanel();
        return;
      }
      if (draft) {
        cancelDraft();
        return;
      }
      if (selectedId) select(null);
      return;
    }
    if (event.key === 'Enter' && draft) {
      event.preventDefault();
      finishDraft();
      return;
    }
    if (event.key === 'Backspace' && draft) {
      event.preventDefault();
      draft.points.pop();
      if (!draft.points.length) draft = null;
      updateHud();
      requestDraw();
      return;
    }
    if (readOnly) return;
    if (event.key === 'Delete' && selectedId) {
      event.preventDefault();
      removeFeature(selectedId);
      return;
    }
    const key = event.key.toLowerCase();
    const label = labels.find((entry) => entry.hotkey === key);
    if (label && (selectedId || draft)) {
      event.preventDefault();
      if (selectedId) changeLabel(selectedId, label.id);
      else currentLabel = label.id;
      return;
    }
    if (!mod) {
      if (key === 'v') setTool('select');
      else if (key === 'p') setTool('point');
      else if (key === 'l') setTool('line');
      else if (key === 'g') setTool('polygon');
    }
  }

  function onContextMenu(event) {
    event.preventDefault();
  }

  async function loadBase() {
    const token = ++loadToken;
    try {
      if (raster) {
        const image = new Image();
        image.onload = () => {
          if (token !== loadToken) return;
          baseImage = image;
          if (!Array.isArray(meta.bounds) && crs === 'pixel') {
            bounds = { west: 0, south: 0, east: image.naturalWidth, north: image.naturalHeight };
            view = { ...bounds };
          }
          baseVersion += 1;
          baseKey = '';
          requestDraw();
        };
        image.onerror = () => toast('栅格底图加载失败，仍可进行矢量标注', 'error');
        image.src = api.fileUrl(item.id);
      } else {
        const text = await api.fetchText(item.id);
        if (token !== loadToken) return;
        const parsed = JSON.parse(text);
        baseGeometries = extractGeometries(parsed);
        baseTruncated = baseGeometries.length >= 6000;
        if (!Array.isArray(meta.bounds)) {
          const derived = boundsOfGeometries(baseGeometries);
          if (derived) {
            bounds = { west: derived[0], south: derived[1], east: derived[2], north: derived[3] };
            view = { ...bounds };
          }
        }
        baseVersion += 1;
        baseKey = '';
        requestDraw();
      }
    } catch (error) {
      if (token !== loadToken) return;
      toast(`底图加载失败：${error.message}`, 'error');
    }
  }

  const resizeObserver = new ResizeObserver(() => {
    baseKey = '';
    requestDraw();
  });
  resizeObserver.observe(wrap);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('auxclick', (event) => event.preventDefault());
  window.addEventListener('keydown', onKeyDown);

  updateCrsBadge();
  updateHud();
  requestDraw();
  loadBase();

  return {
    getData,
    getMetaPatch,
    setLabel(labelId) {
      currentLabel = labelId;
      if (selectedId) changeLabel(selectedId, labelId);
    },
    setNote(value) {
      note = value;
    },
    focus,
    remove: removeFeature,
    selected: () => selectedId,
    currentLabel: () => currentLabel,
    destroy() {
      loadToken += 1;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };
}
