import { api, ApiError } from '../api.js';
import {
  clear,
  confirmDialog,
  debounce,
  el,
  emptyState,
  field,
  formatBytes,
  formatDate,
  icon,
  KIND_ICON,
  KIND_LABEL,
  openModal,
  ROLE_LABEL,
  STATUS_LABEL,
  statusEl,
  toast,
} from '../ui.js';
import { createImageAnnotator } from '../annotators/image.js';
import { createTextAnnotator } from '../annotators/text.js';
import { createAudioAnnotator } from '../annotators/audio.js';
import { createSpatialAnnotator } from '../annotators/spatial.js';
import { openProjectSettings } from './settings.js';

const STATUS_FILTERS = [
  ['', '全部状态'],
  ['pending', '未标注'],
  ['in_progress', '标注中'],
  ['submitted', '待复核'],
  ['approved', '已通过'],
  ['rejected', '已驳回'],
];

const KIND_ACCEPT = {
  image: '.png,.jpg,.jpeg,.webp,.gif',
  text: '.txt,.md,.csv,.json,.jsonl',
  audio: '.wav,.mp3,.ogg,.m4a,.aac,.flac,.webm',
  spatial: '.geojson,.json,.png,.jpg,.jpeg,.webp',
};

const SHORTCUTS = {
  image: 'V 选择 · B 矩形 · P 多边形 · F 适配 · Ctrl+Z 撤销',
  text: '拖选文本添加实体 · 数字键应用标签 · Esc 取消',
  audio: 'Space 播放 · ←/→ 跳转 · 拖拽波形新建区段 · Delete 删除',
  spatial: '滚轮缩放 · 拖动空白平移 · V/P/L/G 切换工具 · Delete 删除',
};

const EXPORT_FORMATS = {
  image: [
    ['coco', 'COCO JSON', '目标检测与多边形分割的通用格式'],
    ['raw', '原始标注 JSON', '全部条目、标注版本与复核记录'],
  ],
  text: [
    ['ner', 'NER JSONL', '每行一条文档，包含实体偏移与文档标签'],
    ['raw', '原始标注 JSON', '全部条目、标注版本与复核记录'],
  ],
  audio: [
    ['audio', '音频区段 JSONL', '每行一条音频，包含时长与区段'],
    ['raw', '原始标注 JSON', '全部条目、标注版本与复核记录'],
  ],
  spatial: [
    ['geojson', 'GeoJSON', 'FeatureCollection，含标签与 CRS 属性'],
    ['raw', '原始标注 JSON', '全部条目、标注版本与复核记录'],
  ],
};

