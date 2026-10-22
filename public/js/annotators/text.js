import { api } from '../api.js';
import { clear, el, toast } from '../ui.js';
import { clamp, isTyping, labelNameMap, newId } from './shared.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createTextAnnotator(host, { item, schema, data, readOnly = false, onChange, onSelect }) {
  const labels = schema.labels || [];
  const docLabels = schema.documentLabels || [];
  const labelMap = labelNameMap(schema);

  const root = el('div', { className: 'text-annotator' });
  const toolbar = el('div', { className: 'text-toolbar' });
  const scroll = el('div', { className: 'text-scroll' });
  const doc = el('div', { className: 'text-doc', attrs: { spellcheck: 'false' } });
  const footLeft = el('span');
  const footRight = el('span');
  const foot = el('div', { className: 'text-foot' }, footLeft, footRight);
  const loader = el('div', { className: 'stage-empty' }, el('span', { className: 'spinner' }), el('p', { text: '加载文本…' }));

  scroll.append(doc);
  root.append(toolbar, scroll, foot, loader);
  host.append(root);

  let text = '';
  let entities = clone(Array.isArray(data?.entities) ? data.entities : []);
  let documentLabels = [...new Set(Array.isArray(data?.documentLabels) ? data.documentLabels : [])];
  let note = typeof data?.note === 'string' ? data.note : '';
  let selectedId = null;
  let currentLabel = labels[0]?.id || null;
  let pending = null;
  let pop = null;
  let loadToken = 0;
  const history = [];
  const future = [];

  function snapshot() {
    return JSON.stringify({ entities, documentLabels });
  }

  function getData() {
    return {
      entities: entities
        .map((entity) => ({
          id: entity.id,
          start: entity.start,
          end: entity.end,
          label: entity.label,
        }))
        .sort((a, b) => a.start - b.start),
      documentLabels: [...documentLabels],
      note,
    };
  }

  function notifyChange() {
    updateFoot();
    onChange?.(getData());
  }

  function pushHistory(snap = snapshot()) {
    history.push(snap);
    if (history.length > 100) history.shift();
    future.length = 0;
  }

  function updateFoot() {
    const chars = text.length.toLocaleString('zh-CN');
    footLeft.textContent = `${chars} 字符 · ${entities.length} 实体 · ${documentLabels.length} 文档标签`;
    footRight.textContent = readOnly ? '只读模式 · 可选择复制文本' : '拖选文本添加实体 · 点击实体选中 · Esc 取消';
  }

  function labelColor(id) {
    return labelMap.get(id)?.color || '#f5a524';
  }

  function select(id) {
    if (selectedId === id) {
      if (id) highlightSelected();
      return;
    }
    selectedId = id;
    highlightSelected();
    onSelect?.(id);
  }

  function highlightSelected() {
    for (const mark of doc.querySelectorAll('mark[data-id]')) {
      mark.classList.toggle('selected', mark.dataset.id === selectedId);
    }
    for (const button of toolbar.querySelectorAll('.doc-label-chip')) {
      button.classList.toggle('on', documentLabels.includes(button.dataset.id));
    }
  }

  function render() {
    const previousScroll = scroll.scrollTop;
    hidePopover();
    clear(doc);
    const sorted = [...entities].sort((a, b) => a.start - b.start || a.end - b.end);
    let cursor = 0;
    for (const entity of sorted) {
      if (entity.start > cursor) doc.append(document.createTextNode(text.slice(cursor, entity.start)));
      const color = labelColor(entity.label);
      const name = labelMap.get(entity.label)?.name || entity.label;
      const mark = el('mark', {
        className: entity.id === selectedId ? 'selected' : '',
        text: text.slice(entity.start, entity.end),
        dataset: { id: entity.id },
        attrs: {
          style: `--label-color:${color}`,
          title: `${name} · ${entity.start}–${entity.end}`,
        },
      });
      doc.append(mark);
      cursor = entity.end;
    }
    doc.append(document.createTextNode(text.slice(cursor)));
    scroll.scrollTop = previousScroll;
    highlightSelected();
    updateFoot();
  }

  function buildToolbar() {
    clear(toolbar);
    toolbar.append(
      el('span', { className: 'eyebrow', text: '标注标签', style: { marginRight: '2px' } })
    );
    for (const label of labels) {
      toolbar.append(
        el(
          'span',
          { className: 'doc-label-chip', title: label.name, style: { cursor: 'default' } },
          el('i', { className: 'swatch', style: { background: label.color } }),
          label.name,
          label.hotkey ? el('kbd', { className: 'key', text: label.hotkey }) : null
        )
      );
    }
    if (docLabels.length) {
      toolbar.append(el('span', { className: 'tool-sep', style: { height: '18px', width: '1px', background: 'var(--line)' } }));
      toolbar.append(el('span', { className: 'eyebrow', text: '文档标签' }));
      for (const label of docLabels) {
        toolbar.append(
          el(
            'button',
            {
              className: `doc-label-chip${documentLabels.includes(label.id) ? ' on' : ''}`,
              type: 'button',
              dataset: { id: label.id },
              disabled: readOnly,
              title: readOnly ? '只读模式' : `切换文档标签：${label.name}`,
              onClick: () => toggleDocumentLabel(label.id),
            },
            el('i', { className: 'swatch', style: { background: label.color } }),
            label.name
          )
        );
      }
    }
    toolbar.append(el('div', { style: { flex: '1' } }));
    toolbar.append(
      el('span', {
        className: 'field-hint',
        style: { margin: '0', fontSize: '10px' },
        text: readOnly ? '只读' : '选中文本 → 在弹出的标签中选择',
      })
    );
  }

  function toggleDocumentLabel(id) {
    if (readOnly) return;
    pushHistory();
    const index = documentLabels.indexOf(id);
    if (index >= 0) documentLabels.splice(index, 1);
    else documentLabels.push(id);
    highlightSelected();
    notifyChange();
  }

  function offsetWithin(node, offset) {
    try {
      const range = document.createRange();
      range.selectNodeContents(doc);
      range.setEnd(node, offset);
      return range.toString().length;
    } catch {
      return -1;
    }
  }

  function overlaps(start, end) {
    return entities.some((entity) => start < entity.end && end > entity.start);
  }

  function hidePopover() {
    pending = null;
    if (pop) {
      pop.remove();
      pop = null;
    }
  }

  function showPopover(rect) {
    const next = pending;
    hidePopover();
    pending = next;
    if (!pending) return;
    pop = el(
      'div',
      { className: 'selection-pop', attrs: { role: 'menu' } },
      el(
        'div',
        { className: 'pop-head' },
        el('span', { text: `${pending.end - pending.start} 字符` }),
        el('span', { text: `${pending.start}–${pending.end}` })
      ),
      labels.map((label) =>
        el(
          'button',
          {
            type: 'button',
            onClick: () => applyPending(label.id),
            attrs: { role: 'menuitem' },
          },
          el('i', { className: 'swatch', style: { background: label.color } }),
          el('span', { style: { flex: '1' }, text: label.name }),
          label.hotkey ? el('kbd', { className: 'key', text: label.hotkey }) : null
        )
      )
    );
    document.body.append(pop);
    const width = pop.offsetWidth || 180;
    const height = pop.offsetHeight || 60;
    let left = clamp(rect.left, 8, window.innerWidth - width - 8);
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    if (rect.left + rect.width / 2 < width / 2) left = 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function applyPending(labelId) {
    if (!pending || readOnly) return;
    const { start, end } = pending;
    if (overlaps(start, end)) {
      toast('所选文本与已有实体重叠', 'error');
      hidePopover();
      return;
    }
    pushHistory();
    const id = newId();
    entities.push({ id, start, end, label: labelId });
    currentLabel = labelId;
    hidePopover();
    window.getSelection()?.removeAllRanges();
    selectedId = id;
    render();
    onSelect?.(id);
    notifyChange();
    scrollToEntity(id);
  }

  function scrollToEntity(id) {
    const mark = [...doc.querySelectorAll('mark[data-id]')].find((node) => node.dataset.id === id);
    mark?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function removeEntity(id) {
    if (readOnly) return;
    const entity = entities.find((entry) => entry.id === id);
    if (!entity) return;
    pushHistory();
    entities = entities.filter((entry) => entry.id !== id);
    if (selectedId === id) {
      selectedId = null;
      onSelect?.(null);
    }
    render();
    notifyChange();
  }

  function changeLabel(id, labelId) {
    const entity = entities.find((entry) => entry.id === id);
    if (!entity || entity.label === labelId) return;
    pushHistory();
    entity.label = labelId;
    render();
    notifyChange();
  }

  function undo() {
    if (!history.length) return;
    future.push(snapshot());
    const state = JSON.parse(history.pop());
    entities = state.entities;
    documentLabels = state.documentLabels;
    selectedId = null;
    hidePopover();
    onSelect?.(null);
    render();
    notifyChange();
  }

  function redo() {
    if (!future.length) return;
    history.push(snapshot());
    const state = JSON.parse(future.pop());
    entities = state.entities;
    documentLabels = state.documentLabels;
    selectedId = null;
    hidePopover();
    onSelect?.(null);
    render();
    notifyChange();
  }

  function onMouseUp() {
    if (readOnly) return;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!doc.contains(range.startContainer) || !doc.contains(range.endContainer)) return;
    let start = offsetWithin(range.startContainer, range.startOffset);
    let end = offsetWithin(range.endContainer, range.endOffset);
    if (start < 0 || end < 0) return;
    if (start > end) [start, end] = [end, start];
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end <= start) return;
    if (overlaps(start, end)) {
      toast('所选文本与已有实体重叠，无法添加', 'error');
      return;
    }
    pending = { start, end };
    showPopover(range.getBoundingClientRect());
  }

  function onClick(event) {
    const mark = event.target.closest?.('mark[data-id]');
    if (!mark) return;
    select(mark.dataset.id);
  }

  function onDocPointerDown(event) {
    if (!pop) return;
    if (pop.contains(event.target)) return;
    hidePopover();
  }

  function onScroll() {
    if (pop) hidePopover();
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
      if (pop) {
        hidePopover();
        window.getSelection()?.removeAllRanges();
      } else if (selectedId) {
        select(null);
      }
      return;
    }
    if (readOnly) return;
    if (event.key === 'Delete' && selectedId && window.getSelection()?.isCollapsed) {
      event.preventDefault();
      removeEntity(selectedId);
      return;
    }
    const hotkey = event.key.toLowerCase();
    const label = labels.find((entry) => entry.hotkey === hotkey);
    if (label) {
      if (pending) {
        event.preventDefault();
        applyPending(label.id);
      } else if (selectedId) {
        event.preventDefault();
        changeLabel(selectedId, label.id);
      }
    }
  }

  async function load() {
    const token = ++loadToken;
    loader.hidden = false;
    try {
      const value = await api.fetchText(item.id);
      if (token !== loadToken) return;
      text = value;
      loader.hidden = true;
      doc.hidden = false;
      buildToolbar();
      render();
      document.addEventListener('pointerdown', onDocPointerDown);
      document.addEventListener('selectionchange', onSelectionChange);
      window.addEventListener('keydown', onKeyDown);
      scroll.addEventListener('scroll', onScroll);
      scroll.addEventListener('mouseup', onMouseUp);
      doc.addEventListener('click', onClick);
    } catch (error) {
      if (token !== loadToken) return;
      loader.hidden = true;
      clear(doc);
      doc.append(
        el(
          'div',
          { className: 'error-pane' },
          el('h3', { text: '文本加载失败' }),
          el('p', { text: error.message }),
          el('button', { className: 'btn btn-sm', text: '重试', onClick: load })
        )
      );
      updateFoot();
    }
  }

  let selectionTimer = null;
  function onSelectionChange() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      if (!pending) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) hidePopover();
    }, 80);
  }

  buildToolbar();
  updateFoot();
  load();

  return {
    getData,
    getMetaPatch: () => null,
    setLabel(labelId) {
      currentLabel = labelId;
      if (selectedId) changeLabel(selectedId, labelId);
    },
    setNote(value) {
      note = value;
    },
    focus(id) {
      select(id);
      scrollToEntity(id);
    },
    remove: removeEntity,
    selected: () => selectedId,
    currentLabel: () => currentLabel,
    destroy() {
      loadToken += 1;
      hidePopover();
      clearTimeout(selectionTimer);
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('keydown', onKeyDown);
      scroll.removeEventListener('scroll', onScroll);
      scroll.removeEventListener('mouseup', onMouseUp);
      doc.removeEventListener('click', onClick);
      root.remove();
    },
  };
}
