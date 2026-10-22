import { api } from '../api.js';
import {
  clear,
  el,
  emptyState,
  field,
  formatDate,
  icon,
  KIND_ICON,
  KIND_LABEL,
  openModal,
  ROLE_LABEL,
  STATUS_LABEL,
  toast,
} from '../ui.js';

const COLORS = ['#f5a524', '#4cc9f0', '#48c78e', '#ef5b5b', '#c084fc', '#f472b6', '#94a3b8', '#fbbf24'];
const KINDS = ['image', 'text', 'audio', 'spatial'];
const KIND_HINT = {
  image: 'JPG / PNG / WebP / GIF，矩形框与多边形标注',
  text: 'TXT / MD / CSV / JSONL，实体区间与文档标签',
  audio: 'WAV / MP3 / OGG / M4A / FLAC，波形区段标注',
  spatial: 'GeoJSON 或已配准栅格，点 / 线 / 面矢量标注',
};

function countChips(counts) {
  const entries = [
    ['pending', counts.pending],
    ['submitted', counts.submitted],
    ['approved', counts.approved],
    ['rejected', counts.rejected],
  ];
  return el(
    'div',
    { className: 'card-counts' },
    entries.map(([status, count]) =>
      el(
        'span',
        null,
        el('i', { className: `status-dot ${status}` }),
        `${STATUS_LABEL[status]} ${count || 0}`
      )
    )
  );
}

function projectCard(project, onOpen) {
  const total = project.counts?.total || 0;
  const approved = project.counts?.approved || 0;
  const pct = total ? Math.round((approved / total) * 100) : 0;
  return el(
    'button',
    {
      className: `project-card${project.archived ? ' archived' : ''}`,
      type: 'button',
      onClick: () => onOpen(project.id),
    },
    el(
      'div',
      { className: 'project-card-head' },
      el('div', { className: 'project-kind-icon' }, icon(KIND_ICON[project.kind] || 'grid')),
      el(
        'div',
        { className: 'inline', style: { flexWrap: 'wrap', justifyContent: 'flex-end', gap: '4px' } },
        project.archived ? el('span', { className: 'badge', text: '已归档' }) : null,
        el('span', { className: 'badge', text: KIND_LABEL[project.kind] || project.kind }),
        el('span', { className: 'badge badge-type', text: ROLE_LABEL[project.role] || project.role })
      )
    ),
    el(
      'div',
      null,
      el('h3', { text: project.name }),
      el('p', { className: 'desc', text: project.description || '暂无描述' })
    ),
    el(
      'div',
      null,
      el(
        'div',
        { className: 'progress-line' },
        el('span', { text: `${approved} / ${total} 已通过` }),
        el('span', { text: `${pct}%` })
      ),
      el('div', { className: 'progress' }, el('i', { style: { width: `${pct}%` } }))
    ),
    el(
      'div',
      { className: 'card-foot' },
      countChips(project.counts || { total: 0 }),
      el('span', { className: 'card-updated', text: formatDate(project.updatedAt, false) })
    )
  );
}

function newProjectModal(onCreated) {
  let kind = 'image';
  const error = el('div', { className: 'form-error', hidden: true });
  const name = el('input', { className: 'input', placeholder: '例如：街景车辆目标检测', attrs: { maxlength: '80' } });
  const description = el('textarea', { className: 'textarea', placeholder: '用途、数据来源、标注约定…', attrs: { maxlength: '2000', rows: '3' } });
  const labelsInput = el('input', { className: 'input', placeholder: '车辆, 行人, 交通标志', attrs: { maxlength: '500' } });
  const hint = el('p', { className: 'field-hint', text: KIND_HINT.image });
  const kindButtons = KINDS.map((k) =>
    el(
      'button',
      {
        className: `btn${k === 'image' ? ' btn-primary' : ''}`,
        type: 'button',
        onClick: (event) => {
          kind = k;
          for (const button of kindButtons) {
            button.classList.toggle('btn-primary', button.dataset.kind === k);
          }
          hint.textContent = KIND_HINT[k];
        },
        dataset: { kind: k },
      },
      icon(KIND_ICON[k]),
      KIND_LABEL[k]
    )
  );
  const submit = el('button', { className: 'btn btn-primary', text: '创建项目' });
  const modal = openModal({
    title: '新建数据集项目',
    subtitle: '选择数据类型；类型创建后不可更改。',
    wide: true,
    body: [
      error,
      el('div', { className: 'field' }, el('label', { text: '数据类型' }), el('div', { className: 'inline', style: { flexWrap: 'wrap', gap: '6px' } }, kindButtons), hint),
      field('项目名称', name, { hint: '1..80 字符' }),
      field('描述（可选）', description),
      field('初始标签（可选，英文逗号分隔）', labelsInput, {
        hint: '留空将按类型生成一个默认标签。颜色和快捷键可在项目设置中调整。',
      }),
    ],
    footer: [
      el('button', { className: 'btn btn-ghost', text: '取消', onClick: () => modal.close() }),
      submit,
    ],
  });
  submit.addEventListener('click', async () => {
    error.hidden = true;
    if (!name.value.trim()) {
      error.textContent = '请输入项目名称';
      error.hidden = false;
      name.focus();
      return;
    }
    const names = labelsInput.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 64);
    const labelSchema = names.length
      ? {
          labels: names.map((label, index) => ({
            id: `lb_${index + 1}`,
            name: label.slice(0, 40),
            color: COLORS[index % COLORS.length],
            ...(index < 9 ? { hotkey: String(index + 1) } : {}),
          })),
          documentLabels: [],
        }
      : undefined;
    submit.disabled = true;
    submit.textContent = '创建中…';
    try {
      const { project } = await api.createProject({
        name: name.value.trim(),
        kind,
        description: description.value.trim(),
        labelSchema,
      });
      modal.close();
      toast(`项目「${project.name}」已创建`, 'ok');
      onCreated(project);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = '创建项目';
    }
  });
}

