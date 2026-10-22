import { api } from '../api.js';
import {
  clear,
  confirmDialog,
  debounce,
  el,
  field,
  formatDate,
  icon,
  initials,
  openModal,
  toast,
} from '../ui.js';

const SYSTEM_ROLE_LABEL = { admin: '系统管理员', user: '普通用户' };
const STATUS_LABEL = { active: '启用', disabled: '停用' };
const AUDIT_ACTIONS = [
  ['', '全部操作'],
  ['auth.login', '登录'],
  ['auth.login_failed', '登录失败'],
  ['auth.logout', '退出登录'],
  ['auth.password', '修改密码'],
  ['user.create', '创建用户'],
  ['user.update', '更新用户'],
  ['project.create', '创建项目'],
  ['project.update', '更新项目'],
  ['project.delete', '删除项目'],
  ['member.add', '添加成员'],
  ['member.update', '调整成员'],
  ['member.remove', '移除成员'],
  ['item.upload', '上传条目'],
  ['item.assign', '指派条目'],
  ['item.status', '条目状态'],
  ['item.meta', '条目元数据'],
  ['item.delete', '删除条目'],
  ['annotation.save', '保存标注'],
  ['annotation.submit', '提交标注'],
  ['review.approve', '复核通过'],
  ['review.reject', '复核驳回'],
  ['export.download', '导出数据集'],
];
const ACTION_LABEL = Object.fromEntries(AUDIT_ACTIONS.slice(1));

function describeDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail)
    .map(([key, value]) => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return `${key}=${JSON.stringify(value)}`;
      return `${key}=${String(value)}`;
    })
    .filter(Boolean)
    .join(' · ');
}

function statCard(label, value) {
  return el(
    'div',
    { className: 'stat' },
    el('span', { text: label }),
    el('b', null, String(value))
  );
}

