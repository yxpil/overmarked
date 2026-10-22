const BASE = '/api';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || '请求失败');
    this.status = status;
    this.code = code || 'UNKNOWN';
    this.details = details;
  }
}

async function parseResponse(res) {
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  const text = await res.text();
  return text ? { error: { message: text } } : null;
}

async function request(method, path, body) {
  const headers = {};
  const options = { method, credentials: 'same-origin', headers };
  if (method !== 'GET' && method !== 'HEAD') headers['X-OM-Request'] = '1';
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(BASE + path, options);
  } catch {
    throw new ApiError(0, 'NETWORK', '网络连接失败，请检查服务是否运行');
  }
  const payload = await parseResponse(res);
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') {
      window.dispatchEvent(new CustomEvent('om:unauthorized'));
    }
    throw new ApiError(
      res.status,
      payload?.error?.code,
      payload?.error?.message || `请求失败 (${res.status})`,
      payload?.error?.details
    );
  }
  return payload;
}

function uploadItem(projectId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${BASE}/projects/${encodeURIComponent(projectId)}/items?filename=${encodeURIComponent(file.name)}`;
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-OM-Request', '1');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      let payload = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
      } else {
        if (xhr.status === 401) window.dispatchEvent(new CustomEvent('om:unauthorized'));
        reject(
          new ApiError(
            xhr.status,
            payload?.error?.code,
            payload?.error?.message || `上传失败 (${xhr.status})`,
            payload?.error?.details
          )
        );
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', '上传失败：网络错误'));
    xhr.ontimeout = () => reject(new ApiError(0, 'TIMEOUT', '上传超时'));
    xhr.send(file);
  });
}

async function fetchBlob(itemId) {
  const res = await fetch(`${BASE}/items/${encodeURIComponent(itemId)}/file`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let message = `文件加载失败 (${res.status})`;
    try {
      const data = await res.json();
      message = data?.error?.message || message;
    } catch {
      /* ignore */
    }
    if (res.status === 401) window.dispatchEvent(new CustomEvent('om:unauthorized'));
    throw new ApiError(res.status, 'FILE', message);
  }
  return res.blob();
}

async function fetchText(itemId) {
  const res = await fetch(`${BASE}/items/${encodeURIComponent(itemId)}/file`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    throw new ApiError(res.status, 'FILE', `文件加载失败 (${res.status})`);
  }
  return res.text();
}

export const api = {
  request,
  login: (username, password) => request('POST', '/auth/login', { username, password }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/auth/password', { currentPassword, newPassword }),

  listProjects: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') qs.set(key, value);
    const suffix = qs.toString() ? `?${qs}` : '';
    return request('GET', `/projects${suffix}`);
  },
  createProject: (body) => request('POST', '/projects', body),
  getProject: (id) => request('GET', `/projects/${encodeURIComponent(id)}`),
  updateProject: (id, body) => request('PATCH', `/projects/${encodeURIComponent(id)}`, body),
  deleteProject: (id, confirmName) =>
    request('DELETE', `/projects/${encodeURIComponent(id)}`, { confirmName }),
  listMembers: (id) => request('GET', `/projects/${encodeURIComponent(id)}/members`),
  addMember: (id, userId, role) =>
    request('POST', `/projects/${encodeURIComponent(id)}/members`, { userId, role }),
  updateMember: (id, userId, role) =>
    request('PATCH', `/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { role }),
  removeMember: (id, userId) =>
    request('DELETE', `/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`),
  listItems: (projectId, params = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') qs.set(key, value);
    const suffix = qs.toString() ? `?${qs}` : '';
    return request('GET', `/projects/${encodeURIComponent(projectId)}/items${suffix}`);
  },
  uploadItem,
  getItem: (id) => request('GET', `/items/${encodeURIComponent(id)}`),
  updateItem: (id, body) => request('PATCH', `/items/${encodeURIComponent(id)}`, body),
  deleteItem: (id) => request('DELETE', `/items/${encodeURIComponent(id)}`),
  saveAnnotation: (id, data, submit) =>
    request('PUT', `/items/${encodeURIComponent(id)}/annotation`, { data, submit }),
  history: (id) => request('GET', `/items/${encodeURIComponent(id)}/history`),
  review: (id, decision, note) =>
    request('POST', `/items/${encodeURIComponent(id)}/review`, { decision, note }),
  stats: (id) => request('GET', `/projects/${encodeURIComponent(id)}/stats`),
  projectAudit: (id, limit = 100) =>
    request('GET', `/projects/${encodeURIComponent(id)}/audit?limit=${limit}`),
  directory: (q = '') => request('GET', `/directory?q=${encodeURIComponent(q)}`),

  listUsers: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') qs.set(key, value);
    const suffix = qs.toString() ? `?${qs}` : '';
    return request('GET', `/users${suffix}`);
  },
  createUser: (body) => request('POST', '/users', body),
  updateUser: (id, body) => request('PATCH', `/users/${encodeURIComponent(id)}`, body),
  adminAudit: (params = {}) => {
    const qs = new URLSearchParams();
    const { limit = 120, action = '', actor = '' } = typeof params === 'number' ? { limit: params } : params;
    qs.set('limit', String(limit));
    if (action) qs.set('action', action);
    if (actor) qs.set('actor', actor);
    return request('GET', `/admin/audit?${qs}`);
  },

  fetchBlob,
  fetchText,
  fileUrl: (id) => `${BASE}/items/${encodeURIComponent(id)}/file`,
  exportUrl: (projectId, format, scope) => {
    const qs = new URLSearchParams({ format, scope });
    return `${BASE}/projects/${encodeURIComponent(projectId)}/export?${qs}`;
  },
};

export function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
