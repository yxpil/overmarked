import { api, ApiError } from './api.js';
import {
  clear,
  el,
  field,
  icon,
  initials,
  openModal,
  ROLE_LABEL,
  toast,
} from './ui.js';
import { renderLogin } from './views/login.js';
import { renderProjects } from './views/projects.js';
import { renderProject } from './views/project.js';
import { renderAdmin } from './views/admin.js';

const topbar = document.getElementById('topbar');
const view = document.getElementById('view');

export const state = { user: null };
let cleanupView = null;
let routeToken = 0;

function hideBoot() {
  document.body.classList.add('ready');
}

function loginMode(on) {
  document.body.classList.toggle('is-login', on);
  document.body.classList.toggle('page-scroll', on);
  topbar.hidden = on;
  if (on) clear(topbar);
}

function go(hash) {
  const next = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === next) route();
  else location.hash = next;
}

function navButton(label, hash, active) {
  return el('button', {
    className: `btn btn-ghost btn-sm${active ? ' active' : ''}`,
    text: label,
    onClick: () => go(hash),
  });
}

function openAccountModal() {
  const user = state.user;
  const current = el('input', { className: 'input', type: 'password', attrs: { autocomplete: 'current-password' } });
  const next = el('input', { className: 'input', type: 'password', attrs: { autocomplete: 'new-password' } });
  const confirm = el('input', { className: 'input', type: 'password', attrs: { autocomplete: 'new-password' } });
  const error = el('div', { className: 'form-error', hidden: true });
  const submit = el('button', { className: 'btn btn-primary', text: '更新密码' });
  const modal = openModal({
    title: '账号设置',
    subtitle: `${user.displayName} · ${user.username} · ${ROLE_LABEL[user.role] || user.role}`,
    body: [
      el('p', { className: 'field-hint', text: '修改密码后，所有已登录会话将失效，需要重新登录。', style: { marginBottom: '14px' } }),
      error,
      field('当前密码', current),
      field('新密码（8..128 字符）', next),
      field('确认新密码', confirm),
    ],
    footer: [el('button', { className: 'btn btn-ghost', text: '关闭', onClick: () => modal.close() }), submit],
  });
  submit.addEventListener('click', async () => {
    error.hidden = true;
    if (next.value !== confirm.value) {
      error.textContent = '两次输入的新密码不一致';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = '更新中…';
    try {
      await api.changePassword(current.value, next.value);
      modal.close();
      state.user = null;
      loginMode(true);
      toast('密码已更新，请重新登录', 'ok');
      go('#/login');
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = '更新密码';
    }
  });
}

function buildTopbar({ crumbs = [], active = 'projects' }) {
  clear(topbar);
  topbar.hidden = false;
  const brand = el(
    'a',
    { className: 'brand', href: '#/projects', attrs: { 'aria-label': 'OVERMARKED 项目列表' } },
    el('span', { className: 'brand-mark' }, el('i'), el('i'), el('i'), el('i')),
    el('span', { className: 'brand-word', text: 'OVERMARKED' }),
    el('span', { className: 'brand-ver', text: 'v1.0' })
  );
  const crumbNodes = el('div', { className: 'crumbs' });
  crumbs.forEach((crumb, index) => {
    if (index) crumbNodes.append(el('span', { className: 'sep', text: '/' }));
    if (crumb.hash) {
      crumbNodes.append(el('a', { className: 'muted', href: crumb.hash, text: crumb.label }));
    } else {
      crumbNodes.append(el('span', { className: 'current', text: crumb.label }));
    }
  });
  const actions = el('div', { className: 'top-actions' });
  actions.append(navButton('项目', '#/projects', active === 'projects'));
  if (state.user.role === 'admin') actions.append(navButton('审计', '#/admin', active === 'admin'));
  actions.append(
    el(
      'button',
      { className: 'user-chip', onClick: openAccountModal, attrs: { title: '账号设置', 'aria-label': '账号设置' }, style: { background: 'none', border: '0' } },
      el('span', { className: 'avatar', text: initials(state.user.displayName) }),
      el(
        'span',
        { className: 'user-meta' },
        el('b', { text: state.user.displayName }),
        el('span', { text: ROLE_LABEL[state.user.role] || state.user.role })
      )
    ),
    el(
      'button',
      {
        className: 'btn btn-ghost btn-icon',
        title: '退出登录',
        attrs: { 'aria-label': '退出登录' },
        onClick: async () => {
          try {
            await api.logout();
          } catch {
            /* session may already be gone */
          }
          state.user = null;
          loginMode(true);
          toast('已退出登录', 'info');
          go('#/login');
        },
      },
      icon('logout')
    )
  );
  topbar.append(brand, crumbNodes, actions);
}

async function route() {
  const token = ++routeToken;
  if (cleanupView) {
    try {
      cleanupView();
    } catch {
      /* ignore */
    }
    cleanupView = null;
  }
  clear(view);
  view.className = 'view';
  const hash = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = hash.split('?');
  const query = new URLSearchParams(queryPart || '');
  const segments = pathPart.split('/').filter(Boolean);

  if (!state.user) {
    loginMode(true);
    renderLogin(view, {
      onSuccess: async (user) => {
        state.user = user;
        loginMode(false);
        if (location.hash === '#/login' || !location.hash) go('#/projects');
        else await route();
      },
    });
    hideBoot();
    return;
  }

  if (pathPart === '/login' || pathPart === '/') {
    go('#/projects');
    return;
  }

  loginMode(false);
  const active = segments[0] === 'admin' ? 'admin' : 'projects';
  let crumbs = [{ label: '项目', hash: '#/projects' }];
  if (segments[0] === 'p' && segments[1]) {
    crumbs = [{ label: '项目', hash: '#/projects' }, { label: '工作台' }];
  } else if (segments[0] === 'admin') {
    crumbs = [{ label: '项目', hash: '#/projects' }, { label: '审计' }];
  }
  buildTopbar({ crumbs, active });

  try {
    if (segments[0] === 'admin') {
      await renderAdmin(view, { state });
    } else if (segments[0] === 'p' && segments[1]) {
      const result = await renderProject(view, {
        state,
        projectId: segments[1],
        initialItemId: query.get('item'),
        setCrumb: (label) => buildTopbar({ crumbs: [{ label: '项目', hash: '#/projects' }, { label }], active: 'projects' }),
        onRefreshProjects: () => {},
      });
      if (token !== routeToken) {
        result?.();
        return;
      }
      cleanupView = result || null;
    } else {
      await renderProjects(view, {
        state,
        onOpen: (id) => go(`#/p/${id}`),
      });
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    console.error(error);
    clear(view);
    view.className = 'view page';
    const pane = el(
      'div',
      { className: 'fatal' },
      el('h1', { text: '页面加载失败' }),
      el('p', { text: error.message || '未知错误' }),
      el('button', { className: 'btn', text: '返回项目列表', onClick: () => go('#/projects') })
    );
    view.append(pane);
  }
  hideBoot();
}

async function boot() {
  try {
    const { user } = await api.me();
    state.user = user;
  } catch {
    state.user = null;
  }
  if (!location.hash) location.hash = state.user ? '#/projects' : '#/login';
  await route();
}

window.addEventListener('hashchange', () => {
  route();
});
window.addEventListener('om:unauthorized', () => {
  if (!state.user) return;
  state.user = null;
  loginMode(true);
  toast('会话已失效，请重新登录', 'error');
  go('#/login');
});

boot();
