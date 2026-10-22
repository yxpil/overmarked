const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  text: '<path d="M5 6h14M5 10h14M5 14h9M5 18h6"/>',
  audio: '<path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4"/>',
  map: '<path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2V6Z"/><path d="M9 4v14M15 6v14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/>',
  upload: '<path d="M12 16V4m0 0 4 4m-4-4L8 8M4 20h16"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.6-3.4 3.2-5.5 7-5.5s6.4 2.1 7 5.5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
  play: '<path d="M8 5v14l11-7L8 5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  cursor: '<path d="m5 3 6.5 16 2.2-6.3L20 10.5 5 3Z"/>',
  box: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 3"/>',
  polygon: '<path d="m12 3 8 6-3 10H7L4 9l8-6Z"/>',
  point: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/>',
  line: '<path d="M4 19 20 5"/><circle cx="4" cy="19" r="1.5"/><circle cx="20" cy="5" r="1.5"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M15 4v16"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h0M4 12h0M4 18h0"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  loop: '<path d="M4 12a8 8 0 0 1 13.6-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.6 5.7L4 16M4 20v-4h4"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2M8 11h6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  alert: '<path d="M12 4 2.8 20h18.4L12 4Z"/><path d="M12 10v4M12 17h0"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9V4Z"/><circle cx="8" cy="8" r="1.2"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.grid}</svg>`;
  return span;
}

export function el(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props && typeof props === 'object') {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (typeof value === 'boolean' || ['value', 'checked', 'selected', 'disabled'].includes(key)) {
        node[key] = value;
      } else if (key === 'attrs' && typeof value === 'object') {
        for (const [attr, attrValue] of Object.entries(value)) node.setAttribute(attr, attrValue);
      } else if (typeof value === 'string' || typeof value === 'number') {
        node.setAttribute(key, value);
      }
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function toast(message, type = 'info', duration = 4200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { className: `toast ${type}`, text: message, attrs: { role: 'status' } });
  host.append(node);
  const timer = setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(4px)';
    node.style.transition = 'opacity 150ms, transform 150ms';
    setTimeout(() => node.remove(), 180);
  }, duration);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    node.remove();
  });
}

const modalStack = [];

export function openModal({ title, subtitle = '', body = null, footer = null, wide = false, onClose = null }) {
  const host = document.getElementById('modal-root');
  const overlay = el('div', { className: 'modal-overlay' });
  const modal = el('div', { className: `modal${wide ? ' modal-wide' : ''}`, attrs: { role: 'dialog', 'aria-modal': 'true' } });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    const index = modalStack.indexOf(overlay);
    if (index >= 0) modalStack.splice(index, 1);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && modalStack[modalStack.length - 1] === overlay) {
      event.stopPropagation();
      close();
    }
  };
  const head = el(
    'div',
    { className: 'modal-head' },
    el('div', null, el('h2', { text: title }), subtitle ? el('p', { text: subtitle }) : null),
    el('button', { className: 'btn btn-ghost btn-icon modal-x', attrs: { 'aria-label': '关闭' }, onClick: close }, icon('x'))
  );
  const bodyEl = el('div', { className: 'modal-body' }, body);
  const elements = [head, bodyEl];
  if (footer) elements.push(el('div', { className: 'modal-foot' }, footer));
  modal.append(...elements);
  overlay.append(modal);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  host.append(overlay);
  modalStack.push(overlay);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => {
    const target = modal.querySelector('input,button,select,textarea');
    if (target) target.focus();
  });
  return { close, body: bodyEl, modal, overlay };
}

export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  requireText = null,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const bodyParts = [el('p', { className: 'muted', text: message, style: { lineHeight: '1.65', fontSize: '13px' } })];
    let input = null;
    if (requireText) {
      input = el('input', {
        className: 'input',
        placeholder: requireText,
        style: { marginTop: '12px' },
        attrs: { autocomplete: 'off' },
      });
      bodyParts.push(
        el('p', { className: 'field-hint', text: `请输入「${requireText}」以确认`, style: { marginTop: '8px' } }),
        input
      );
    }
    const confirmBtn = el(
      'button',
      {
        className: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
        text: confirmText,
        disabled: Boolean(requireText),
        onClick: () => {
          settle(true);
          modal.close();
        },
      },
      null
    );
    if (input) {
      input.addEventListener('input', () => {
        confirmBtn.disabled = input.value !== requireText;
      });
    }
    const modal = openModal({
      title,
      body: bodyParts,
      footer: [
        el('button', {
          className: 'btn btn-ghost',
          text: cancelText,
          onClick: () => modal.close(),
        }),
        confirmBtn,
      ],
      onClose: () => settle(false),
    });
    if (input) requestAnimationFrame(() => input.focus());
  });
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(iso, withTime = true) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (v) => String(v).padStart(2, '0');
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${base} ${pad(date.getHours())}:${pad(date.getMinutes())}` : base;
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '—';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(iso, false);
}

export function initials(name) {
  const chars = Array.from(String(name || '?').trim());
  if (!chars.length) return '?';
  if (/^[\x00-\x7F]+$/.test(name)) {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('');
  }
  return chars[0].toUpperCase();
}

export const STATUS_LABEL = {
  pending: '未标注',
  in_progress: '标注中',
  submitted: '待复核',
  approved: '已通过',
  rejected: '已驳回',
  draft: '草稿',
};

export const KIND_LABEL = { image: '图片', text: '文本', audio: '音频', spatial: '空间' };
export const KIND_ICON = { image: 'image', text: 'text', audio: 'audio', spatial: 'map' };
export const ROLE_LABEL = { admin: '系统管理员', manager: '项目管理员', reviewer: '复核员', annotator: '标注员' };

export function statusEl(status) {
  return el(
    'span',
    { className: `status ${status}` },
    el('i', { className: `status-dot ${status}` }),
    STATUS_LABEL[status] || status
  );
}

export function kindEl(kind) {
  return el('span', { className: 'kind' }, icon(KIND_ICON[kind] || 'grid'), KIND_LABEL[kind] || kind);
}

export function debounce(fn, ms = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function busy(button, isBusy, label) {
  if (!button) return;
  if (isBusy) {
    button.dataset.original = button.textContent;
    button.classList.add('is-busy');
    button.disabled = true;
    if (label) {
      clear(button);
      append(button, [el('span', { className: 'spinner' }), label]);
    }
  } else {
    button.classList.remove('is-busy');
    button.disabled = false;
    if (label) {
      clear(button);
      append(button, [label]);
    }
  }
}

export function field(labelText, input, { hint = null, error = null } = {}) {
  return el(
    'div',
    { className: 'field' },
    el('label', { text: labelText }),
    input,
    hint ? el('div', { className: 'field-hint', text: hint }) : null,
    error ? el('div', { className: 'field-error', text: error }) : null
  );
}

export function option(value, label, selected = false) {
  return el('option', { value, text: label, selected });
}

export function emptyState({ iconName = 'grid', title, description, action = null }) {
  return el(
    'div',
    { className: 'empty-state' },
    icon(iconName),
    el('h3', { text: title }),
    description ? el('p', { text: description }) : null,
    action
  );
}
