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
  ROLE_LABEL,
  toast,
} from '../ui.js';

const MEMBER_ROLES = ['manager', 'reviewer', 'annotator'];
const ROLE_ORDER = { manager: 0, reviewer: 1, annotator: 2 };
const PALETTE = ['#f5a524', '#4cc9f0', '#48c78e', '#ef5b5b', '#c084fc', '#f472b6', '#94a3b8', '#fbbf24'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const KEY_RE = /^[1-9a-zA-Z]$/;

const AUDIT_LABEL = {
  'auth.login': '登录',
  'auth.login_failed': '登录失败',
  'auth.logout': '退出登录',
  'auth.password': '修改密码',
  'user.create': '创建用户',
  'user.update': '更新用户',
  'project.create': '创建项目',
  'project.update': '更新项目',
  'project.delete': '删除项目',
  'member.add': '添加成员',
  'member.update': '调整成员角色',
  'member.remove': '移除成员',
  'item.upload': '上传条目',
  'item.assign': '指派条目',
  'item.status': '更新条目状态',
  'item.meta': '更新条目元数据',
  'item.delete': '删除条目',
  'annotation.save': '保存标注',
  'annotation.submit': '提交标注',
  'review.approve': '复核通过',
  'review.reject': '复核驳回',
  'export.download': '导出数据集',
};

function cloneSchema(schema) {
  const source = schema || {};
  return {
    labels: (source.labels || []).map((label) => ({ ...label })),
    documentLabels: (source.documentLabels || []).map((label) => ({ ...label })),
  };
}

function makeId(prefix, taken) {
  let id;
  do {
    id = `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  } while (taken.has(id) || !ID_RE.test(id));
  taken.add(id);
  return id;
}

function section(title, description, ...children) {
  return el(
    'div',
    { className: 'settings-section' },
    el('h3', null, el('span', { text: title }), el('span', { className: 'line' })),
    description ? el('p', { className: 'desc', text: description }) : null,
    ...children
  );
}

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

export function openProjectSettings({
  project,
  members = [],
  onProjectUpdate = () => {},
  onMembersChange = () => {},
  onDeleted = () => {},
  onClose = () => {},
}) {
  let currentProject = { ...project };
  let localMembers = members.map((member) => ({ ...member }));
  let schema = cloneSchema(project.labelSchema);
  let deleting = false;

  const error = el('div', { className: 'form-error', hidden: true });
  const body = el('div', null, error);

  const nameInput = el('input', {
    className: 'input',
    value: currentProject.name,
    attrs: { maxlength: '80', autocomplete: 'off' },
  });
  const descInput = el('textarea', {
    className: 'textarea',
    rows: 3,
    value: currentProject.description || '',
    attrs: { maxlength: '2000' },
    style: { resize: 'vertical', minHeight: '64px', height: 'auto' },
  });
  const archivedToggle = el('input', { type: 'checkbox', checked: currentProject.archived });
  const saveBasic = el('button', { className: 'btn btn-primary', type: 'button', text: '保存基本信息' });

  const basic = section(
    '基本信息',
    '项目名称与描述会在列表和导出元数据中展示。归档后数据集只读，已有标注仍可导出。',
    field('项目名称', nameInput),
    field('描述', descInput),
    el(
      'label',
      { className: 'checkbox', style: { marginTop: '10px' } },
      archivedToggle,
      '归档项目（只读）'
    ),
    el('div', { className: 'inline', style: { marginTop: '12px' } }, saveBasic)
  );
  body.append(basic);

  saveBasic.addEventListener('click', async () => {
    error.hidden = true;
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = '项目名称不能为空';
      error.hidden = false;
      nameInput.focus();
      return;
    }
    const archived = archivedToggle.checked;
    if (archived !== Boolean(currentProject.archived)) {
      if (archived) {
        const ok = await confirmDialog({
          title: '归档项目',
          message: '归档后项目进入只读状态：无法上传、标注、提交或复核，但可以导出和查看。',
          confirmText: '归档',
        });
        if (!ok) {
          archivedToggle.checked = currentProject.archived;
          return;
        }
      }
    }
    saveBasic.disabled = true;
    saveBasic.textContent = '保存中…';
    try {
      const payload = { name, description: descInput.value.trim() };
      if (archived !== Boolean(currentProject.archived)) payload.archived = archived;
      const result = await api.updateProject(currentProject.id, payload);
      currentProject = { ...currentProject, ...result.project };
      const meta = modal.modal.querySelector('.modal-head p');
      if (meta) meta.textContent = `${currentProject.name} · ${ROLE_LABEL[project.role] || project.role}`;
      onProjectUpdate(result.project, null);
      toast('项目信息已更新', 'ok');
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      saveBasic.disabled = false;
      saveBasic.textContent = '保存基本信息';
    }
  });

  const labelsHost = el('div', { className: 'label-editor' });
  const docLabelsHost = el('div', { className: 'label-editor' });
  const saveLabels = el('button', { className: 'btn btn-primary btn-sm', type: 'button', text: '保存标签' });
  const addLabel = el('button', { className: 'btn btn-sm', type: 'button' }, icon('plus'), '添加标签');
  const addDocLabel = el('button', { className: 'btn btn-sm', type: 'button' }, icon('plus'), '添加文档标签');

  function takenIds() {
    return new Set([...schema.labels, ...schema.documentLabels].map((label) => label.id));
  }

  function labelRow(label, list, type) {
    const swatch = el('i', { className: 'swatch', style: { background: label.color, width: '12px', height: '12px' } });
    const name = el('input', {
      className: 'input',
      value: label.name,
      placeholder: '标签名称',
      attrs: { maxlength: '40', autocomplete: 'off' },
    });
    name.addEventListener('input', () => {
      label.name = name.value;
    });
    const color = el('input', { type: 'color', value: label.color, attrs: { 'aria-label': '标签颜色' } });
    color.addEventListener('input', () => {
      label.color = color.value;
      swatch.style.background = color.value;
    });
    let keyNode;
    if (type === 'label') {
      keyNode = el('input', {
        className: 'input key-input',
        value: label.hotkey || '',
        placeholder: '键',
        title: '单键快捷键：1-9 或字母',
        attrs: { maxlength: '1', autocomplete: 'off' },
      });
      keyNode.addEventListener('input', () => {
        keyNode.value = keyNode.value.slice(-1).toLowerCase();
        label.hotkey = keyNode.value;
      });
    } else {
      keyNode = el('span', { className: 'dim', style: { textAlign: 'center', fontSize: '10px' }, text: '—' });
    }
    const remove = el(
      'button',
      {
        className: 'btn btn-ghost btn-icon',
        type: 'button',
        title: '移除标签',
        onClick: () => {
          const index = list.indexOf(label);
          if (index >= 0) list.splice(index, 1);
          renderLabels();
        },
      },
      icon('trash')
    );
    return el('div', { className: 'label-editor-row' }, swatch, name, color, keyNode, remove);
  }

  function renderLabels() {
    clear(labelsHost);
    clear(docLabelsHost);
    if (!schema.labels.length) {
      labelsHost.append(el('p', { className: 'section-empty', text: '至少需要一个标签。' }));
    }
    for (const label of schema.labels) labelsHost.append(labelRow(label, schema.labels, 'label'));
    if (currentProject.kind === 'text') {
      if (!schema.documentLabels.length) {
        docLabelsHost.append(el('p', { className: 'section-empty', text: '文档标签可整体标记一篇文本，例如“含敏感信息”。' }));
      }
      for (const label of schema.documentLabels) {
        docLabelsHost.append(labelRow(label, schema.documentLabels, 'document'));
      }
    }
  }

  addLabel.addEventListener('click', () => {
    const ids = takenIds();
    schema.labels.push({
      id: makeId('lb', ids),
      name: '',
      color: PALETTE[schema.labels.length % PALETTE.length],
    });
    renderLabels();
    labelsHost.lastElementChild?.querySelector('input.input')?.focus();
  });

  addDocLabel.addEventListener('click', () => {
    const ids = takenIds();
    schema.documentLabels.push({
      id: makeId('dl', ids),
      name: '',
      color: PALETTE[(schema.labels.length + schema.documentLabels.length) % PALETTE.length],
    });
    renderLabels();
    docLabelsHost.lastElementChild?.querySelector('input.input')?.focus();
  });

  saveLabels.addEventListener('click', async () => {
    error.hidden = true;
    if (!schema.labels.length) {
      error.textContent = '至少需要一个标签';
      error.hidden = false;
      return;
    }
    const names = new Set();
    const keys = new Set();
    for (const label of schema.labels) {
      const name = String(label.name || '').trim();
      if (!name) {
        error.textContent = '标签名称不能为空';
        error.hidden = false;
        return;
      }
      const key = name.toLowerCase();
      if (names.has(key)) {
        error.textContent = `标签名称重复：${name}`;
        error.hidden = false;
        return;
      }
      names.add(key);
      label.name = name;
      const hotkey = String(label.hotkey || '').trim();
      if (hotkey) {
        if (!KEY_RE.test(hotkey)) {
          error.textContent = `快捷键必须是单个 1-9 或字母：${name}`;
          error.hidden = false;
          return;
        }
        if (keys.has(hotkey)) {
          error.textContent = `快捷键重复：${hotkey}`;
          error.hidden = false;
          return;
        }
        keys.add(hotkey);
        label.hotkey = hotkey;
      } else {
        delete label.hotkey;
      }
    }
    const docNames = new Set();
    for (const label of schema.documentLabels) {
      const name = String(label.name || '').trim();
      if (!name) {
        error.textContent = '文档标签名称不能为空';
        error.hidden = false;
        return;
      }
      const key = name.toLowerCase();
      if (docNames.has(key)) {
        error.textContent = `文档标签名称重复：${name}`;
        error.hidden = false;
        return;
      }
      docNames.add(key);
      label.name = name;
      delete label.hotkey;
    }
    saveLabels.disabled = true;
    saveLabels.textContent = '保存中…';
    try {
      const payload = currentProject.kind === 'text'
        ? schema
        : { labels: schema.labels, documentLabels: schema.documentLabels || [] };
      const result = await api.updateProject(currentProject.id, { labelSchema: payload });
      currentProject = { ...currentProject, ...result.project };
      schema = cloneSchema(result.project.labelSchema);
      renderLabels();
      onProjectUpdate(result.project, null);
      toast('标签已保存', 'ok');
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      saveLabels.disabled = false;
      saveLabels.textContent = '保存标签';
    }
  });

  const labelsSection = section(
    '标签体系',
    '标注器使用标签颜色渲染图元。快捷键在画布中生效；删除仍被已有标注引用的标签会被服务端拒绝。',
    labelsHost
  );
  labelsSection.querySelector('h3').append(saveLabels);
  if (currentProject.kind === 'text') {
    labelsSection.append(
      el('div', { className: 'eyebrow', style: { margin: '14px 0 7px' }, text: '文档标签' }),
      docLabelsHost
    );
  }
  const addRow = el('div', { className: 'inline', style: { marginTop: '10px', flexWrap: 'wrap' } }, addLabel);
  if (currentProject.kind === 'text') addRow.append(addDocLabel);
  labelsSection.append(addRow);
  body.append(labelsSection);

  const membersHost = el('div', { className: 'member-list' });
  const memberCount = el('span', { className: 'badge', text: String(localMembers.length) });
  const membersSection = section(
    '项目成员',
    '管理员可查看全部项目；成员按项目角色获得查看、标注、复核或管理权限。',
    membersHost
  );
  membersSection.querySelector('h3').append(memberCount);

  function normalizeMembers() {
    localMembers.sort((a, b) => {
      const role = (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9);
      if (role) return role;
      return String(a.username).localeCompare(String(b.username));
    });
  }

  function renderMembers() {
    normalizeMembers();
    clear(membersHost);
    memberCount.textContent = String(localMembers.length);
    if (!localMembers.length) {
      membersHost.append(el('p', { className: 'section-empty', text: '项目还没有成员。从下方搜索用户并加入。' }));
      return;
    }
    for (const member of localMembers) {
      const roleSelect = el('select', { className: 'select', attrs: { 'aria-label': `${member.displayName} 的角色` } });
      for (const role of MEMBER_ROLES) {
        roleSelect.append(el('option', { value: role, text: ROLE_LABEL[role], selected: member.role === role }));
      }
      roleSelect.addEventListener('change', async () => {
        const nextRole = roleSelect.value;
        roleSelect.disabled = true;
        try {
          const result = await api.updateMember(currentProject.id, member.userId, nextRole);
          Object.assign(member, result.member);
          renderMembers();
          onMembersChange(localMembers);
          toast(`已将 ${member.displayName} 设为${ROLE_LABEL[nextRole]}`, 'ok');
        } catch (err) {
          roleSelect.value = member.role;
          roleSelect.disabled = false;
          toast(err.message, 'error', 6000);
        }
      });
      const remove = el(
        'button',
        {
          className: 'btn btn-ghost btn-icon',
          type: 'button',
          title: '移出项目',
          onClick: async () => {
            const ok = await confirmDialog({
              title: '移出项目成员',
              message: `「${member.displayName}」将失去该项目的数据访问权限，其历史标注保留。`,
              confirmText: '移出',
              danger: true,
            });
            if (!ok) return;
            try {
              await api.removeMember(currentProject.id, member.userId);
              localMembers = localMembers.filter((entry) => entry.userId !== member.userId);
              renderMembers();
              onMembersChange(localMembers);
              toast('成员已移出项目', 'ok');
            } catch (err) {
              toast(err.message, 'error', 6000);
            }
          },
        },
        icon('trash')
      );
      membersHost.append(
        el(
          'div',
          { className: 'member-row' },
          el('span', { className: 'avatar', text: initials(member.displayName) }),
          el(
            'span',
            { className: 'member-name' },
            el('b', { text: member.displayName }),
            el('span', { text: member.username })
          ),
          roleSelect,
          remove
        )
      );
    }
  }
  renderMembers();

  const directoryResults = el('div', { className: 'directory-results', hidden: true });
  const memberSearch = el('input', {
    className: 'input',
    placeholder: '搜索用户名或姓名…',
    attrs: { autocomplete: 'off' },
  });
  const newRole = el('select', { className: 'select', attrs: { 'aria-label': '新成员角色' }, style: { height: '30px', fontSize: '11px', flex: '0 0 116px' } });
  for (const role of MEMBER_ROLES) {
    newRole.append(el('option', { value: role, text: ROLE_LABEL[role], selected: role === 'annotator' }));
  }
  const memberAdd = el(
    'div',
    { className: 'member-add' },
    el('div', { className: 'search' }, icon('search'), memberSearch, directoryResults),
    newRole
  );
  membersSection.append(
    memberAdd,
    el('p', { className: 'field-hint', text: '搜索并点击用户，以所选角色加入项目。', style: { marginTop: '6px' } })
  );
  body.append(membersSection);

  let dirToken = 0;
  let addingMember = false;

  async function searchDirectory() {
    const q = memberSearch.value.trim();
    const token = ++dirToken;
    directoryResults.hidden = false;
    clear(directoryResults);
    directoryResults.append(el('div', { className: 'empty', text: '搜索中…' }));
    try {
      const { users } = await api.directory(q);
      if (token !== dirToken) return;
      clear(directoryResults);
      const existing = new Set(localMembers.map((member) => member.userId));
      const candidates = users.filter((user) => !existing.has(user.id));
      if (!candidates.length) {
        directoryResults.append(el('div', { className: 'empty', text: q ? '没有可添加的用户' : '输入关键词搜索用户' }));
        return;
      }
      for (const user of candidates) {
        directoryResults.append(
          el(
            'button',
            {
              type: 'button',
              onClick: async () => {
                if (addingMember) return;
                addingMember = true;
                try {
                  const result = await api.addMember(currentProject.id, user.id, newRole.value);
                  localMembers.push(result.member);
                  renderMembers();
                  onMembersChange(localMembers);
                  memberSearch.value = '';
                  directoryResults.hidden = true;
                  toast(`${user.displayName} 已加入项目`, 'ok');
                } catch (err) {
                  toast(err.message, 'error', 6000);
                } finally {
                  addingMember = false;
                }
              },
            },
            el('span', { className: 'avatar', text: initials(user.displayName) }),
            el('b', { text: user.displayName }),
            el('span', { className: 'dim', text: user.username })
          )
        );
      }
    } catch (err) {
      if (token !== dirToken) return;
      clear(directoryResults);
      directoryResults.append(el('div', { className: 'empty', text: err.message }));
    }
  }

  const directorySearch = debounce(searchDirectory, 240);
  memberSearch.addEventListener('input', directorySearch);
  memberSearch.addEventListener('focus', searchDirectory);

  const auditHost = el('div');
  const auditDetails = el(
    'details',
    { className: 'disclosure' },
    el('summary', null, el('span', { text: '最近操作日志' }), el('span', { text: '⌄' })),
    el('div', { className: 'disclosure-body' }, auditHost)
  );
  let auditLoaded = false;
  auditDetails.addEventListener('toggle', async () => {
    if (!auditDetails.open || auditLoaded) return;
    auditLoaded = true;
    auditHost.append(el('p', { className: 'section-empty', text: '加载中…' }));
    try {
      const { entries } = await api.projectAudit(currentProject.id, 60);
      clear(auditHost);
      if (!entries.length) {
        auditHost.append(el('p', { className: 'section-empty', text: '暂无操作记录。' }));
        return;
      }
      const list = el('div', { className: 'audit-list' });
      for (const entry of entries) {
        list.append(
          el(
            'div',
            { className: 'audit-row' },
            el('span', { className: 'time', text: formatDate(entry.createdAt) }),
            el('span', { className: 'who', text: entry.actorName || '系统' }),
            el('span', { className: 'action', text: AUDIT_LABEL[entry.action] || entry.action }),
            el('span', { className: 'detail', title: describeDetail(entry.detail), text: describeDetail(entry.detail) || entry.entity })
          )
        );
      }
      auditHost.append(list);
    } catch (err) {
      clear(auditHost);
      auditHost.append(el('p', { className: 'section-empty', text: err.message }));
    }
  });
  body.append(auditDetails);

  const deleteBtn = el('button', { className: 'btn btn-danger', type: 'button' }, icon('trash'), '删除项目');
  body.append(
    el(
      'div',
      { className: 'settings-section danger-zone' },
      el('h3', null, el('span', { text: '危险操作' }), el('span', { className: 'line' })),
      el('p', { className: 'desc', text: '删除项目会永久移除全部条目、标注、复核记录和原始文件，无法恢复。' }),
      deleteBtn
    )
  );

  deleteBtn.addEventListener('click', async () => {
    if (deleting) return;
    const ok = await confirmDialog({
      title: '删除项目',
      message: `项目「${currentProject.name}」的全部数据将被永久删除，包括原始文件。`,
      confirmText: '永久删除',
      danger: true,
      requireText: currentProject.name,
    });
    if (!ok) return;
    deleting = true;
    deleteBtn.disabled = true;
    deleteBtn.textContent = '删除中…';
    try {
      await api.deleteProject(currentProject.id, currentProject.name);
      modal.close();
      toast('项目已删除', 'ok');
      onDeleted();
    } catch (err) {
      deleting = false;
      deleteBtn.disabled = false;
      clear(deleteBtn);
      deleteBtn.append(icon('trash'), '删除项目');
      toast(err.message, 'error', 6000);
    }
  });

  renderLabels();

  const modal = openModal({
    title: '项目设置',
    subtitle: `${currentProject.name} · ${ROLE_LABEL[project.role] || project.role}`,
    body,
    wide: true,
    footer: [el('button', { className: 'btn btn-ghost', type: 'button', text: '关闭', onClick: () => modal.close() })],
    onClose,
  });
  return modal;
}