function formatSeconds(value) {
  if (!Number.isFinite(value)) return '—';
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function figureCount(kind, data) {
  if (!data) return 0;
  if (kind === 'image') return data.shapes?.length || 0;
  if (kind === 'text') return data.entities?.length || 0;
  if (kind === 'audio') return data.segments?.length || 0;
  if (kind === 'spatial') return data.features?.length || 0;
  return 0;
}

function figureTypeLabel(kind, figure) {
  if (kind === 'image') return figure.type === 'box' ? '矩形' : '多边形';
  if (kind === 'text') return '实体';
  if (kind === 'audio') return '区段';
  if (kind === 'spatial') {
    if (figure.geometry?.type === 'Point') return '点';
    if (figure.geometry?.type === 'LineString') return '线';
    return '面';
  }
  return '图元';
}

function figureDetail(kind, figure) {
  if (kind === 'image') {
    return figure.type === 'box' ? `${Math.round(figure.w)} × ${Math.round(figure.h)} px` : `${figure.points?.length || 0} 点`;
  }
  if (kind === 'text') return `${figure.start}–${figure.end}`;
  if (kind === 'audio') return `${formatSeconds(figure.start)} – ${formatSeconds(figure.end)}`;
  if (kind === 'spatial') {
    const count = figure.geometry?.coordinates?.length || 0;
    return figure.geometry?.type === 'Point' ? '坐标点' : `${count} 坐标`;
  }
  return '';
}

function listFigures(kind, data) {
  if (!data) return [];
  if (kind === 'image') {
    return (data.shapes || []).map((shape) => ({
      id: shape.id,
      label: shape.label,
      type: shape.type,
      detail: figureDetail(kind, shape),
      raw: shape,
    }));
  }
  if (kind === 'text') return (data.entities || []).map((entity) => ({ ...entity, type: 'entity', detail: figureDetail(kind, entity), raw: entity }));
  if (kind === 'audio') return (data.segments || []).map((segment) => ({ ...segment, type: 'segment', detail: figureDetail(kind, segment), raw: segment }));
  if (kind === 'spatial') return (data.features || []).map((feature) => ({ ...feature, type: 'feature', detail: figureDetail(kind, feature), raw: feature }));
  return [];
}

function figureTypeFor(kind, figure) {
  if (kind === 'image') return figure.type;
  if (kind === 'text') return 'entity';
  if (kind === 'audio') return 'segment';
  return 'feature';
}

function labelCounts(kind, data) {
  const counts = new Map();
  const bump = (id) => {
    if (typeof id === 'string') counts.set(id, (counts.get(id) || 0) + 1);
  };
  if (data) {
    if (kind === 'image') for (const shape of data.shapes || []) bump(shape.label);
    if (kind === 'text') for (const entity of data.entities || []) bump(entity.label);
    if (kind === 'audio') for (const segment of data.segments || []) bump(segment.label);
    if (kind === 'spatial') for (const feature of data.features || []) bump(feature.label);
    for (const id of data.documentLabels || []) bump(id);
  }
  return counts;
}

function labeled(iconName, text) {
  return [icon(iconName), el('span', { text })];
}

function metaRow(label, value) {
  return el('div', { className: 'meta-row' }, el('span', { text: label }), el('b', { text: value }));
}

export async function renderProject(root, { state, projectId, initialItemId, setCrumb }) {
  clear(root);
  root.className = 'view page';
  const loading = el(
    'div',
    { className: 'loading-pane', style: { height: '60vh' } },
    el('span', { className: 'spinner' }),
    el('span', { text: '加载项目…' })
  );
  root.append(loading);

  let data;
  try {
    data = await api.getProject(projectId);
  } catch (error) {
    clear(root);
    root.append(
      el(
        'div',
        { className: 'fatal' },
        el('h1', { text: '无法打开项目' }),
        el('p', { text: error.message }),
        el('div', { className: 'inline', style: { marginTop: '14px' } },
          el('button', { className: 'btn', text: '返回项目列表', onClick: () => { location.hash = '#/projects'; } })
        )
      )
    );
    return null;
  }

  let project = data.project;
  let role = data.role;
  let members = data.members || [];
  let counts = { ...(project.counts || {}) };
  const kind = project.kind;
  let schema = project.labelSchema || { labels: [], documentLabels: [] };

  const isManager = () => role === 'manager' || role === 'admin';
  const canReview = () => isManager() || role === 'reviewer';
  const writable = () => !project.archived;

  document.title = `${project.name} · OVERMARKED`;
  setCrumb?.(project.name);

  root.className = 'view workbench-view';
  clear(root);

  const workbench = el('div', { className: 'workbench' });
  const head = el('div', { className: 'project-head' });
  const queue = el('aside', { className: 'queue-panel' });
  const canvasPanel = el('section', { className: 'canvas-panel' });
  const canvasHead = el('div', { className: 'canvas-head' });
  const canvasHost = el('div', { className: 'canvas-host' });
  const canvasFoot = el('div', { className: 'canvas-foot' });
  const inspector = el('aside', { className: 'inspector' });
  const scrim = el('div', { className: 'scrim', onClick: closeOverlays });
  const dropOverlay = el(
    'div',
    { className: 'drop-overlay', hidden: true },
    icon('upload'),
    el('b', { text: '释放文件以添加到项目' }),
    el('span', { text: '文件将上传到当前数据集，并按队列顺序编号。' })
  );
  const body = el('div', { className: 'workbench-body' }, queue, canvasPanel, inspector, scrim);
  workbench.append(head, body, dropOverlay);
  canvasPanel.append(canvasHead, canvasHost, canvasFoot);
  root.append(workbench);

  let items = [];
  let queueTotal = 0;
  let page = 1;
  const limit = 50;
  let statusFilter = '';
  let search = '';
  let assigneeMine = false;
  let queueToken = 0;
  let selectedItemId = null;
  let current = null;
  let annotator = null;
  let readOnly = false;
  let currentLabel = schema.labels?.[0]?.id || null;
  let selectedFigureId = null;
  let noteValue = '';
  let dirty = false;
  let saving = false;
  let changeSeq = 0;
  let persistPromise = null;
  let itemToken = 0;
  let historyData = null;
  let historyToken = 0;
  let removed = false;
  let uploading = false;
  let dragDepth = 0;
  let settingsHandle = null;
  let exportHandle = null;

  const uploadInput = el('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    attrs: { accept: KIND_ACCEPT[kind] || '' },
  });
  uploadInput.addEventListener('change', () => {
    const files = [...(uploadInput.files || [])];
    uploadInput.value = '';
    if (files.length) uploadFiles(files);
  });
  workbench.append(uploadInput);

  const queueCount = el('span', { className: 'count' });
  const queueList = el('div', { className: 'queue-list' });
  const queueEmptyHost = el('div');
  const uploadBox = el(
    'div',
    { className: 'upload-progress', hidden: true },
    el('div', { className: 'inline', style: { justifyContent: 'space-between' } }, el('span', { text: '上传中' }), el('span', { text: '0%' })),
    el('div', { className: 'progress' }, el('i', { style: { width: '0%' } }))
  );
  const queueUploadBtn = el(
    'button',
    {
      className: 'btn btn-sm',
      type: 'button',
      title: '上传文件',
      onClick: triggerUpload,
    },
    icon('plus'),
    el('span', { text: '上传' })
  );
  const searchInput = el('input', {
    className: 'input',
    placeholder: '搜索文件名…',
    attrs: { 'aria-label': '搜索条目' },
  });
  const statusSelect = el('select', { className: 'select', attrs: { 'aria-label': '按状态筛选' } });
  for (const [value, label] of STATUS_FILTERS) statusSelect.append(el('option', { value, text: label, selected: value === '' }));
  const mineBtn = el(
    'button',
    { className: 'btn btn-sm', type: 'button', title: '只看指派给我的条目', onClick: toggleMine },
    '我的'
  );
  const queueHead = el(
    'div',
    { className: 'queue-head' },
    el('div', { className: 'queue-head-row' }, el('div', { className: 'queue-title' }, icon(KIND_ICON[kind]), '条目队列', queueCount), queueUploadBtn),
    el('div', { className: 'queue-controls' }, el('div', { className: 'search' }, icon('search'), searchInput)),
    el('div', { className: 'queue-filters' }, statusSelect, mineBtn)
  );
  const queueFootText = el('span');
  const pagePrev = el('button', { type: 'button', title: '上一页', onClick: () => goPage(-1) }, icon('left'));
  const pageNext = el('button', { type: 'button', title: '下一页', onClick: () => goPage(1) }, icon('right'));
  const queueFoot = el('div', { className: 'queue-foot' }, queueFootText, el('div', { className: 'pager' }, pagePrev, pageNext));
  queue.append(queueHead, queueList, queueEmptyHost, uploadBox, queueFoot);

  const fileLabel = el('span', { className: 'file', text: '未选择条目' });
  const statusHost = el('span', { className: 'inline' });
  const dirtyWrap = el('span', { className: 'inline dirty' }, el('i', { className: 'dirty-dot' }), el('span', { className: 'field-hint', style: { margin: '0', fontSize: '10px' }, text: '未保存' }));
  canvasHead.append(fileLabel, statusHost, el('div', { className: 'spacer' }), dirtyWrap);

  const prevBtn = el('button', { className: 'btn btn-sm btn-icon', type: 'button', title: '上一条 ( [ )', onClick: () => adjacent(-1) }, icon('left'));
  const nextBtn = el('button', { className: 'btn btn-sm btn-icon', type: 'button', title: '下一条 ( ] )', onClick: () => adjacent(1) }, icon('right'));
  const shortcuts = el('div', { className: 'shortcuts', text: SHORTCUTS[kind] || '' });
  const saveBtn = el('button', { className: 'btn btn-sm', type: 'button', text: '保存草稿', onClick: () => persist({}) });
  const submitBtn = el('button', { className: 'btn btn-sm btn-primary', type: 'button', text: '提交复核', onClick: submitAnnotation });
  canvasFoot.append(
    el('div', { className: 'nav' }, prevBtn, nextBtn),
    shortcuts,
    el('div', { className: 'spacer' }),
    saveBtn,
    submitBtn
  );

  function totalPages() {
    return Math.max(1, Math.ceil(queueTotal / limit));
  }

  function renderHead() {
    clear(head);
    const approved = counts.approved || 0;
    const total = counts.total || 0;
    const pct = total ? Math.round((approved / total) * 100) : 0;
    const back = el('button', {
      className: 'head-back',
      type: 'button',
      title: '返回项目列表',
      onClick: () => {
        location.hash = '#/projects';
      },
    }, icon('left'));
    const title = el(
      'div',
      { className: 'head-title' },
      el(
        'div',
        { className: 'line1' },
        el('span', { className: 'kind', title: KIND_LABEL[kind] }, icon(KIND_ICON[kind])),
        el('h1', { text: project.name }),
        project.archived ? el('span', { className: 'badge', text: '已归档' }) : null,
        el('span', { className: 'badge badge-type', text: KIND_LABEL[kind] || kind }),
        el('span', { className: 'badge', text: ROLE_LABEL[role] || role })
      ),
      el(
        'div',
        { className: 'line2' },
        `${total} 条目`,
        '·',
        `${schema.labels?.length || 0} 标签`,
        '·',
        `已通过 ${approved}`
      )
    );
    const progress = el(
      'div',
      { className: 'head-progress' },
      el('div', { className: 'bar' }, el('i', { style: { width: `${pct}%` } })),
      el('span', { className: 'txt', text: `${pct}%` })
    );
    const actions = el(
      'div',
      { className: 'head-actions' },
      el('button', {
        className: 'btn btn-sm btn-icon mobile-only',
        type: 'button',
        title: '条目队列',
        onClick: () => workbench.classList.toggle('show-queue'),
      }, icon('list')),
      el('button', {
        className: 'btn btn-sm btn-icon mobile-only',
        type: 'button',
        title: '检查器',
        onClick: () => workbench.classList.toggle('show-inspector'),
      }, icon('panel')),
      el('button', {
        className: 'btn btn-sm',
        type: 'button',
        hidden: project.archived || !writable(),
        title: '上传文件',
        onClick: triggerUpload,
      }, ...labeled('upload', '上传')),
      el('button', { className: 'btn btn-sm', type: 'button', title: '导出数据集', onClick: openExport }, ...labeled('download', '导出')),
      isManager()
        ? el('button', { className: 'btn btn-sm', type: 'button', title: '项目设置', onClick: openSettings }, ...labeled('settings', '设置'))
        : null
    );
    head.append(back, title, progress, actions);
    applyWriteState();
  }

  function applyWriteState() {
    queueUploadBtn.hidden = project.archived;
    queueUploadBtn.disabled = project.archived;
    if (!current || readOnly) {
      saveBtn.hidden = true;
      submitBtn.hidden = true;
    } else {
      saveBtn.hidden = false;
      submitBtn.hidden = false;
    }
  }

  function renderQueueChrome() {
    queueCount.textContent = queueTotal ? `(${queueTotal})` : '(0)';
    queueFootText.textContent = queueTotal
      ? `${queueTotal} 条 · 第 ${page}/${totalPages()} 页`
      : '0 条';
    pagePrev.disabled = page <= 1;
    pageNext.disabled = page >= totalPages();
    mineBtn.classList.toggle('btn-primary', assigneeMine);
  }

  function renderQueue() {
    clear(queueList);
    clear(queueEmptyHost);
    if (!items.length) {
      queueFoot.style.display = '';
      renderQueueChrome();
      if (queueTotal === 0 && !statusFilter && !search && !assigneeMine) {
        queueEmptyHost.append(
          el(
            'div',
            { className: 'queue-empty' },
            el('div', { text: '队列为空' }),
            writable()
              ? el('button', { className: 'btn btn-sm', style: { marginTop: '10px' }, onClick: triggerUpload }, icon('upload'), '上传第一批文件')
              : el('div', { text: '项目已归档，无法上传', style: { marginTop: '6px', color: 'var(--dim)' } })
          )
        );
      } else {
        queueEmptyHost.append(
          el('div', { className: 'queue-empty' }, '没有匹配的条目', el('div', { style: { marginTop: '6px' }, text: '调整筛选条件或清空搜索。' }))
        );
      }
      return;
    }
    for (const item of items) {
      const row = el(
        'button',
        {
          className: `queue-row${item.id === selectedItemId ? ' active' : ''}`,
          type: 'button',
          onClick: () => selectItem(item.id),
        },
        el('span', { className: 'queue-seq', text: `#${String(item.seq).padStart(3, '0')}` }),
        el(
          'span',
          { className: 'queue-main' },
          el('span', { className: 'queue-name', text: item.filename, title: item.filename }),
          el('span', { className: 'queue-sub' }, `${STATUS_LABEL[item.status] || item.status} · ${formatBytes(item.size)}${item.assigneeName ? ` · ${item.assigneeName}` : ''}`)
        ),
        el(
          'span',
          { className: 'queue-side', title: STATUS_LABEL[item.status] || item.status },
          el('i', { className: `status-dot ${item.status}` }),
          item.annotationVersion ? el('span', { className: 'queue-seq', text: `v${item.annotationVersion}` }) : null
        )
      );
      queueList.append(row);
    }
    renderQueueChrome();
  }

  async function loadQueue({ silent = false } = {}) {
    const token = ++queueToken;
    if (!silent) {
      clear(queueList);
      clear(queueEmptyHost);
      for (let i = 0; i < 7; i++) {
        queueList.append(el('div', { className: 'skeleton', style: { height: '38px', margin: '6px 8px' } }));
      }
    }
    try {
      const result = await api.listItems(project.id, {
        status: statusFilter,
        q: search,
        assignee: assigneeMine ? 'me' : '',
        page,
        limit,
      });
      if (token !== queueToken) return;
      items = result.items || [];
      queueTotal = result.total || 0;
      page = result.page || page;
      renderQueue();
    } catch (error) {
      if (token !== queueToken) return;
      clear(queueList);
      clear(queueEmptyHost);
      queueEmptyHost.append(
        emptyState({
          iconName: 'alert',
          title: '队列加载失败',
          description: error.message,
          action: el('button', { className: 'btn btn-sm', text: '重试', onClick: () => loadQueue({}) }),
        })
      );
    }
  }

  function goPage(direction) {
    const next = page + direction;
    if (next < 1 || next > totalPages()) return;
    page = next;
    loadQueue({});
  }

  function toggleMine() {
    assigneeMine = !assigneeMine;
    page = 1;
    loadQueue({});
  }

  async function selectItem(id) {
    if (id === selectedItemId) return;
    if (!(await guardUnsaved())) return;
    await loadItem(id);
    if (window.innerWidth <= 860) closeOverlays();
  }

  async function guardUnsaved() {
    if (!dirty || !current || readOnly) return true;
    const saved = await persist({ silent: true });
    if (saved) return true;
    return confirmDialog({
      title: '草稿尚未保存',
      message: '自动保存失败。继续切换将丢失当前未保存的修改。',
      confirmText: '丢弃并继续',
      danger: true,
    });
  }

  function showCanvasLoading() {
    clear(canvasHost);
    canvasHost.append(el('div', { className: 'loading-pane' }, el('span', { className: 'spinner' }), el('span', { text: '加载条目…' })));
  }

  function showCanvasError(message, retry) {
    clear(canvasHost);
    canvasHost.append(
      el(
        'div',
        { className: 'error-pane' },
        icon('alert'),
        el('h3', { text: '条目加载失败' }),
        el('p', { text: message }),
        el('button', { className: 'btn btn-sm', text: '重试', onClick: retry })
      )
    );
  }

  function defaultReadOnly() {
    return !current?.can?.annotate || current?.item?.status === 'submitted';
  }

  function mountEmptyCanvas() {
    clear(canvasHost);
    fileLabel.textContent = '未选择条目';
    clear(statusHost);
    dirtyWrap.classList.remove('dirty');
    clear(dirtyWrap);
    dirtyWrap.append(el('i', { className: 'dirty-dot' }), el('span', { className: 'field-hint', style: { margin: '0', fontSize: '10px' }, text: '' }));
    saveBtn.hidden = true;
    submitBtn.hidden = true;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    const empty = queueTotal === 0
      ? emptyState({
          iconName: KIND_ICON[kind],
          title: '数据集还没有条目',
          description: writable()
            ? `拖拽${KIND_LABEL[kind]}文件到窗口，或点击上传。支持 ${KIND_ACCEPT[kind].split(',').join(' ')}。`
            : '项目已归档，取消归档后才能上传新文件。',
          action: writable()
            ? el('button', { className: 'btn btn-primary', onClick: triggerUpload }, icon('upload'), '上传文件')
            : null,
        })
      : emptyState({
          iconName: KIND_ICON[kind],
          title: '从左侧选择一个条目',
          description: '标注会自动保存草稿，提交后进入复核队列。',
        });
    canvasHost.append(empty);
    buildEmptyInspector();
  }

  async function loadItem(id, { skipGuard = false } = {}) {
    if (!skipGuard && !(await guardUnsaved())) return false;
    const token = ++itemToken;
    selectedItemId = id;
    renderQueue();
    selectedFigureId = null;
    dirty = false;
    saving = false;
    historyData = null;
    showCanvasLoading();
    try {
      const detail = await api.getItem(id);
      if (token !== itemToken || removed) return false;
      current = detail;
      readOnly = defaultReadOnly();
      noteValue = typeof detail.annotation?.data?.note === 'string' ? detail.annotation.data.note : '';
      currentLabel =
        firstFigureLabel(detail.annotation?.data) || schema.labels?.[0]?.id || null;
      destroyAnnotator();
      buildInspector();
      renderCanvasHead();
      applyWriteState();
      renderFootState();
      const result = mountAnnotator(detail);
      if (result instanceof Error) {
        showCanvasError(result.message, () => loadItem(id, { skipGuard: true }));
        return false;
      }
      renderLabels();
      renderFigures();
      updateHash();
      history.replaceState?.(null, '', location.pathname + location.search + `#/p/${project.id}?item=${id}`);
      loadHistory();
      return true;
    } catch (error) {
      if (token !== itemToken) return false;
      current = null;
      selectedItemId = null;
      renderQueue();
      showCanvasError(error.message, () => loadItem(id, { skipGuard: true }));
      buildEmptyInspector();
      return false;
    }
  }

  function updateHash() {
    if (!selectedItemId) return;
    const next = `#/p/${project.id}?item=${selectedItemId}`;
    if (location.hash !== next) history.replaceState?.(null, '', location.pathname + location.search + next);
  }

  function firstFigureLabel(data) {
    const figures = listFigures(kind, data);
    return figures[0]?.label || null;
  }

  function mountAnnotator(detail) {
    const factory = {
      image: createImageAnnotator,
      text: createTextAnnotator,
      audio: createAudioAnnotator,
      spatial: createSpatialAnnotator,
    }[kind];
    if (!factory) return new Error(`未知数据类型：${kind}`);
    const data = detail.annotation?.data || {};
    try {
      annotator = factory(canvasHost, {
        item: detail.item,
        schema,
        data,
        readOnly,
        onChange: handleAnnotatorChange,
        onSelect: handleAnnotatorSelect,
      });
      if (currentLabel) annotator.setLabel?.(currentLabel);
      return annotator;
    } catch (error) {
      console.error(error);
      return error;
    }
  }

  function destroyAnnotator() {
    if (annotator) {
      try {
        annotator.destroy();
      } catch {
        /* ignore */
      }
      annotator = null;
    }
    clear(canvasHost);
  }

  function handleAnnotatorChange() {
    changeSeq += 1;
    dirty = true;
    updateDirtyUI();
    renderFigures();
    renderLabels();
    scheduleAutosave();
  }

  function handleAnnotatorSelect(id) {
    selectedFigureId = id;
    if (id) {
      const figure = listFigures(kind, annotator?.getData()).find((entry) => entry.id === id);
      if (figure?.label) {
        currentLabel = figure.label;
        renderLabels();
      }
    }
    renderFigures();
  }

  function renderCanvasHead() {
    if (!current) {
      fileLabel.textContent = '未选择条目';
      clear(statusHost);
      return;
    }
    fileLabel.textContent = current.item.filename;
    clear(statusHost);
    statusHost.append(statusEl(current.item.status));
    if (current.annotation?.version) {
      statusHost.append(el('span', { className: 'badge', text: `v${current.annotation.version}` }));
    }
    if (readOnly) statusHost.append(el('span', { className: 'badge', text: '只读' }));
    updateDirtyUI();
  }

  function updateDirtyUI() {
    dirtyWrap.classList.toggle('dirty', dirty);
    const text = dirtyWrap.querySelector('.field-hint');
    if (text) {
      text.textContent = saving ? '保存中…' : dirty ? '未保存' : current?.annotation ? '已保存' : '';
      text.style.color = dirty ? 'var(--accent)' : 'var(--dim)';
    }
    saveBtn.disabled = saving;
    submitBtn.disabled = saving;
  }

  function renderFootState() {
    if (!current) {
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }
    const index = items.findIndex((item) => item.id === current.item.id);
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index < 0 || index >= items.length - 1;
    saveBtn.hidden = readOnly;
    submitBtn.hidden = readOnly;
  }

  function adjacent(direction) {
    if (!current) return;
    const index = items.findIndex((item) => item.id === current.item.id);
    if (index < 0) {
      toast('当前条目不在本页队列中', 'info');
      return;
    }
    const target = items[index + direction];
    if (!target) {
      toast(direction < 0 ? '已经是本页第一条' : '已经是本页最后一条', 'info');
      return;
    }
    selectItem(target.id);
  }

  function buildEmptyInspector() {
    clear(inspector);
    const header = el(
      'div',
      { className: 'inspector-section' },
      el(
        'div',
        { className: 'inspector-head' },
        el('span', { className: 'inspector-title', text: '检查器' }),
        el('button', { className: 'btn btn-ghost btn-icon inspector-close', type: 'button', title: '关闭', onClick: closeOverlays }, icon('x'))
      ),
      el('p', { className: 'section-empty', text: '选择条目后可查看标注、图元、复核记录与历史版本。' })
    );
    inspector.append(header);
  }

  let taskBody = null;
  let labelsBody = null;
  let figuresBody = null;
  let reviewBody = null;
  let historyBody = null;
  let noteInput = null;
  let noteCount = null;

  function buildInspector() {
    clear(inspector);
    const headSection = el(
      'div',
      { className: 'inspector-section' },
      el(
        'div',
        { className: 'inspector-head' },
        el('span', { className: 'inspector-title', text: '条目' }),
        el(
          'div',
          { className: 'inline' },
          el('button', { className: 'btn btn-ghost btn-icon inspector-close', type: 'button', title: '关闭', onClick: closeOverlays }, icon('x'))
        )
      )
    );
    taskBody = el('div');
    headSection.append(taskBody);

    const labelsSection = el('div', { className: 'inspector-section' });
    labelsBody = el('div');
    labelsSection.append(
      el('div', { className: 'inspector-head' }, el('span', { className: 'inspector-title', text: '标签' })),
      labelsBody
    );

    const figuresSection = el('div', { className: 'inspector-section' });
    figuresBody = el('div');
    figuresSection.append(
      el('div', { className: 'inspector-head' }, el('span', { className: 'inspector-title', text: '图元' }), el('span', { className: 'badge', text: '0' })),
      figuresBody
    );

    const noteSection = el('div', { className: 'inspector-section' });
    noteInput = el('textarea', {
      className: 'textarea',
      rows: 3,
      value: noteValue,
      disabled: readOnly,
      placeholder: '标注说明、边界约定、疑难说明…',
      attrs: { maxlength: '2000' },
      style: { resize: 'vertical', minHeight: '66px', padding: '7px 9px', height: 'auto' },
    });
    noteInput.addEventListener('input', () => {
      if (readOnly) return;
      noteValue = noteInput.value;
      annotator?.setNote?.(noteValue);
      if (noteCount) noteCount.textContent = `${noteValue.length}/2000`;
      changeSeq += 1;
      dirty = true;
      updateDirtyUI();
      scheduleAutosave();
    });
    noteCount = el('span', { className: 'field-hint', style: { margin: '0', fontSize: '10px' }, text: `${noteValue.length}/2000` });
    noteSection.append(
      el(
        'div',
        { className: 'inspector-head' },
        el('span', { className: 'inspector-title', text: '备注' }),
        noteCount
      ),
      noteInput
    );

    const reviewSection = el('div', { className: 'inspector-section' });
    reviewBody = el('div', { className: 'review-box' });
    reviewSection.append(
      el('div', { className: 'inspector-head' }, el('span', { className: 'inspector-title', text: '复核' })),
      reviewBody
    );

    const historySection = el('details', { className: 'disclosure' });
    historyBody = el('div', { className: 'disclosure-body' });
    historySection.append(
      el('summary', null, el('span', { text: '版本历史' }), el('span', { text: '⌄' })),
      historyBody
    );

    inspector.append(headSection, labelsSection, figuresSection, noteSection, reviewSection, historySection);

    renderTask();
    renderLabels();
    renderFigures();
    renderReview();
    renderHistory();
  }

  function renderTask() {
    if (!taskBody || !current) return;
    clear(taskBody);
    const item = current.item;
    const annotation = current.annotation;
    const assigneeSelect = el('select', { className: 'select', style: { height: '30px', fontSize: '11px' } });
    assigneeSelect.append(el('option', { value: '', text: '未指派' }));
    for (const member of members) {
      assigneeSelect.append(el('option', { value: member.userId, text: `${member.displayName} · ${ROLE_LABEL[member.role] || member.role}` }));
    }
    assigneeSelect.value = item.assigneeId || '';
    assigneeSelect.disabled = !isManager() || !writable() || item.status === 'submitted';
    assigneeSelect.addEventListener('change', () => assignItem(assigneeSelect.value || null));

    const statusRow = el(
      'div',
      { className: 'inline', style: { justifyContent: 'space-between', marginBottom: '10px' } },
      statusEl(item.status),
      el('span', { className: 'badge', text: annotation ? `v${annotation.version}` : '无标注' })
    );

    const assigneeRow = el(
      'div',
      { className: 'field', style: { marginBottom: '10px', gap: '4px' } },
      el('label', { text: '指派' }),
      isManager()
        ? assigneeSelect
        : el(
            'div',
            { className: 'inline', style: { justifyContent: 'space-between' } },
            el('span', { className: 'muted', text: item.assigneeName || '未指派', style: { fontSize: '12px' } }),
            item.assigneeId !== state.user.id && writable()
              ? el('button', { className: 'btn btn-sm btn-ghost', type: 'button', text: '指派给我', onClick: () => assignItem(state.user.id) })
              : null
          )
    );

    const meta = el('div', { className: 'meta-list' }, [
      metaRow('序号', `#${String(item.seq).padStart(3, '0')}`),
      metaRow('大小', formatBytes(item.size)),
      kind === 'image' && item.meta?.width ? metaRow('尺寸', `${item.meta.width} × ${item.meta.height}`) : null,
      kind === 'audio' && item.meta?.duration ? metaRow('时长', formatSeconds(item.meta.duration)) : null,
      kind === 'spatial' ? metaRow('坐标系', item.meta?.crs || '像素坐标') : null,
      kind === 'spatial' && item.meta?.bounds ? metaRow('范围', item.meta.bounds.map((value) => Number(value).toFixed(3)).join(', ')) : null,
      kind === 'spatial' && item.meta?.featureCount !== undefined ? metaRow('底图要素', String(item.meta.featureCount)) : null,
      metaRow('上传', formatDate(item.createdAt)),
      item.assigneeName ? metaRow('标注员', item.assigneeName) : null,
    ].filter(Boolean));

    const managerActions = el('div', { className: 'inline', style: { marginTop: '10px', flexWrap: 'wrap' } });
    if (isManager() && writable() && item.status !== 'in_progress') {
      managerActions.append(
        el('button', { className: 'btn btn-sm', type: 'button', onClick: reopenItem }, '重新打开')
      );
    }
    if (isManager() && writable()) {
      managerActions.append(
        el('button', { className: 'btn btn-sm btn-danger', type: 'button', onClick: deleteItem }, '删除条目')
      );
    }

    taskBody.append(statusRow, assigneeRow, meta, managerActions);
    if (readOnly && item.status === 'submitted') {
      taskBody.append(el('p', { className: 'field-hint', text: '条目待复核，当前为只读。管理员可重新打开后修改。', style: { marginTop: '10px' } }));
    }
  }

  function renderLabels() {
    if (!labelsBody || !current) return;
    clear(labelsBody);
    const data = annotator?.getData();
    const counts = labelCounts(kind, data);
    const list = el('div', { className: 'labels-list' });
    for (const label of schema.labels || []) {
      const active = label.id === currentLabel;
      list.append(
        el(
          'button',
          {
            className: `label-btn${active ? ' active' : ''}`,
            type: 'button',
            onClick: () => {
              if (readOnly) return;
              currentLabel = label.id;
              annotator?.setLabel?.(label.id);
              renderLabels();
            },
          },
          el('i', { className: 'swatch', style: { background: label.color } }),
          el('span', { className: 'name', text: label.name }),
          label.hotkey ? el('kbd', { className: 'key', text: label.hotkey }) : null,
          el('span', { className: 'count', text: String(counts.get(label.id) || 0) })
        )
      );
    }
    if (!schema.labels?.length) {
      labelsBody.append(el('p', { className: 'section-empty', text: '项目没有可用标签。' }));
    } else {
      labelsBody.append(list);
    }
    if (schema.documentLabels?.length) {
      labelsBody.append(
        el('div', { className: 'eyebrow', style: { marginTop: '10px' }, text: '文档标签' }),
        el(
          'div',
          { className: 'inline', style: { flexWrap: 'wrap', marginTop: '5px', gap: '4px' } },
          schema.documentLabels.map((label) =>
            el(
              'span',
              { className: 'badge', title: label.name },
              el('i', { className: 'swatch', style: { background: label.color, width: '7px', height: '7px' } }),
              label.name,
              el('span', { className: 'dim', text: String(counts.get(label.id) || 0) })
            )
          )
        )
      );
    }
  }

  function renderFigures() {
    if (!figuresBody || !current) return;
    clear(figuresBody);
    const data = annotator?.getData();
    const figures = listFigures(kind, data);
    const title = figuresBody.parentElement?.querySelector('.badge');
    if (title) title.textContent = String(figures.length);
    if (!figures.length) {
      figuresBody.append(
        el('p', { className: 'section-empty', text: readOnly ? '该条目没有图元。' : '在画布中绘制图元，或拖选文本添加实体。' })
      );
      return;
    }
    const list = el('div', { className: 'figure-list' });
    for (const figure of figures) {
      list.append(
        el(
          'div',
          { className: `figure-row${figure.id === selectedFigureId ? ' selected' : ''}` },
          el(
            'button',
            {
              type: 'button',
              style: { all: 'unset', display: 'flex', alignItems: 'center', gap: '8px', flex: '1', minWidth: '0', cursor: 'pointer' },
              onClick: () => {
                selectedFigureId = figure.id;
                if (figure.label) currentLabel = figure.label;
                annotator?.focus?.(figure.id);
                renderLabels();
                renderFigures();
              },
            },
            el('span', { className: 'fig-type', text: figureTypeLabel(kind, figure) }),
            el('span', { className: 'fig-label', text: schema.labels?.find((label) => label.id === figure.label)?.name || figure.label }),
            el('span', { className: 'dim', style: { fontFamily: 'var(--mono)', fontSize: '9px' }, text: figure.detail })
          ),
          !readOnly
            ? el(
                'button',
                {
                  className: 'fig-del',
                  type: 'button',
                  title: '删除图元',
                  onClick: () => {
                    annotator?.remove?.(figure.id);
                    renderFigures();
                  },
                },
                icon('trash')
              )
            : null
        )
      );
    }
    figuresBody.append(list);
  }

  function renderReview() {
    if (!reviewBody || !current) return;
    clear(reviewBody);
    const item = current.item;
    const latest = current.reviews?.[0];
    if (latest) {
      reviewBody.append(
        el(
          'div',
          { className: `review-note${latest.decision === 'rejected' ? ' rejected' : ''}` },
          el('div', { style: { marginBottom: '3px' } }, latest.decision === 'approved' ? '通过' : '驳回', ' · ', latest.reviewerName || '复核员', ' · ', formatDate(latest.createdAt)),
          latest.note ? el('div', { text: latest.note }) : null
        )
      );
    }
    if (canReview() && writable() && item.status === 'submitted') {
      const actions = el(
        'div',
        { className: 'review-actions' },
        el('button', { className: 'btn btn-sm btn-primary', type: 'button', onClick: () => reviewItem('approve') }, icon('check'), '通过'),
        el('button', { className: 'btn btn-sm btn-danger', type: 'button', onClick: () => reviewItem('reject') }, icon('x'), '驳回')
      );
      reviewBody.append(actions);
    } else if (item.status === 'approved') {
      reviewBody.append(el('p', { className: 'section-empty', text: '该条目已通过复核。' }));
    } else if (item.status === 'rejected') {
      reviewBody.append(el('p', { className: 'section-empty', text: '已驳回，等待修改后重新提交。' }));
    } else if (item.status === 'submitted') {
      reviewBody.append(el('p', { className: 'section-empty', text: '等待复核员处理。' }));
    } else if (canReview()) {
      reviewBody.append(el('p', { className: 'section-empty', text: '提交后进入复核。' }));
    }
  }

  function renderHistory() {
    if (!historyBody || !current) return;
    clear(historyBody);
    if (!historyData) {
      historyBody.append(el('p', { className: 'section-empty', text: '加载版本历史…' }));
      return;
    }
    const versions = historyData.versions || [];
    const reviews = historyData.reviews || [];
    if (!versions.length && !reviews.length) {
      historyBody.append(el('p', { className: 'section-empty', text: '暂无历史记录。' }));
      return;
    }
    if (versions.length) {
      historyBody.append(
        el('div', { className: 'eyebrow', style: { marginBottom: '5px' }, text: '提交版本' }),
        el(
          'div',
          { className: 'history-list', style: { marginBottom: '10px' } },
          versions.slice(0, 10).map((version) =>
            el(
              'div',
              { className: 'history-row' },
              el('b', { text: `v${version.version} · ${STATUS_LABEL[version.status] || version.status}` }),
              el('span', { text: `${version.authorName || '—'} · ${formatDate(version.createdAt)}` })
            )
          )
        )
      );
    }
    if (reviews.length) {
      historyBody.append(
        el('div', { className: 'eyebrow', style: { marginBottom: '5px' }, text: '复核记录' }),
        el(
          'div',
          { className: 'history-list' },
          reviews.slice(0, 10).map((review) =>
            el(
              'div',
              { className: 'history-row', title: review.note || '' },
              el('b', { text: review.decision === 'approved' ? '通过' : '驳回' }),
              el('span', { text: `${review.reviewerName || '—'} · ${formatDate(review.createdAt)}` })
            )
          )
        )
      );
    }
  }

  async function loadHistory() {
    if (!current) return;
    const token = ++historyToken;
    try {
      const result = await api.history(current.item.id);
      if (token !== historyToken || !current) return;
      historyData = result;
      renderHistory();
    } catch {
      if (token === historyToken) {
        historyData = { versions: [], reviews: [] };
        renderHistory();
      }
    }
  }

  function adjustCounts(from, to) {
    if (!from || !to || from === to || !counts) return;
    counts[from] = Math.max(0, (counts[from] || 0) - 1);
    counts[to] = (counts[to] || 0) + 1;
    renderHead();
  }

  function patchQueueItem(item) {
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index < 0) return;
    items[index] = {
      ...items[index],
      status: item.status,
      assigneeId: item.assigneeId,
      assigneeName: item.assigneeName,
      annotationVersion: item.annotationVersion,
      updatedAt: item.updatedAt,
    };
    renderQueue();
  }

  const queueRefresh = debounce(() => {
    if (removed) return;
    loadQueue({ silent: true });
  }, 600);

  function persist({ submit = false, silent = false } = {}) {
    if (persistPromise) return persistPromise;
    if (!annotator || !current || readOnly) return Promise.resolve(false);
    const seq = changeSeq;
    saving = true;
    updateDirtyUI();
    persistPromise = (async () => {
      try {
        const metaPatch = annotator.getMetaPatch?.();
        if (metaPatch) {
          const metaResult = await api.updateItem(current.item.id, { meta: metaPatch });
          current.item = metaResult.item;
        }
        const data = annotator.getData();
        const result = await api.saveAnnotation(current.item.id, data, submit);
        const previousStatus = current.item.status;
        current.annotation = result.annotation;
        current.item = result.item;
        readOnly = defaultReadOnly();
        if (seq === changeSeq) dirty = false;
        saving = false;
        updateDirtyUI();
        renderCanvasHead();
        renderTask();
        renderReview();
        renderFigures();
        renderFootState();
        adjustCounts(previousStatus, result.item.status);
        patchQueueItem(result.item);
        queueRefresh();
        if (submit) loadHistory();
        if (!silent) toast(submit ? '已提交复核' : '草稿已保存', 'ok');
        return true;
      } catch (error) {
        toast(error.message, 'error', 6000);
        return false;
      } finally {
        saving = false;
        persistPromise = null;
        updateDirtyUI();
        if (dirty) scheduleAutosave();
      }
    })();
    return persistPromise;
  }

  const scheduleAutosave = debounce(() => {
    if (removed || !dirty || saving || !current || readOnly) return;
    persist({ silent: true });
  }, 2200);

  async function submitAnnotation() {
    if (!annotator || !current || readOnly) return;
    const data = annotator.getData();
    if (figureCount(kind, data) === 0 && !data.note?.trim()) {
      const ok = await confirmDialog({
        title: '提交空标注？',
        message: '当前没有图元或备注。提交后将进入复核队列。',
        confirmText: '仍然提交',
      });
      if (!ok) return;
    }
    const id = current.item.id;
    const ok = await persist({ submit: true });
    if (!ok) return;
    await loadItem(id, { skipGuard: true });
    loadQueue({ silent: true });
  }

  async function reviewItem(decision) {
    if (!current?.can?.review) return;
    let note = '';
    if (decision === 'reject') {
      note = await askRejectNote();
      if (note === null) return;
    }
    try {
      await api.review(current.item.id, decision, note);
      toast(decision === 'approve' ? '条目已通过复核' : '条目已驳回', decision === 'approve' ? 'ok' : 'info');
      const id = current.item.id;
      await loadItem(id, { skipGuard: true });
      loadQueue({ silent: true });
    } catch (error) {
      toast(error.message, 'error', 6000);
    }
  }

  function askRejectNote() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const input = el('textarea', {
        className: 'textarea',
        rows: 4,
        placeholder: '说明需要修改的内容…',
        attrs: { maxlength: '2000' },
        style: { resize: 'vertical', minHeight: '92px', padding: '8px 10px', height: 'auto' },
      });
      const error = el('div', { className: 'form-error', hidden: true });
      const reject = el('button', { className: 'btn btn-danger', type: 'button', text: '确认驳回' });
      const modal = openModal({
        title: '驳回标注',
        subtitle: '驳回意见会记录在复核历史中，标注员可修改后重新提交。',
        body: [error, field('驳回原因', input)],
        footer: [
          el('button', { className: 'btn btn-ghost', type: 'button', text: '取消', onClick: () => modal.close() }),
          reject,
        ],
        onClose: () => finish(null),
      });
      reject.addEventListener('click', () => {
        const value = input.value.trim();
        if (!value) {
          error.textContent = '请填写驳回原因';
          error.hidden = false;
          input.focus();
          return;
        }
        finish(value);
        modal.close();
      });
    });
  }

  async function assignItem(userId) {
    if (!current || !writable()) return;
    try {
      const result = await api.updateItem(current.item.id, { assigneeId: userId });
      current.item = result.item;
      patchQueueItem(result.item);
      renderTask();
      toast(userId ? '已更新指派' : '已取消指派', 'ok');
    } catch (error) {
      toast(error.message, 'error');
      renderTask();
    }
  }

  async function reopenItem() {
    if (!current || !isManager()) return;
    const ok = await confirmDialog({
      title: '重新打开条目',
      message: '重新打开后条目回到标注中，已提交的标注将变为草稿，需要重新提交复核。',
      confirmText: '重新打开',
    });
    if (!ok) return;
    try {
      await api.updateItem(current.item.id, { status: 'in_progress' });
      await loadItem(current.item.id, { skipGuard: true });
      loadQueue({ silent: true });
      toast('条目已重新打开', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function deleteItem() {
    if (!current || !isManager()) return;
    const ok = await confirmDialog({
      title: '删除条目',
      message: `将永久删除「${current.item.filename}」及其标注、复核记录与原始文件。此操作不可撤销。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    const id = current.item.id;
    try {
      await api.deleteItem(id);
      counts.total = Math.max(0, (counts.total || 0) - 1);
      counts[current.item.status] = Math.max(0, (counts[current.item.status] || 0) - 1);
      current = null;
      selectedItemId = null;
      dirty = false;
      destroyAnnotator();
      await loadQueue({ silent: true });
      renderHead();
      const next = items[0];
      if (next) await loadItem(next.id, { skipGuard: true });
      else mountEmptyCanvas();
      toast('条目已删除', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function triggerUpload() {
    if (!writable() || uploading) return;
    uploadInput.click();
  }

  function setUploadProgress(index, totalFiles, name, loaded, total) {
    uploadBox.hidden = false;
    const top = uploadBox.querySelector('.inline');
    const label = uploadBox.querySelector('.progress > i');
    const percent = total ? Math.round((loaded / total) * 100) : 0;
    if (top) {
      top.firstElementChild.textContent = `上传中 ${index}/${totalFiles} · ${name}`;
      top.lastElementChild.textContent = `${percent}%`;
    }
    if (label) label.style.width = `${percent}%`;
  }

  async function uploadFiles(files) {
    if (!writable()) {
      toast('项目已归档，无法上传', 'error');
      return;
    }
    if (uploading) {
      toast('已有上传任务进行中', 'info');
      return;
    }
    const list = [...files];
    if (!list.length) return;
    if (!(await guardUnsaved())) return;
    uploading = true;
    let lastId = null;
    let failed = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setUploadProgress(i + 1, list.length, file.name, 0, file.size);
        try {
          const result = await api.uploadItem(project.id, file, (loaded, total) => {
            setUploadProgress(i + 1, list.length, file.name, loaded, total);
          });
          lastId = result.item.id;
          counts.total = (counts.total || 0) + 1;
          counts.pending = (counts.pending || 0) + 1;
        } catch (error) {
          failed += 1;
          toast(`${file.name}：${error.message}`, 'error', 6000);
        }
      }
    } finally {
      uploading = false;
      uploadBox.hidden = true;
      renderHead();
      await loadQueue({ silent: true });
    }
    if (lastId) {
      await loadItem(lastId);
      toast(
        failed ? `上传完成，${list.length - failed} 个成功，${failed} 个失败` : `已上传 ${list.length} 个文件`,
        failed ? 'error' : 'ok'
      );
    }
  }

  function openExport() {
    if (exportHandle) return;
    const formats = EXPORT_FORMATS[kind] || [];
    let format = formats[0]?.[0];
    let scope = 'approved';
    const formatSelect = el('select', { className: 'select' });
    for (const [value, label] of formats) formatSelect.append(el('option', { value, text: label }));
    const description = el('p', { className: 'field-hint', text: formats[0]?.[2] || '' });
    formatSelect.addEventListener('change', () => {
      format = formatSelect.value;
      description.textContent = formats.find(([value]) => value === format)?.[2] || '';
    });
    const scopeSeg = el('div', { className: 'seg' });
    const scopeButtons = [
      ['approved', '仅已通过'],
      ['all', '全部标注'],
    ].map(([value, label]) =>
      el('button', {
        className: value === scope ? 'active' : '',
        type: 'button',
        text: label,
        onClick: () => {
          scope = value;
          for (const button of scopeButtons) button.classList.toggle('active', button.textContent === label);
        },
      })
    );
    scopeSeg.append(...scopeButtons);
    const downloadBtn = el('button', { className: 'btn btn-primary', type: 'button' }, icon('download'), '下载导出文件');
    const meta = el('div', { className: 'meta-list', style: { marginTop: '14px' } }, [
      metaRow('项目', project.name),
      metaRow('类型', KIND_LABEL[kind]),
      metaRow('条目', String(counts.total || 0)),
      metaRow('通过', String(counts.approved || 0)),
    ]);
    const modal = openModal({
      title: '导出数据集',
      subtitle: '导出在服务端生成，包含有效标注的条目。',
      body: [
        field('导出格式', formatSelect, { hint: undefined }),
        description,
        el('div', { className: 'field' }, el('label', { text: '范围' }), scopeSeg),
        meta,
      ],
      footer: [
        el('button', { className: 'btn btn-ghost', type: 'button', text: '取消', onClick: () => modal.close() }),
        downloadBtn,
      ],
      onClose: () => {
        exportHandle = null;
      },
    });
    exportHandle = modal;
    downloadBtn.addEventListener('click', async () => {
      downloadBtn.disabled = true;
      downloadBtn.textContent = '生成中…';
      try {
        const response = await fetch(api.exportUrl(project.id, format, scope), { credentials: 'same-origin' });
        if (!response.ok) {
          let message = `导出失败 (${response.status})`;
          try {
            const payload = await response.json();
            message = payload?.error?.message || message;
          } catch {
            /* ignore */
          }
          throw new ApiError(response.status, 'EXPORT', message);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        const plain = disposition.match(/filename="([^"]+)"/i);
        const filename = utf8 ? decodeURIComponent(utf8[1]) : plain?.[1] || `${project.name}-${format}.json`;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast('导出已开始下载', 'ok');
        modal.close();
      } catch (error) {
        toast(error.message, 'error', 6000);
        downloadBtn.disabled = false;
        downloadBtn.textContent = '下载导出文件';
      }
    });
  }

  async function openSettings() {
    if (!isManager() || settingsHandle) return;
    if (dirty) await persist({ silent: true });
    settingsHandle = openProjectSettings({
      project,
      members,
      onProjectUpdate: async (freshProject, freshMembers) => {
        project = { ...project, ...freshProject };
        role = freshProject.role || role;
        if (freshProject.counts) counts = { ...counts, ...freshProject.counts };
        if (freshProject.labelSchema) {
          schema = freshProject.labelSchema;
          if (!(schema.labels || []).some((label) => label.id === currentLabel)) {
            currentLabel = schema.labels?.[0]?.id || null;
          }
        }
        if (freshMembers) members = freshMembers;
        renderHead();
        applyWriteState();
        if (selectedItemId) await loadItem(selectedItemId, { skipGuard: true });
        else mountEmptyCanvas();
        loadQueue({ silent: true });
      },
      onMembersChange: (freshMembers) => {
        members = freshMembers;
        renderTask();
      },
      onDeleted: () => {
        settingsHandle = null;
        location.hash = '#/projects';
      },
      onClose: () => {
        settingsHandle = null;
      },
    });
  }

  function closeOverlays() {
    workbench.classList.remove('show-queue', 'show-inspector');
  }

  function onGlobalKey(event) {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!readOnly) persist({});
      return;
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      if (!readOnly) submitAnnotation();
      return;
    }
    if (!mod && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === '[') {
        event.preventDefault();
        adjacent(-1);
      } else if (event.key === ']') {
        event.preventDefault();
        adjacent(1);
      }
    }
  }

  function onBeforeUnload(event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function onDragEnter(event) {
    if (!writable() || !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    dropOverlay.hidden = false;
  }

  function onDragOver(event) {
    if (!writable() || !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event) {
    if (!writable()) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.hidden = true;
  }

  function onDrop(event) {
    if (!writable()) return;
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) uploadFiles(files);
  }

  function onWindowDragOver(event) {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  }

  function onWindowDrop(event) {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  }

  searchInput.addEventListener('input', debounce(() => {
    search = searchInput.value.trim();
    page = 1;
    loadQueue({ silent: true });
  }, 260));
  statusSelect.addEventListener('change', () => {
    statusFilter = statusSelect.value;
    page = 1;
    loadQueue({});
  });
  workbench.addEventListener('dragenter', onDragEnter);
  workbench.addEventListener('dragover', onDragOver);
  workbench.addEventListener('dragleave', onDragLeave);
  workbench.addEventListener('drop', onDrop);
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('drop', onWindowDrop);
  window.addEventListener('keydown', onGlobalKey);
  window.addEventListener('beforeunload', onBeforeUnload);

  renderHead();
  renderQueueChrome();
  mountEmptyCanvas();
  await loadQueue();

  if (initialItemId) {
    const opened = await loadItem(initialItemId, { skipGuard: true });
    if (!opened && items.length) {
      await loadItem(items[0].id, { skipGuard: true });
      toast('指定条目无法打开，已切换到队列第一条', 'error');
    }
  } else if (items.length) {
    await loadItem(items[0].id, { skipGuard: true });
  } else {
    mountEmptyCanvas();
  }

  return function cleanup() {
    removed = true;
    document.title = 'OVERMARKED';
    scheduleAutosave.cancel();
    queueRefresh.cancel();
    window.removeEventListener('dragover', onWindowDragOver);
    window.removeEventListener('drop', onWindowDrop);
    window.removeEventListener('keydown', onGlobalKey);
    window.removeEventListener('beforeunload', onBeforeUnload);
    workbench.removeEventListener('dragenter', onDragEnter);
    workbench.removeEventListener('dragover', onDragOver);
    workbench.removeEventListener('dragleave', onDragLeave);
    workbench.removeEventListener('drop', onDrop);
    settingsHandle?.close?.();
    settingsHandle = null;
    exportHandle?.close?.();
    exportHandle = null;
    if (dirty && annotator && current && !readOnly) {
      try {
        const body = JSON.stringify({ data: annotator.getData(), submit: false });
        if (body.length < 60000) {
          fetch(`/api/items/${encodeURIComponent(current.item.id)}/annotation`, {
            method: 'PUT',
            keepalive: true,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-OM-Request': '1' },
            body,
          }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }
    destroyAnnotator();
    current = null;
  };
}
