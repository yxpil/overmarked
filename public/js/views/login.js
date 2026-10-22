import { api } from '../api.js';
import { clear, el, field, icon, toast } from '../ui.js';

const MODALITIES = [
  { icon: 'image', num: '01', label: '图片' },
  { icon: 'text', num: '02', label: '文本' },
  { icon: 'audio', num: '03', label: '音频' },
  { icon: 'map', num: '04', label: '空间' },
];

export function renderLogin(root, { onSuccess }) {
  clear(root);
  root.className = 'view';
  const error = el('div', { className: 'form-error login-error', hidden: true });
  const username = el('input', {
    className: 'input',
    name: 'username',
    attrs: { autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' },
    placeholder: '用户名',
  });
  const password = el('input', {
    className: 'input',
    name: 'password',
    type: 'password',
    attrs: { autocomplete: 'current-password' },
    placeholder: '密码',
  });
  const submit = el('button', { className: 'btn btn-primary btn-block', type: 'submit', text: '登录' });
  const form = el(
    'form',
    { className: 'login-form', attrs: { novalidate: 'true' } },
    el('div', { className: 'eyebrow accent', text: 'SIGN IN / 登录' }),
    el('h2', { text: '进入工作台' }),
    el('p', { className: 'lede', text: '使用本地账号登录。所有数据保存在这台机器的 data 目录。' }),
    error,
    field('用户名', username),
    field('密码', password),
    submit,
    el('p', {
      className: 'login-note',
      text: '首次启动时，管理员密码写入 data/initial-admin.txt。登录后请在右上角账号设置中修改密码。',
    })
  );

  const brand = el(
    'section',
    { className: 'login-brand' },
    el(
      'div',
      { className: 'login-top' },
      el('span', { className: 'brand-mark' }, el('i'), el('i'), el('i'), el('i')),
      el('span', { className: 'brand-word', text: 'OVERMARKED' }),
      el('span', { className: 'brand-ver', text: 'v1.0' })
    ),
    el(
      'div',
      { className: 'login-body' },
      el('div', { className: 'eyebrow accent', text: 'ANNOTATION WORKBENCH / LOCAL-FIRST' }),
      el('h1', { className: 'login-title' }, 'OVER', el('br'), el('span', { className: 'outline', text: 'MARKED' })),
      el(
        'p',
        { className: 'login-sub' },
        '图片、文本、音频与空间数据集的',
        el('b', { text: '标注、复核与导出' }),
        '，运行在你自己的机器上。'
      ),
      el(
        'div',
        { className: 'modality-grid' },
        MODALITIES.map((item) =>
          el(
            'div',
            { className: 'modality' },
            icon(item.icon),
            el('span', { text: item.num }),
            el('b', { text: item.label })
          )
        )
      )
    ),
    el(
      'div',
      { className: 'login-foot' },
      el('span', { text: 'SQLITE / LOCAL STORAGE / RBAC' }),
      el('span', { text: 'NO CLOUD REQUIRED' })
    )
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (!username.value.trim() || !password.value) {
      error.textContent = '请输入用户名和密码';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = '正在验证…';
    try {
      const { user } = await api.login(username.value.trim(), password.value);
      toast(`欢迎回来，${user.displayName}`, 'ok');
      await onSuccess(user);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = '登录';
      password.focus();
      password.select();
    }
  });

  root.append(el('div', { className: 'login-shell' }, brand, el('section', { className: 'login-pane' }, form)));
  requestAnimationFrame(() => username.focus());
}
