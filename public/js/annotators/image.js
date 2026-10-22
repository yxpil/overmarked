import { api } from '../api.js';
import { el, clear, toast } from '../ui.js';
import {
  clamp,
  contrastInk,
  drawLabelTag,
  hexToRgba,
  isTyping,
  labelNameMap,
  newId,
  pointInPolygon,
  round,
  shapeBBox,
} from './shared.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createImageAnnotator(host, { item, schema, data, readOnly = false, onChange, onSelect }) {
  const labelMap = labelNameMap(schema);
  const root = el('div', { className: 'annotator' });
  const wrap = el('div', { className: 'annotator-canvas-wrap' });
  const canvas = el('canvas');
  const loader = el('div', { className: 'stage-empty' }, el('span', { className: 'spinner' }), el('p', { text: '加载图片…' }));
  const tip = el('div', { className: 'canvas-tip' });

  const toolDefs = [
    ['select', 'cursor', '选择 (V)'],
    ['box', 'box', '矩形 (B)'],
    ['polygon', 'polygon', '多边形 (P)'],
  ];
  const toolButtons = new Map();
  const tools = el('div', { className: 'canvas-tools' });
  for (const [id, iconName, title] of toolDefs) {
    const button = el(
      'button',
      {
        className: `tool-btn${id === 'select' ? ' active' : ''}`,
        title,
        type: 'button',
        onClick: () => setTool(id),
      },
      el('span', { className: 'icon', html: iconSvg(iconName) })
    );
    if (readOnly && id !== 'select') button.hidden = true;
    toolButtons.set(id, button);
    tools.append(button);
  }
  tools.append(el('div', { className: 'tool-sep' }));
  tools.append(
    el(
      'button',
      { className: 'tool-btn', title: '适配画布 (F)', type: 'button', onClick: fit },
      el('span', { className: 'icon', html: iconSvg('fit') })
    )
  );

  const zoomValue = el('span', { className: 'zoom-val', text: '100%' });
  const hud = el(
    'div',
    { className: 'canvas-hud' },
    el('button', { title: '缩小', type: 'button', onClick: () => zoomBy(0.8) }, el('span', { className: 'icon', html: iconSvg('zoomOut') })),
    zoomValue,
    el('button', { title: '放大', type: 'button', onClick: () => zoomBy(1.25) }, el('span', { className: 'icon', html: iconSvg('zoomIn') })),
    el('button', { title: '适配画布', type: 'button', onClick: fit }, el('span', { className: 'icon', html: iconSvg('fit') }))
  );

  wrap.append(canvas, tools, hud, tip, loader);
  root.append(wrap);
  host.append(root);

  let shapes = clone(Array.isArray(data?.shapes) ? data.shapes : []);
  let note = typeof data?.note === 'string' ? data.note : '';
  let selectedId = null;
  let currentLabel = shapes[0]?.label || schema.labels?.[0]?.id || null;
  let tool = 'select';
  let transform = { scale: 1, tx: 0, ty: 0 };
  let interacted = false;
  let spaceDown = false;
  let draft = null;
  let drag = null;
  let mouseWorld = null;
  const history = [];
  const future = [];

  const image = new Image();
  let loaded = false;
  let imageW = 0;
  let imageH = 0;

  function iconSvg(name) {
    const paths = {
      cursor: '<path d="m5 3 6.5 16 2.2-6.3L20 10.5 5 3Z"/>',
      box: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 3"/>',
      polygon: '<path d="m12 3 8 6-3 10H7L4 9l8-6Z"/>',
      fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
      zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2M8 11h6M11 8v6"/>',
      zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2M8 11h6"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
  }

  function notifyChange() {
    onChange?.(getData());
  }

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    onSelect?.(id);
    draw();
  }

  function updateTip() {
    if (readOnly) {
      tip.textContent = '只读模式 · 滚轮缩放 · 空格拖拽平移';
      return;
    }
    if (tool === 'box') tip.textContent = '拖拽绘制矩形 · 数字键切换标签';
    else if (tool === 'polygon') tip.textContent = '单击落点 · 双击或 Enter 闭合 · Esc 取消';
    else tip.textContent = '点选图元 · 拖拽移动 · 滚轮缩放 · 空格或空白处拖动平移';
  }

  function setTool(next) {
    if (readOnly && next !== 'select') return;
    if (tool === 'polygon' && draft?.type === 'polygon') finishPolygon(false);
    draft = null;
    tool = next;
    for (const [id, button] of toolButtons) button.classList.toggle('active', id === tool);
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    updateTip();
    draw();
  }

  function byId(id) {
    return shapes.find((shape) => shape.id === id) || null;
  }

  function getData() {
    return {
      shapes: shapes.map((shape) =>
        shape.type === 'box'
          ? { id: shape.id, type: 'box', label: shape.label, x: round(shape.x, 2), y: round(shape.y, 2), w: round(shape.w, 2), h: round(shape.h, 2) }
          : { id: shape.id, type: 'polygon', label: shape.label, points: shape.points.map((p) => ({ x: round(p.x, 2), y: round(p.y, 2) })) }
      ),
      note,
    };
  }

  function pushHistory() {
    history.push(JSON.stringify(shapes));
    if (history.length > 80) history.shift();
    future.length = 0;
  }

  function undo() {
    if (!history.length) return;
    future.push(JSON.stringify(shapes));
    shapes = JSON.parse(history.pop());
    selectedId = null;
    onSelect?.(null);
    notifyChange();
    draw();
  }

  function redo() {
    if (!future.length) return;
    history.push(JSON.stringify(shapes));
    shapes = JSON.parse(future.pop());
    selectedId = null;
    onSelect?.(null);
    notifyChange();
    draw();
  }

  function fit() {
    const vw = wrap.clientWidth;
    const vh = wrap.clientHeight;
    if (!imageW || !imageH || !vw || !vh) return;
    const scale = Math.min(vw / imageW, vh / imageH) * 0.94;
    transform = { scale, tx: (vw - imageW * scale) / 2, ty: (vh - imageH * scale) / 2 };
    interacted = false;
    updateHud();
    draw();
  }

  function zoomBy(factor, anchor = null) {
    const vw = wrap.clientWidth;
    const vh = wrap.clientHeight;
    const next = clamp(transform.scale * factor, 0.02, 24);
    const ax = anchor ? anchor.x : vw / 2;
    const ay = anchor ? anchor.y : vh / 2;
    const worldX = (ax - transform.tx) / transform.scale;
    const worldY = (ay - transform.ty) / transform.scale;
    transform = {
      scale: next,
      tx: ax - worldX * next,
      ty: ay - worldY * next,
    };
    interacted = true;
    updateHud();
    draw();
  }

  function updateHud() {
    zoomValue.textContent = `${Math.round(transform.scale * 100)}%`;
  }

  function toWorld(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - transform.tx) / transform.scale,
      y: (event.clientY - rect.top - transform.ty) / transform.scale,
    };
  }

  function toScreen(point) {
    return { x: point.x * transform.scale + transform.tx, y: point.y * transform.scale + transform.ty };
  }

  function clampWorld(point) {
    if (!imageW || !imageH) return point;
    return { x: clamp(point.x, 0, imageW), y: clamp(point.y, 0, imageH) };
  }

  function shapeHit(point) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const shape = shapes[i];
      if (shape.type === 'box') {
        if (point.x >= shape.x && point.x <= shape.x + shape.w && point.y >= shape.y && point.y <= shape.y + shape.h) return shape;
      } else if (pointInPolygon(point, shape.points)) {
        return shape;
      }
    }
    return null;
  }

  function handlePositions(shape) {
    if (shape.type !== 'box') return [];
    const { x, y, w, h } = shape;
    return [
      ['nw', x, y],
      ['n', x + w / 2, y],
      ['ne', x + w, y],
      ['e', x + w, y + h / 2],
      ['se', x + w, y + h],
      ['s', x + w / 2, y + h],
      ['sw', x, y + h],
      ['w', x, y + h / 2],
    ].map(([id, px, py]) => ({ id, ...toScreen({ x: px, y: py }) }));
  }

  function hitHandle(event, shape) {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    for (const handle of handlePositions(shape)) {
      if (Math.abs(mx - handle.x) <= 7 && Math.abs(my - handle.y) <= 7) return handle.id;
    }
    return null;
  }

  function hitVertex(event, shape) {
    if (shape.type !== 'polygon') return -1;
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    for (let i = 0; i < shape.points.length; i++) {
      const screen = toScreen(shape.points[i]);
      if (Math.hypot(mx - screen.x, my - screen.y) <= 7) return i;
    }
    return -1;
  }

  function resizeBox(orig, handle, point) {
    let left = orig.x;
    let top = orig.y;
    let right = orig.x + orig.w;
    let bottom = orig.y + orig.h;
    if (handle.includes('w')) left = Math.min(point.x, right - 2);
    if (handle.includes('e')) right = Math.max(point.x, left + 2);
    if (handle.includes('n')) top = Math.min(point.y, bottom - 2);
    if (handle.includes('s')) bottom = Math.max(point.y, top + 2);
    if (imageW) {
      left = clamp(left, 0, imageW);
      right = clamp(right, 0, imageW);
    }
    if (imageH) {
      top = clamp(top, 0, imageH);
      bottom = clamp(bottom, 0, imageH);
    }
    return { x: left, y: top, w: Math.max(2, right - left), h: Math.max(2, bottom - top) };
  }

  function moveShape(shape, orig, dx, dy) {
    if (imageW && imageH) {
      const box = shapeBBox(orig);
      dx = clamp(dx, -box.x, imageW - (box.x + box.w));
      dy = clamp(dy, -box.y, imageH - (box.y + box.h));
    }
    if (shape.type === 'box') {
      shape.x = orig.x + dx;
      shape.y = orig.y + dy;
    } else {
      shape.points = orig.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
    }
  }

  function finishPolygon(commit = true) {
    if (!draft || draft.type !== 'polygon') return;
    const points = draft.points;
    draft = null;
    if (commit && points.length >= 3) {
      pushHistory();
      const shape = { id: newId(), type: 'polygon', label: currentLabel, points };
      shapes.push(shape);
      selectedId = shape.id;
      onSelect?.(shape.id);
      notifyChange();
    }
    draw();
  }

  function removeShape(id) {
    if (readOnly) return;
    const index = shapes.findIndex((shape) => shape.id === id);
    if (index < 0) return;
    pushHistory();
    shapes.splice(index, 1);
    if (selectedId === id) {
      selectedId = null;
      onSelect?.(null);
    }
    notifyChange();
    draw();
  }

  function draw() {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#0a0c0d';
    ctx.fillRect(0, 0, rect.width, rect.height);
    if (!loaded) return;

    ctx.imageSmoothingEnabled = transform.scale < 2;
    ctx.drawImage(image, transform.tx, transform.ty, imageW * transform.scale, imageH * transform.scale);
    ctx.strokeStyle = '#262b30';
    ctx.lineWidth = 1;
    ctx.strokeRect(transform.tx + 0.5, transform.ty + 0.5, imageW * transform.scale, imageH * transform.scale);

    for (const shape of shapes) {
      const label = labelMap.get(shape.label);
      const color = label?.color || '#f5a524';
      const selected = shape.id === selectedId;
      ctx.lineWidth = selected ? 2 : 1.4;
      ctx.strokeStyle = selected ? '#ffffff' : color;
      ctx.fillStyle = hexToRgba(color, selected ? 0.22 : 0.13);
      ctx.beginPath();
      if (shape.type === 'box') {
        const p = toScreen({ x: shape.x, y: shape.y });
        ctx.rect(p.x, p.y, shape.w * transform.scale, shape.h * transform.scale);
      } else {
        shape.points.forEach((point, index) => {
          const p = toScreen(point);
          if (index === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();

      const box = shapeBBox(shape);
      const topLeft = toScreen({ x: box.x, y: box.y });
      const chip = label?.name || shape.label;
      drawLabelTag(ctx, chip, topLeft.x, topLeft.y - 2, color, contrastInk(color));

      if (selected) {
        if (shape.type === 'box') {
          ctx.fillStyle = '#0c0e10';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          for (const handle of handlePositions(shape)) {
            ctx.beginPath();
            ctx.rect(handle.x - 3.5, handle.y - 3.5, 7, 7);
            ctx.fill();
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = '#0c0e10';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          for (const point of shape.points) {
            const p = toScreen(point);
            ctx.beginPath();
            ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7);
            ctx.fill();
            ctx.stroke();
          }
        }
      }
    }

    if (draft?.type === 'box') {
      const p1 = toScreen(draft.start);
      const p2 = toScreen(draft.current);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = labelMap.get(currentLabel)?.color || '#f5a524';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      ctx.setLineDash([]);
    }
    if (draft?.type === 'polygon') {
      const color = labelMap.get(currentLabel)?.color || '#f5a524';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      draft.points.forEach((point, index) => {
        const p = toScreen(point);
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (mouseWorld) {
        const m = toScreen(mouseWorld);
        ctx.lineTo(m.x, m.y);
      }
      ctx.stroke();
      for (const point of draft.points) {
        const p = toScreen(point);
        ctx.fillStyle = '#0c0e10';
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  function onPointerDown(event) {
    if (event.button === 2) return;
    canvas.setPointerCapture?.(event.pointerId);
    const world = toWorld(event);
    const panButton = event.button === 1 || spaceDown;
    if (panButton) {
      drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, orig: { ...transform } };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (readOnly) {
      if (tool === 'select') {
        const hit = shapeHit(world);
        select(hit?.id || null);
      }
      return;
    }
    if (tool === 'select') {
      const selected = byId(selectedId);
      if (selected) {
        const handle = hitHandle(event, selected);
        if (handle) {
          pushHistory();
          drag = { kind: 'resize', shape: selected, handle, orig: clone(selected), moved: false };
          return;
        }
        const vertex = hitVertex(event, selected);
        if (vertex >= 0) {
          pushHistory();
          drag = { kind: 'vertex', shape: selected, index: vertex, moved: false };
          return;
        }
      }
      const hit = shapeHit(world);
      if (hit) {
        select(hit.id);
        pushHistory();
        drag = { kind: 'move', shape: hit, orig: clone(hit), start: world, moved: false };
        canvas.style.cursor = 'grabbing';
        return;
      }
      select(null);
      drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, orig: { ...transform } };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (tool === 'box') {
      const point = clampWorld(world);
      draft = { type: 'box', start: point, current: point };
      draw();
      return;
    }
    if (tool === 'polygon') {
      const point = clampWorld(world);
      if (!draft) {
        draft = { type: 'polygon', points: [point], mouse: point };
        draw();
        return;
      }
      const first = toScreen(draft.points[0]);
      const current = toScreen(point);
      if (draft.points.length >= 3 && Math.hypot(first.x - current.x, first.y - current.y) < 9) {
        finishPolygon();
        return;
      }
      const last = draft.points[draft.points.length - 1];
      if (Math.hypot(last.x - point.x, last.y - point.y) * transform.scale > 2) {
        draft.points.push(point);
      }
      draft.mouse = point;
      draw();
    }
  }

  function onPointerMove(event) {
    const world = toWorld(event);
    mouseWorld = world;
    if (draft?.type === 'polygon') {
      draft.mouse = clampWorld(world);
      draw();
      return;
    }
    if (draft?.type === 'box') {
      draft.current = clampWorld(world);
      draw();
      return;
    }
    if (!drag) {
      if (tool === 'select' && !readOnly) {
        canvas.style.cursor = spaceDown ? 'grab' : shapeHit(world) ? 'move' : 'default';
      }
      return;
    }
    if (drag.kind === 'pan') {
      transform = {
        ...transform,
        tx: drag.orig.tx + (event.clientX - drag.startX),
        ty: drag.orig.ty + (event.clientY - drag.startY),
      };
      interacted = true;
      draw();
      return;
    }
    if (drag.kind === 'move') {
      const dx = world.x - drag.start.x;
      const dy = world.y - drag.start.y;
      if (Math.abs(dx) || Math.abs(dy)) drag.moved = true;
      moveShape(drag.shape, drag.orig, dx, dy);
      draw();
      return;
    }
    if (drag.kind === 'resize') {
      Object.assign(drag.shape, resizeBox(drag.orig, drag.handle, clampWorld(world)));
      drag.moved = true;
      draw();
      return;
    }
    if (drag.kind === 'vertex') {
      drag.shape.points[drag.index] = clampWorld(world);
      drag.moved = true;
      draw();
    }
  }

  function onPointerUp(event) {
    canvas.releasePointerCapture?.(event.pointerId);
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    if (draft?.type === 'box') {
      const box = {
        x: Math.min(draft.start.x, draft.current.x),
        y: Math.min(draft.start.y, draft.current.y),
        w: Math.abs(draft.current.x - draft.start.x),
        h: Math.abs(draft.current.y - draft.start.y),
      };
      if (box.w * transform.scale > 3 && box.h * transform.scale > 3) {
        pushHistory();
        const shape = { id: newId(), type: 'box', label: currentLabel, ...box };
        shapes.push(shape);
        selectedId = shape.id;
        onSelect?.(shape.id);
        notifyChange();
      }
      draft = null;
      draw();
      return;
    }
    if (drag) {
      if (drag.kind === 'move' && drag.moved && drag.shape) {
        Object.assign(drag.shape, {});
        notifyChange();
      }
      if ((drag.kind === 'resize' || drag.kind === 'vertex') && drag.moved) notifyChange();
      drag = null;
      draw();
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomBy(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  function onDoubleClick(event) {
    if (tool === 'polygon' && draft?.type === 'polygon') {
      event.preventDefault();
      finishPolygon();
    }
  }

  function onKeyDown(event) {
    if (isTyping(event.target)) return;
    if (event.code === 'Space') {
      spaceDown = true;
      if (!drag) canvas.style.cursor = 'grab';
      event.preventDefault();
      return;
    }
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
    if (readOnly) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedId) {
        event.preventDefault();
        removeShape(selectedId);
      }
      return;
    }
    if (event.key === 'Escape') {
      if (draft) {
        draft = null;
        draw();
      } else if (selectedId) select(null);
      return;
    }
    if (event.key === 'Enter' && draft?.type === 'polygon') {
      event.preventDefault();
      finishPolygon();
      return;
    }
    if (!mod) {
      const key = event.key.toLowerCase();
      if (key === 'v') setTool('select');
      else if (key === 'b') setTool('box');
      else if (key === 'p') setTool('polygon');
      else if (key === 'f') fit();
    }
  }

  function onKeyUp(event) {
    if (event.code === 'Space') {
      spaceDown = false;
      if (!drag) canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    }
  }

  function onContextMenu(event) {
    event.preventDefault();
  }

  function focus(id) {
    const shape = byId(id);
    if (!shape) return;
    select(id);
    const box = shapeBBox(shape);
    const vw = wrap.clientWidth;
    const vh = wrap.clientHeight;
    const p1 = toScreen({ x: box.x, y: box.y });
    const p2 = toScreen({ x: box.x + box.w, y: box.y + box.h });
    if (p1.x < 0 || p1.y < 0 || p2.x > vw || p2.y > vh) {
      const cx = (box.x + box.w / 2) * transform.scale;
      const cy = (box.y + box.h / 2) * transform.scale;
      transform.tx = vw / 2 - cx;
      transform.ty = vh / 2 - cy;
      draw();
    }
  }

  function setLabel(labelId) {
    currentLabel = labelId;
    const shape = byId(selectedId);
    if (shape && !readOnly && shape.label !== labelId) {
      pushHistory();
      shape.label = labelId;
      notifyChange();
      draw();
    }
  }

  image.addEventListener('load', () => {
    imageW = image.naturalWidth;
    imageH = image.naturalHeight;
    loaded = true;
    loader.remove();
    fit();
    updateTip();
  });
  image.addEventListener('error', () => {
    loader.querySelector('.spinner')?.remove();
    const text = loader.querySelector('p');
    if (text) text.textContent = '图片加载失败，请检查文件是否仍然存在。';
    toast('图片加载失败', 'error');
  });
  image.src = api.fileUrl(item.id);

  const resizeObserver = new ResizeObserver(() => {
    if (!loaded) return;
    if (!interacted) fit();
    else draw();
  });
  resizeObserver.observe(wrap);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  updateTip();
  updateHud();
  requestAnimationFrame(() => {
    if (!loaded) draw();
  });

  return {
    getData,
    getMetaPatch: () =>
      imageW && !item.meta?.width ? { width: imageW, height: imageH } : null,
    setLabel,
    setNote(value) {
      note = value;
    },
    focus,
    remove: removeShape,
    destroy() {
      resizeObserver.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      image.src = '';
      root.remove();
    },
  };
}