function userModal({ user = null, onSaved }) {
  const isEdit = Boolean(user);
  const username = el('input', {
    className: 'input',
    value: user?.username || '',
    disabled: isEdit,
    placeholder: '3..32 位字母、数字、_.-',
    attrs: { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' },
  });
  const displayName = el('input', {
    className: 'input',
    value: user?.displayName || '',
    placeholder: '显示名称',
    attrs: { maxlength: '40', autocomplete: 'off' },
  });
  const password = el('input', {
    className: 'input',
    type: 'password',
    placeholder: isEdit ? '留空表示不修改' : '至少 8 位',
    attrs: { autocomplete: 'new-password' },
  });
  const role = el('select', { className: 'select' });
  for (const value of ['user', 'admin']) {
    role.append(el('option', { value, text: SYSTEM_ROLE_LABEL[value], selected: (user?.role || 'user') === value }));
  }
  const error = el('div', { className: 'form-error', hidden: true });
  const submit = el('button', { className: 'btn btn-primary', type: 'button', text: isEdit ? '保存修改' : '创建用户' });
  const modal = openModal({
    title: isEdit ? '编辑用户' : '新建用户',
    subtitle: isEdit ? `${user.username} · 系统角色与显示名称` : '管理员可以访问全部项目与系统审计。',
    body: [
      error,
      field('用户名', username),
      field('显示名称', displayName),
      field(isEdit ? '新密码（可选）' : '初始密码', password, {
        hint: isEdit ? '填写后会立即吊销该用户的全部登录会话。' : '8..128 字符；创建后请通知用户修改。',
      }),
      field('系统角色', role, { hint: '项目内角色（manager / reviewer / annotator）在项目设置中配置。' }),
    ],
    footer: [
      el('button', { className: 'btn btn-ghost', type: 'button', text: '取消', onClick: () => modal.close() }),
      submit,
    ],
  });

  submit.addEventListener('click', async () => {
    error.hidden = true;
    if (!isEdit && !username.value.trim()) {
      error.textContent = '请输入用户名';
      error.hidden = false;
      return;
    }
    if (!displayName.value.trim()) {
      error.textContent = '请输入显示名称';
      error.hidden = false;
      return;
    }
    if (!isEdit && password.value.length < 8) {
      error.textContent = '初始密码至少 8 位';
      error.hidden = false;
      return;
    }
    if (isEdit && password.value && password.value.length < 8) {
      error.textContent = '新密码至少 8 位';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = isEdit ? '保存中…' : '创建中…';
    try {
      let result;
      if (isEdit) {
        const payload = { displayName: displayName.value.trim(), role: role.value };
        if (password.value) payload.password = password.value;
        result = await api.updateUser(user.id, payload);
        toast('用户信息已更新', 'ok');
      } else {
        result = await api.createUser({
          username: username.value.trim(),
          displayName: displayName.value.trim(),
          password: password.value,
          role: role.value,
        });
        toast(`用户「${result.user.displayName}」已创建`, 'ok');
      }
      modal.close();
      onSaved(result.user);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = isEdit ? '保存修改' : '创建用户';
    }
  });
}

function passwordModal(user, onSaved) {
  const password = el('input', {
    className: 'input',
    type: 'password',
    attrs: { autocomplete: 'new-password' },
    placeholder: '至少 8 位',
  });
  const confirm = el('input', {
    className: 'input',
    type: 'password',
    attrs: { autocomplete: 'new-password' },
    placeholder: '再次输入',
  });
  const error = el('div', { className: 'form-error', hidden: true });
  const submit = el('button', { className: 'btn btn-primary', type: 'button', text: '重置密码' });
  const modal = openModal({
    title: '重置密码',
    subtitle: `${user.displayName} · ${user.username}`,
    body: [
      el('p', { className: 'field-hint', text: '重置后该用户的全部会话会立即失效，需要使用新密码重新登录。', style: { marginBottom: '12px' } }),
      error,
      field('新密码', password, { hint: '8..128 字符' }),
      field('确认新密码', confirm),
    ],
    footer: [
      el('button', { className: 'btn btn-ghost', type: 'button', text: '取消', onClick: () => modal.close() }),
      submit,
    ],
  });
  submit.addEventListener('click', async () => {
    error.hidden = true;
    if (password.value.length < 8) {
      error.textContent = '密码至少 8 位';
      error.hidden = false;
      return;
    }
    if (password.value !== confirm.value) {
      error.textContent = '两次输入的密码不一致';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = '重置中…';
    try {
      const result = await api.updateUser(user.id, { password: password.value });
      modal.close();
      toast('密码已重置，该用户需要重新登录', 'ok');
      onSaved(result.user);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = '重置密码';
    }
  });
}

export async function renderAdmin(root, { state }) {
  clear(root);
  root.className = 'view page';
  const inner = el('div', { className: 'page-inner' });
  root.append(inner);

  const usersHost = el('div', { className: 'table-wrap' });
  const usersSection = el('div', { className: 'settings-section' });
  const usersCount = el('span', { className: 'badge', text: '—' });
  const createBtn = el('button', { className: 'btn btn-primary' }, icon('plus'), '新建用户');
  usersSection.append(
    el('h3', null, el('span', { text: '用户与权限' }), usersCount, el('span', { className: 'line' }), createBtn),
    el('p', { className: 'desc', text: '系统角色决定是否能进入管理控制台；项目角色在项目设置中分配。停用账号会立即吊销其会话。' }),
    usersHost
  );

  const searchInput = el('input', {
    className: 'input',
    placeholder: '搜索用户名或显示名称…',
    attrs: { 'aria-label': '搜索用户' },
    style: { maxWidth: '300px' },
  });
  const statusSelect = el('select', { className: 'select', attrs: { 'aria-label': '按状态筛选' }, style: { maxWidth: '140px' } });
  for (const value of ['', 'active', 'disabled']) {
    statusSelect.append(el('option', { value, text: value ? STATUS_LABEL[value] : '全部状态', selected: value === '' }));
  }
  const refreshUsers = el('button', { className: 'btn btn-sm', type: 'button' }, icon('loop'), '刷新');
  usersSection.insertBefore(
    el('div', { className: 'toolbar', style: { marginTop: '10px' } }, searchInput, statusSelect, el('div', { className: 'toolbar-spacer' }), refreshUsers),
    usersHost
  );

  const auditHost = el('div');
  const auditSection = el('div', { className: 'settings-section' });
  const auditCountBadge = el('span', { className: 'badge', text: '—' });
  const actionSelect = el('select', { className: 'select', attrs: { 'aria-label': '按操作筛选' }, style: { maxWidth: '170px' } });
  for (const [value, label] of AUDIT_ACTIONS) actionSelect.append(el('option', { value, text: label }));
  const actorInput = el('input', {
    className: 'input',
    placeholder: '操作者用户名',
    attrs: { 'aria-label': '按操作者筛选' },
    style: { maxWidth: '190px' },
  });
  const refreshAudit = el('button', { className: 'btn btn-sm', type: 'button' }, icon('loop'), '刷新');
  auditSection.append(
    el('h3', null, el('span', { text: '系统审计' }), auditCountBadge, el('span', { className: 'line' })),
    el('p', { className: 'desc', text: '记录登录、权限变更、数据修改、复核与导出。最多显示最近 300 条，可按操作与操作者过滤。' }),
    el('div', { className: 'toolbar', style: { marginBottom: '10px' } }, actionSelect, actorInput, refreshAudit),
    auditHost
  );

  const head = el(
    'div',
    { className: 'page-head' },
    el(
      'div',
      null,
      el('div', { className: 'eyebrow accent', text: 'SYSTEM / ACCESS CONTROL' }),
      el('h1', { text: '系统管理' }),
      el('p', { className: 'sub', text: '账号、系统角色与全局审计日志。' })
    ),
    el(
      'div',
      { className: 'page-actions' },
      el('button', { className: 'btn', type: 'button', onClick: () => { location.hash = '#/projects'; } }, '返回项目')
    )
  );
  const statHost = el('div', { className: 'stat-strip' });
  inner.append(head, statHost, usersSection, auditSection);

  let allUsers = [];
  let auditEntries = [];
  let usersToken = 0;
  let auditToken = 0;
  let auditLoading = false;

  function renderStats() {
    clear(statHost);
    const active = allUsers.filter((user) => user.status === 'active').length;
    const admins = allUsers.filter((user) => user.role === 'admin' && user.status === 'active').length;
    statHost.append(
      statCard('账号总数', allUsers.length),
      statCard('启用账号', active),
      statCard('系统管理员', admins),
      statCard('审计事件', auditLoading ? '…' : auditEntries.length)
    );
  }

  function visibleUsers() {
    const q = searchInput.value.trim().toLowerCase();
    const status = statusSelect.value;
    return allUsers.filter((user) => {
      if (status && user.status !== status) return false;
      if (q && !`${user.username} ${user.displayName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderUsers() {
    clear(usersHost);
    usersCount.textContent = String(allUsers.length);
    const table = el(
      'table',
      { className: 'table' },
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          el('th', { text: '用户' }),
          el('th', { text: '系统角色' }),
          el('th', { text: '状态' }),
          el('th', { text: '最近登录' }),
          el('th', { text: '创建时间' }),
          el('th', { style: { textAlign: 'right' }, text: '操作' })
        )
      )
    );
    const tbody = el('tbody');
    const rows = visibleUsers();
    if (!rows.length) {
      tbody.append(
        el('tr', null, el('td', { colspan: '6', style: { padding: '28px', textAlign: 'center', color: 'var(--dim)' }, text: allUsers.length ? '没有匹配的用户' : '还没有用户' }))
      );
    }
    for (const user of rows) {
      const self = user.id === state.user.id;
      const actions = el('div', { className: 'actions' });
      actions.append(
        el('button', {
          className: 'btn btn-ghost btn-sm',
          type: 'button',
          text: '编辑',
          onClick: () => userModal({ user, onSaved: (fresh) => replaceUser(fresh) }),
        })
      );
      const reset = el('button', {
        className: 'btn btn-ghost btn-sm',
        type: 'button',
        text: '重置密码',
        disabled: self,
        title: self ? '请在右上角账号设置中修改自己的密码' : '重置密码并吊销会话',
        onClick: () => passwordModal(user, (fresh) => replaceUser(fresh)),
      });
      actions.append(reset);
      const active = user.status === 'active';
      const toggle = el('button', {
        className: `btn btn-ghost btn-sm${active ? ' btn-danger' : ''}`,
        type: 'button',
        text: active ? '停用' : '启用',
        disabled: self,
        title: self ? '不能停用当前登录的账号' : active ? '停用并吊销会话' : '恢复登录',
        onClick: async () => {
          if (active) {
            const ok = await confirmDialog({
              title: '停用账号',
              message: `「${user.displayName}」将立即退出登录并无法再次登录，其项目成员身份与历史记录保留。`,
              confirmText: '停用账号',
              danger: true,
            });
            if (!ok) return;
          }
          toggle.disabled = true;
          try {
            const result = await api.updateUser(user.id, { status: active ? 'disabled' : 'active' });
            replaceUser(result.user);
            toast(active ? '账号已停用' : '账号已启用', 'ok');
          } catch (err) {
            toggle.disabled = false;
            toast(err.message, 'error', 6000);
          }
        },
      });
      actions.append(toggle);
      tbody.append(
        el(
          'tr',
          null,
          el(
            'td',
            null,
            el(
              'div',
              { className: 'inline', style: { gap: '8px' } },
              el('span', { className: 'avatar', text: initials(user.displayName) }),
              el(
                'span',
                { className: 'member-name' },
                el('b', { text: user.displayName }),
                el('span', { text: user.username })
              )
            )
          ),
          el(
            'td',
            null,
            el('span', { className: `badge${user.role === 'admin' ? ' badge-accent' : ''}`, text: SYSTEM_ROLE_LABEL[user.role] || user.role })
          ),
          el(
            'td',
            null,
            el(
              'span',
              { className: 'inline', style: { gap: '5px' } },
              el('i', { className: 'status-dot', style: { background: active ? 'var(--ok)' : 'var(--dim)' } }),
              STATUS_LABEL[user.status] || user.status
            )
          ),
          el('td', { text: user.lastLoginAt ? formatDate(user.lastLoginAt) : '从未登录' }),
          el('td', { text: formatDate(user.createdAt, false) }),
          el('td', null, actions)
        )
      );
    }
    table.append(tbody);
    usersHost.append(table);
  }

  function replaceUser(fresh) {
    const index = allUsers.findIndex((user) => user.id === fresh.id);
    if (index >= 0) allUsers[index] = fresh;
    else allUsers.push(fresh);
    renderUsers();
    renderStats();
    loadAudit();
  }

  async function loadUsers() {
    const token = ++usersToken;
    clear(usersHost);
    const skeleton = el('div', { style: { padding: '14px' } });
    for (let i = 0; i < 5; i++) {
      skeleton.append(el('div', { className: 'skeleton', style: { height: '30px', marginBottom: '6px' } }));
    }
    usersHost.append(skeleton);
    try {
      const { users } = await api.listUsers();
      if (token !== usersToken) return;
      allUsers = users;
      renderUsers();
      renderStats();
    } catch (err) {
      if (token !== usersToken) return;
      clear(usersHost);
      usersHost.append(el('div', { className: 'empty-state' }, el('h3', { text: '用户加载失败' }), el('p', { text: err.message })));
    }
  }

  function renderAudit() {
    clear(auditHost);
    auditCountBadge.textContent = String(auditEntries.length);
    renderStats();
    if (!auditEntries.length) {
      auditHost.append(
        el(
          'div',
          { className: 'audit-list', style: { padding: '16px' } },
          el('span', { className: 'section-empty', text: auditLoading ? '加载中…' : '没有匹配的审计事件' })
        )
      );
      return;
    }
    const list = el('div', { className: 'audit-list' });
    for (const entry of auditEntries) {
      const detail = describeDetail(entry.detail);
      list.append(
        el(
          'div',
          { className: 'audit-row' },
          el('span', { className: 'time', text: formatDate(entry.createdAt) }),
          el('span', { className: 'who', text: entry.actorName || '系统 / 匿名' }),
          el('span', { className: 'action', text: ACTION_LABEL[entry.action] || entry.action }),
          el('span', {
            className: 'detail',
            title: detail || `${entry.entity}${entry.entityId ? ` · ${entry.entityId}` : ''}`,
            text: detail || `${entry.entity}${entry.entityId ? ` · ${entry.entityId}` : ''}`,
          })
        )
      );
    }
    auditHost.append(list);
  }

  async function loadAudit() {
    const token = ++auditToken;
    auditLoading = true;
    if (!auditEntries.length) renderAudit();
    else renderStats();
    try {
      const { entries } = await api.adminAudit({
        limit: 300,
        action: actionSelect.value,
        actor: actorInput.value.trim(),
      });
      if (token !== auditToken) return;
      auditEntries = entries;
      auditLoading = false;
      renderAudit();
    } catch (err) {
      if (token !== auditToken) return;
      auditLoading = false;
      clear(auditHost);
      auditHost.append(el('div', { className: 'empty-state' }, el('h3', { text: '审计加载失败' }), el('p', { text: err.message })));
      renderStats();
    }
  }

  createBtn.addEventListener('click', () => userModal({ onSaved: (user) => replaceUser(user) }));
  refreshUsers.addEventListener('click', loadUsers);
  searchInput.addEventListener('input', renderUsers);
  statusSelect.addEventListener('change', renderUsers);
  refreshAudit.addEventListener('click', loadAudit);
  actionSelect.addEventListener('change', loadAudit);
  actorInput.addEventListener('input', debounce(loadAudit, 320));

  await Promise.all([loadUsers(), loadAudit()]);
}
