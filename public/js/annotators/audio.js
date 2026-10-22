import { api } from '../api.js';
import { clear, el, icon, toast } from '../ui.js';
import { canvasMetrics, clamp, drawLabelTag, hexToRgba, isTyping, labelNameMap, newId, round } from './shared.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00.0';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  const secText = seconds.toFixed(1).padStart(4, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secText}` : `${minutes}:${secText}`;
}

function niceStep(span, target = 8) {
  const raw = span / target;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const factor of [1, 2, 5, 10]) {
    if (factor * power >= raw) return factor * power;
  }
  return 10 * power;
}

function computePeaks(buffer, buckets = 2400) {
  const data = buffer.getChannelData(0);
  const count = Math.min(buckets, Math.max(1, data.length));
  const size = Math.max(1, Math.floor(data.length / count));
  const peaks = [];
  let maxAbs = 1e-7;
  for (let i = 0; i < count; i++) {
    const start = i * size;
    const end = Math.min(data.length, start + size);
    let min = 0;
    let max = 0;
    for (let j = start; j < end; j++) {
      const value = data[j];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    peaks.push({ min, max });
    maxAbs = Math.max(maxAbs, Math.abs(min), Math.abs(max));
  }
  for (const peak of peaks) {
    peak.min /= maxAbs;
    peak.max /= maxAbs;
  }
  return peaks;
}

export function createAudioAnnotator(host, { item, schema, data, readOnly = false, onChange, onSelect }) {
  const labelMap = labelNameMap(schema);
  const labels = schema.labels || [];
  const root = el('div', { className: 'audio-annotator' });

  const playButton = el(
    'button',
    { className: 'transport-btn', type: 'button', title: '播放 / 暂停 (Space)', onClick: togglePlay },
    icon('play')
  );
  const currentTime = el('b', { text: '0:00.0' });
  const durationTime = el('span', { text: '/ 0:00.0' });
  const loopButton = el(
    'button',
    {
      className: 'btn btn-sm',
      type: 'button',
      title: '循环播放选中区段；未选中时循环整段音频',
      onClick: toggleLoop,
    },
    icon('loop'),
    '循环'
  );
  const segmentCount = el('span', { className: 'field-hint', style: { margin: '0', fontSize: '10px' } });
  const toolbar = el(
    'div',
    { className: 'audio-toolbar' },
    playButton,
    el('span', { className: 'time' }, currentTime, durationTime),
    loopButton,
    el('div', { style: { flex: '1' } }),
    segmentCount
  );

  const wrap = el('div', { className: 'wave-wrap' });
  const canvas = el('canvas');
  const loader = el(
    'div',
    { className: 'audio-empty' },
    el('span', { className: 'spinner' }),
    el('p', { text: '正在解码音频…', style: { marginTop: '8px' } })
  );
  const helpLeft = el('span', { text: readOnly ? '只读模式 · 点击选择区段' : '拖拽波形新建区段 · 拖动区段移动 · 拖动边缘调整' });
  const helpRight = el('span', { text: 'Space 播放 · ←/→ 跳转 · Delete 删除' });
  const help = el('div', { className: 'audio-help' }, helpLeft, helpRight);

  wrap.append(canvas, loader);
  root.append(toolbar, wrap, help);
  host.append(root);

  let buffer = null;
  let duration = typeof item.meta?.duration === 'number' ? item.meta.duration : 0;
  let peaks = null;
  let segments = clone(Array.isArray(data?.segments) ? data.segments : []);
  let note = typeof data?.note === 'string' ? data.note : '';
  let selectedId = null;
  let currentLabel = segments[0]?.label || labels[0]?.id || null;
  let draft = null;
  let drag = null;
  let position = 0;
  let playing = false;
  let loopEnabled = false;
  let audioContext = null;
  let source = null;
  let startedAt = 0;
  let rafId = 0;
  let loadToken = 0;
  const history = [];
  const future = [];

  function snapshot() {
    return JSON.stringify(segments);
  }

  function getData() {
    return {
      segments: segments
        .map((segment) => ({
          id: segment.id,
          start: round(segment.start, 3),
          end: round(segment.end, 3),
          label: segment.label,
        }))
        .sort((a, b) => a.start - b.start),
      note,
    };
  }

  function notifyChange() {
    updateCount();
    onChange?.(getData());
  }

  function pushHistory(snap = snapshot()) {
    history.push(snap);
    if (history.length > 100) history.shift();
    future.length = 0;
  }

  function updateCount() {
    segmentCount.textContent = duration ? `${segments.length} 段 · ${formatTime(duration)}` : `${segments.length} 段`;
    durationTime.textContent = `/ ${formatTime(duration)}`;
  }

  function byId(id) {
    return segments.find((segment) => segment.id === id) || null;
  }

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    onSelect?.(id);
    draw();
  }

  function colorOf(labelId) {
    return labelMap.get(labelId)?.color || '#f5a524';
  }

  function nameOf(labelId) {
    return labelMap.get(labelId)?.name || labelId;
  }

  function currentCanvasWidth() {
    return Math.max(1, wrap.clientWidth);
  }

  function timeToX(time, width) {
    return duration ? (time / duration) * width : 0;
  }

  function xToTime(x, width) {
    return duration ? clamp((x / Math.max(1, width)) * duration, 0, duration) : 0;
  }

  function draw() {
    const { ctx, w, h } = canvasMetrics(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0d0f';
    ctx.fillRect(0, 0, w, h);
    if (!w || !h) return;

    const waveTop = 30;
    const waveBottom = h - 22;
    const mid = (waveTop + waveBottom) / 2;
    const amplitude = Math.max(4, (waveBottom - waveTop) / 2 - 4);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.fillStyle = 'rgba(139,148,158,0.75)';
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'alphabetic';
    if (duration > 0) {
      const step = niceStep(duration, Math.max(4, Math.floor(w / 120)));
      for (let time = 0; time <= duration + 1e-6; time += step) {
        const x = Math.round(timeToX(time, w)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, waveTop);
        ctx.lineTo(x, waveBottom);
        ctx.stroke();
        const label = formatTime(time).replace(/\.\d$/, '');
        ctx.fillText(label, Math.min(x + 4, w - 38), h - 8);
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(w, mid + 0.5);
    ctx.stroke();

    if (peaks?.length) {
      const count = peaks.length;
      ctx.strokeStyle = '#46525c';
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const peak = peaks[Math.min(count - 1, Math.floor((x / w) * count))];
        const y1 = mid - peak.max * amplitude;
        const y2 = mid - peak.min * amplitude;
        ctx.moveTo(x + 0.5, y1);
        ctx.lineTo(x + 0.5, Math.max(y2, y1 + 0.6));
      }
      ctx.stroke();
    }

    for (const segment of segments) {
      const color = colorOf(segment.label);
      const x1 = timeToX(segment.start, w);
      const x2 = timeToX(segment.end, w);
      const selected = segment.id === selectedId;
      ctx.fillStyle = hexToRgba(color, selected ? 0.22 : 0.13);
      ctx.fillRect(x1, waveTop, Math.max(1, x2 - x1), waveBottom - waveTop);
      ctx.fillStyle = color;
      ctx.fillRect(x1, 4, Math.max(1, x2 - x1), 16);
      ctx.strokeStyle = selected ? '#f2f4f6' : hexToRgba(color, 0.8);
      ctx.lineWidth = selected ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x1 + 0.5, 4);
      ctx.lineTo(x1 + 0.5, waveBottom);
      ctx.moveTo(x2 - 0.5, 4);
      ctx.lineTo(x2 - 0.5, waveBottom);
      ctx.stroke();
      if (selected) {
        ctx.strokeRect(x1 + 0.5, 4.5, Math.max(1, x2 - x1 - 1), waveBottom - 4);
        ctx.fillStyle = '#f2f4f6';
        ctx.fillRect(x1 - 2, 3, 4, waveBottom - 3);
        ctx.fillRect(x2 - 2, 3, 4, waveBottom - 3);
      }
      if (x2 - x1 > 26) {
        const label = nameOf(segment.label);
        drawLabelTag(ctx, label, x1 + 2, 18, color);
      }
    }

    if (draft) {
      const color = colorOf(currentLabel);
      const x1 = timeToX(draft.start, w);
      const x2 = timeToX(draft.end, w);
      ctx.fillStyle = hexToRgba(color, 0.18);
      ctx.fillRect(x1, waveTop, Math.max(1, x2 - x1), waveBottom - waveTop);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color;
      ctx.strokeRect(x1 + 0.5, waveTop + 0.5, Math.max(1, x2 - x1 - 1), waveBottom - waveTop - 1);
      ctx.setLineDash([]);
    }

    if (duration > 0) {
      const x = timeToX(position, w);
      ctx.strokeStyle = '#f5a524';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 2);
      ctx.lineTo(x + 0.5, waveBottom + 4);
      ctx.stroke();
      ctx.fillStyle = '#f5a524';
      ctx.beginPath();
      ctx.moveTo(x - 4, 2);
      ctx.lineTo(x + 4, 2);
      ctx.lineTo(x, 8);
      ctx.closePath();
      ctx.fill();
    }
  }

  function playFrom(offset) {
    if (!audioContext || !buffer) return;
    stopSource();
    const start = clamp(offset, 0, Math.max(0, duration - 0.001));
    source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      if (!playing) return;
      if (loopEnabled) {
        const range = loopRange();
        playFrom(range?.start ?? 0);
        position = range?.start ?? 0;
      } else {
        stopPlaybackAtEnd();
      }
    };
    source.start(0, start);
    startedAt = audioContext.currentTime - start;
    position = start;
  }

  function loopRange() {
    const segment = byId(selectedId);
    if (loopEnabled && segment) return { start: segment.start, end: segment.end };
    if (loopEnabled) return { start: 0, end: duration };
    return null;
  }

  function tick() {
    if (!playing || !audioContext) return;
    let next = clamp(audioContext.currentTime - startedAt, 0, duration);
    const range = loopRange();
    if (range && next >= range.end - 0.02) {
      playFrom(range.start);
      next = range.start;
    } else if (next >= duration - 0.01) {
      position = duration;
      updateTime();
      draw();
      pause();
      return;
    }
    position = next;
    updateTime();
    draw();
    rafId = requestAnimationFrame(tick);
  }

  async function togglePlay() {
    if (!buffer) return;
    if (playing) {
      pause();
      return;
    }
    try {
      if (!audioContext) return;
      if (audioContext.state === 'suspended') await audioContext.resume();
      if (position >= duration - 0.01) position = 0;
      if (loopEnabled) {
        const range = loopRange();
        if (range && (position < range.start || position >= range.end)) position = range.start;
      }
      playing = true;
      updatePlayButton();
      playFrom(position);
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    } catch (error) {
      toast(`无法播放：${error.message}`, 'error');
    }
  }

  function pause() {
    playing = false;
    stopSource();
    cancelAnimationFrame(rafId);
    updatePlayButton();
    updateTime();
    draw();
  }

  function stopPlaybackAtEnd() {
    playing = false;
    stopSource();
    position = 0;
    cancelAnimationFrame(rafId);
    updatePlayButton();
    updateTime();
    draw();
  }

  function stopSource() {
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
    source = null;
  }

  function seek(time) {
    position = clamp(time, 0, duration);
    if (playing) playFrom(position);
    updateTime();
    draw();
  }

  function updateTime() {
    currentTime.textContent = formatTime(position);
  }

  function updatePlayButton() {
    clear(playButton);
    playButton.append(icon(playing ? 'pause' : 'play'));
    playButton.classList.toggle('playing', playing);
  }

  function toggleLoop() {
    loopEnabled = !loopEnabled;
    loopButton.classList.toggle('btn-primary', loopEnabled);
    draw();
  }

  function segmentsAt(x, width) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i];
      const x1 = timeToX(segment.start, width);
      const x2 = timeToX(segment.end, width);
      if (x - 6 <= x1 && x >= x1 - 6) return { segment, mode: 'resize-l' };
      if (Math.abs(x - x2) <= 6) return { segment, mode: 'resize-r' };
      if (x > x1 && x < x2) return { segment, mode: 'move' };
      if (x >= x1 - 2 && x <= x2 + 2) return { segment, mode: 'move' };
    }
    return null;
  }

  function localX(event) {
    return event.clientX - canvas.getBoundingClientRect().left;
  }

  function onPointerDown(event) {
    if (!duration || event.button !== 0) return;
    event.preventDefault();
    const width = currentCanvasWidth();
    const x = localX(event);
    const time = xToTime(x, width);
    const hit = segmentsAt(x, width);
    canvas.setPointerCapture?.(event.pointerId);

    if (hit) {
      select(hit.segment.id);
      if (readOnly) return;
      drag = {
        mode: hit.mode,
        id: hit.segment.id,
        startX: x,
        snapshot: snapshot(),
        orig: { ...hit.segment },
        changed: false,
      };
      return;
    }

    if (readOnly) {
      seek(time);
      return;
    }
    drag = {
      mode: 'create',
      startX: x,
      startTime: time,
      snapshot: snapshot(),
      changed: false,
    };
    draft = { start: time, end: time };
    select(null);
    draw();
  }

  function onPointerMove(event) {
    if (!duration) return;
    const width = currentCanvasWidth();
    const x = localX(event);
    const time = xToTime(x, width);
    helpRight.textContent = `光标 ${formatTime(time)} · Space 播放 · ←/→ 跳转`;
    if (!drag) {
      const hit = segmentsAt(x, width);
      canvas.style.cursor = hit ? (hit.mode === 'move' ? 'grab' : 'ew-resize') : readOnly ? 'default' : 'crosshair';
      return;
    }
    if (Math.abs(x - drag.startX) >= 2) drag.changed = true;
    if (drag.mode === 'create') {
      draft = {
        start: Math.min(drag.startTime, time),
        end: Math.max(drag.startTime, time),
      };
      canvas.style.cursor = 'crosshair';
      draw();
      return;
    }
    if (!drag.changed) return;
    const segment = byId(drag.id);
    if (!segment) return;
    const delta = xToTime(x, width) - xToTime(drag.startX, width);
    if (drag.mode === 'move') {
      const length = drag.orig.end - drag.orig.start;
      const start = clamp(drag.orig.start + delta, 0, Math.max(0, duration - length));
      segment.start = start;
      segment.end = start + length;
      canvas.style.cursor = 'grabbing';
    } else if (drag.mode === 'resize-l') {
      segment.start = clamp(drag.orig.start + delta, 0, drag.orig.end - 0.05);
      segment.end = drag.orig.end;
      canvas.style.cursor = 'ew-resize';
    } else {
      segment.start = drag.orig.start;
      segment.end = clamp(drag.orig.end + delta, drag.orig.start + 0.05, duration);
      canvas.style.cursor = 'ew-resize';
    }
    draw();
  }

  function onPointerUp(event) {
    if (!drag) return;
    const finished = drag;
    drag = null;
    canvas.releasePointerCapture?.(event.pointerId);
    if (finished.mode === 'create') {
      const start = draft?.start ?? finished.startTime;
      const end = draft?.end ?? finished.startTime;
      draft = null;
      if (!readOnly && finished.changed && end - start >= 0.05 && currentLabel) {
        pushHistory(finished.snapshot);
        const id = newId();
        segments.push({ id, start, end, label: currentLabel });
        segments.sort((a, b) => a.start - b.start);
        selectedId = id;
        onSelect?.(id);
        notifyChange();
        draw();
      } else {
        seek(start);
      }
      return;
    }
    if (finished.changed && !readOnly) {
      pushHistory(finished.snapshot);
      notifyChange();
    }
    draw();
  }

  function onPointerCancel(event) {
    if (!drag) return;
    const finished = drag;
    drag = null;
    draft = null;
    if (finished.mode !== 'create' && finished.changed && !readOnly) {
      pushHistory(finished.snapshot);
      notifyChange();
    }
    draw();
  }

  function removeSegment(id) {
    if (readOnly) return;
    const segment = byId(id);
    if (!segment) return;
    pushHistory();
    segments = segments.filter((entry) => entry.id !== id);
    if (selectedId === id) {
      selectedId = null;
      onSelect?.(null);
    }
    notifyChange();
    draw();
  }

  function changeLabel(id, labelId) {
    const segment = byId(id);
    if (!segment || segment.label === labelId) return;
    pushHistory();
    segment.label = labelId;
    notifyChange();
    draw();
  }

  function undo() {
    if (!history.length) return;
    future.push(snapshot());
    segments = JSON.parse(history.pop());
    selectedId = null;
    onSelect?.(null);
    notifyChange();
    draw();
  }

  function redo() {
    if (!future.length) return;
    history.push(snapshot());
    segments = JSON.parse(future.pop());
    selectedId = null;
    onSelect?.(null);
    notifyChange();
    draw();
  }

  function onKeyDown(event) {
    if (isTyping(event.target)) return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
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
    if (event.key === 'Escape') {
      if (selectedId) select(null);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 2;
      seek(position + (event.key === 'ArrowLeft' ? -step : step));
      return;
    }
    if (readOnly) return;
    if (event.key === 'Delete' && selectedId) {
      event.preventDefault();
      removeSegment(selectedId);
      return;
    }
    const label = labels.find((entry) => entry.hotkey === event.key.toLowerCase());
    if (label) {
      event.preventDefault();
      if (selectedId) changeLabel(selectedId, label.id);
      else {
        currentLabel = label.id;
        toast(`当前标签：${label.name}`, 'info', 1800);
      }
    }
  }

  async function load() {
    const token = ++loadToken;
    try {
      const blob = await api.fetchBlob(item.id);
      const bytes = await blob.arrayBuffer();
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('当前浏览器不支持 Web Audio');
      if (!audioContext) audioContext = new Ctor();
      const decoded = await audioContext.decodeAudioData(bytes.slice(0));
      if (token !== loadToken) return;
      buffer = decoded;
      duration = decoded.duration;
      peaks = computePeaks(decoded);
      loader.remove();
      updateCount();
      draw();
    } catch (error) {
      if (token !== loadToken) return;
      clear(loader);
      loader.append(
        el('div', null, el('b', { text: '音频加载失败' }), el('p', { text: error.message, style: { marginTop: '6px' } }), el('button', { className: 'btn btn-sm', text: '重试', style: { marginTop: '10px' }, onClick: load }))
      );
    }
  }

  const resizeObserver = new ResizeObserver(() => draw());
  resizeObserver.observe(wrap);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);

  updateCount();
  updateTime();
  updatePlayButton();
  draw();
  load();

  return {
    getData,
    getMetaPatch: () => {
      if (duration > 0 && (!item.meta?.duration || Math.abs(item.meta.duration - duration) > 0.05)) {
        return { duration: round(duration, 3) };
      }
      return null;
    },
    setLabel(labelId) {
      currentLabel = labelId;
      if (selectedId) changeLabel(selectedId, labelId);
    },
    setNote(value) {
      note = value;
    },
    focus(id) {
      const segment = byId(id);
      if (!segment) return;
      select(id);
      seek(segment.start);
    },
    remove: removeSegment,
    selected: () => selectedId,
    currentLabel: () => currentLabel,
    destroy() {
      loadToken += 1;
      pause();
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      if (audioContext) audioContext.close().catch(() => {});
      root.remove();
    },
  };
}