export async function renderProjects(root, { state, onOpen }) {
  clear(root);
  root.className = 'view page';
  const inner = el('div', { className: 'page-inner' });
  root.append(inner);

  const head = el(
    'div',
    { className: 'page-head' },
    el(
      'div',
      null,
      el('div', { className: 'eyebrow accent', text: 'WORKBENCH / DATASETS' }),
      el('h1', { text: '数据集项目' }),
      el('p', { className: 'sub', text: '标注、复核与导出都发生在项目内。' })
    ),
    el(
      'div',
      { className: 'page-actions' },
      el(
        'button',
        {
          className: 'btn btn-primary',
          onClick: () => newProjectModal((project) => onOpen(project.id)),
        },
        icon('plus'),
        '新建项目'
      )
    )
  );
  const statHost = el('div', { className: 'stat-strip' });
  const toolbar = el('div', { className: 'toolbar' });
  const grid = el('div', { className: 'project-grid' });
  const notice = el('div', { hidden: true });
  inner.append(head, statHost, notice, toolbar, grid);

  for (let i = 0; i < 6; i++) {
    grid.append(el('div', { className: 'skeleton', style: { height: '196px' } }));
  }
  statHost.append(
    ...Array.from({ length: 4 }, () => el('div', { className: 'stat' }, el('span', { className: 'skeleton', style: { width: '60px', height: '10px' } }), el('b', { className: 'skeleton', style: { width: '80px', height: '22px' } })))
  );

  let projects = [];
  let filterKind = 'all';
  let search = '';
  let showArchived = false;

  const seg = el('div', { className: 'seg' });
  const kindOptions = [['all', '全部'], ...KINDS.map((k) => [k, KIND_LABEL[k]])];
  const kindButtons = kindOptions.map(([value, label]) => {
    const button = el('button', {
      className: value === 'all' ? 'active' : '',
      type: 'button',
      text: label,
      onClick: () => {
        filterKind = value;
        for (const b of kindButtons) b.classList.toggle('active', b.dataset.kind === value);
        renderGrid();
      },
      dataset: { kind: value },
    });
    seg.append(button);
    return button;
  });
  const searchInput = el('input', { className: 'input', placeholder: '搜索项目名称…', attrs: { 'aria-label': '搜索项目' } });
  const searchWrap = el('div', { className: 'search' }, icon('search'), searchInput);
  searchInput.addEventListener('input', () => {
    search = searchInput.value.trim().toLowerCase();
    renderGrid();
  });
  const archivedToggle = el('label', { className: 'checkbox' }, el('input', { type: 'checkbox' }), '显示已归档');
  archivedToggle.querySelector('input').addEventListener('change', (event) => {
    showArchived = event.target.checked;
    renderGrid();
  });

  toolbar.append(seg, searchWrap, el('div', { className: 'toolbar-spacer' }), archivedToggle);

  function renderStats() {
    const totalProjects = projects.filter((p) => !p.archived).length;
    const totalItems = projects.reduce((sum, p) => sum + (p.counts?.total || 0), 0);
    const totalApproved = projects.reduce((sum, p) => sum + (p.counts?.approved || 0), 0);
    const pct = totalItems ? Math.round((totalApproved / totalItems) * 1000) / 10 : 0;
    clear(statHost);
    const stats = [
      ['活跃项目', String(totalProjects), '个'],
      ['条目总数', totalItems.toLocaleString('zh-CN'), ''],
      ['已通过', totalApproved.toLocaleString('zh-CN'), ''],
      ['整体通过率', `${pct}`, '%'],
    ];
    for (const [label, value, suffix] of stats) {
      statHost.append(
        el(
          'div',
          { className: 'stat' },
          el('span', { text: label }),
          el('b', null, value, suffix ? el('small', { text: ` ${suffix}` }) : null)
        )
      );
    }
  }

  function renderGrid() {
    clear(grid);
    const visible = projects.filter((project) => {
      if (!showArchived && project.archived) return false;
      if (filterKind !== 'all' && project.kind !== filterKind) return false;
      if (search && !`${project.name} ${project.description || ''}`.toLowerCase().includes(search)) return false;
      return true;
    });
    if (!visible.length) {
      if (!projects.length) {
        grid.append(
          emptyState({
            iconName: 'layers',
            title: '还没有项目',
            description: '创建第一个数据集项目，上传文件后即可开始标注。图片、文本、音频、空间数据各自拥有独立的工作台。',
            action: el('button', { className: 'btn btn-primary', onClick: () => newProjectModal((project) => onOpen(project.id)) }, icon('plus'), '新建项目'),
          })
        );
      } else {
        grid.append(
          emptyState({
            iconName: 'search',
            title: '没有匹配的项目',
            description: '调整类型筛选、搜索关键词，或显示已归档项目。',
          })
        );
      }
      return;
    }
    for (const project of visible) grid.append(projectCard(project, onOpen));
  }

  async function load() {
    try {
      const data = await api.listProjects();
      projects = data.projects || [];
      renderStats();
      renderGrid();
    } catch (err) {
      clear(grid);
      grid.append(
        emptyState({
          iconName: 'alert',
          title: '项目加载失败',
          description: err.message,
          action: el('button', { className: 'btn', text: '重试', onClick: load }),
        })
      );
    }
  }

  await load();
}
