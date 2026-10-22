import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'AdminPass123!';
const USER_PASS = 'Password123!';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

let app;
let base;
let tempDir;

function makeClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async req(method, route, { body, headers = {}, parse = 'json', contentType } = {}) {
      const finalHeaders = { ...headers };
      if (cookie) finalHeaders.Cookie = cookie;
      if (method !== 'GET' && method !== 'HEAD') finalHeaders['X-OM-Request'] = '1';
      let payload;
      if (body !== undefined) {
        if (Buffer.isBuffer(body) || typeof body === 'string') {
          payload = body;
          finalHeaders['Content-Type'] = contentType || 'application/octet-stream';
        } else {
          payload = JSON.stringify(body);
          finalHeaders['Content-Type'] = 'application/json';
        }
      }
      const res = await fetch(base + route, { method, headers: finalHeaders, body: payload, redirect: 'manual' });
      const setCookies = res.headers.getSetCookie?.() || [];
      for (const line of setCookies) {
        const match = /(?:^|\s)om_session=([^;]*)/.exec(line);
        if (!match) continue;
        cookie = match[1] ? `om_session=${match[1]}` : '';
      }
      let data = null;
      const type = res.headers.get('content-type') || '';
      if (parse === 'buffer') data = Buffer.from(await res.arrayBuffer());
      else if (parse === 'text') data = await res.text();
      else if (type.includes('application/json')) {
        data = await res.json().catch(() => null);
      } else if (res.status !== 204) {
        data = await res.text();
      }
      return { status: res.status, headers: res.headers, data };
    },
  };
}

function expectStatus(result, status, label) {
  assert.equal(
    result.status,
    status,
    `${label} 期望 HTTP ${status}，实际 ${result.status}：${JSON.stringify(result.data)}`
  );
}

async function login(username, password) {
  const client = makeClient();
  const result = await client.req('POST', '/api/auth/login', { body: { username, password } });
  expectStatus(result, 200, `登录 ${username}`);
  return client;
}

async function createUser(admin, username, role = 'user') {
  const result = await admin.req('POST', '/api/users', {
    body: { username, displayName: username, password: USER_PASS, role },
  });
  expectStatus(result, 201, `创建用户 ${username}`);
  return result.data.user;
}

async function createProject(admin, body) {
  const result = await admin.req('POST', '/api/projects', { body });
  expectStatus(result, 201, `创建项目 ${body.name}`);
  return result.data.project;
}

async function addMember(admin, projectId, userId, role) {
  const result = await admin.req('POST', `/api/projects/${projectId}/members`, { body: { userId, role } });
  expectStatus(result, 201, '添加成员');
  return result.data.member;
}

async function upload(client, projectId, filename, buffer, mime) {
  return client.req('POST', `/api/projects/${projectId}/items?filename=${encodeURIComponent(filename)}`, {
    body: buffer,
    contentType: mime,
  });
}

const state = {};

before(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'overmarked-test-'));
  const config = loadConfig({
    dataDir: tempDir,
    port: 0,
    host: '127.0.0.1',
    logRequests: false,
    adminUsername: ADMIN_USER,
    adminPassword: ADMIN_PASS,
  });
  app = await createApp(config);
  const address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  app?.server.closeAllConnections?.();
  await app?.close();
  if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test('静态页面与健康检查可用', async () => {
  const client = makeClient();
  const health = await client.req('GET', '/api/health');
  expectStatus(health, 200, '健康检查');
  assert.equal(health.data.ok, true);
  assert.equal(health.data.name, 'OVERMARKED');

  const index = await client.req('GET', '/', { parse: 'text' });
  expectStatus(index, 200, '首页');
  assert.match(index.data, /OVERMARKED/);
  assert.match(index.data, /js\/app\.js/);

  const module = await client.req('GET', '/js/views/settings.js', { parse: 'text' });
  expectStatus(module, 200, '设置模块');
  assert.match(module.data, /openProjectSettings/);
});

test('认证、CSRF 与未登录访问控制', async () => {
  const anonymous = makeClient();
  const unauthorized = await anonymous.req('GET', '/api/projects');
  expectStatus(unauthorized, 401, '未登录项目列表');
  assert.equal(unauthorized.data.error.code, 'UNAUTHENTICATED');

  const noCsrf = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  assert.equal(noCsrf.status, 403);
  const csrfBody = await noCsrf.json();
  assert.equal(csrfBody.error.code, 'CSRF_BLOCKED');

  const wrong = await anonymous.req('POST', '/api/auth/login', {
    body: { username: ADMIN_USER, password: 'definitely-wrong' },
  });
  expectStatus(wrong, 401, '错误密码');

  const admin = await login(ADMIN_USER, ADMIN_PASS);
  const me = await admin.req('GET', '/api/auth/me');
  expectStatus(me, 200, '当前用户');
  assert.equal(me.data.user.role, 'admin');
  state.admin = admin;
  state.adminUser = me.data.user;
});

test('用户、成员与项目角色权限', async () => {
  const admin = state.admin;
  const manager = await createUser(admin, 'carol');
  const reviewer = await createUser(admin, 'bob');
  const annotator = await createUser(admin, 'alice');
  const outsider = await createUser(admin, 'dave');
  state.manager = manager;
  state.reviewer = reviewer;
  state.annotator = annotator;
  state.outsider = outsider;

  const project = await createProject(admin, {
    name: '街景车辆检测',
    kind: 'image',
    description: '集成测试项目',
    labelSchema: {
      labels: [
        { id: 'car', name: '车辆', color: '#f5a524', hotkey: '1' },
        { id: 'ped', name: '行人', color: '#4cc9f0', hotkey: '2' },
      ],
      documentLabels: [],
    },
  });
  state.imageProject = project;
  await addMember(admin, project.id, manager.id, 'manager');
  await addMember(admin, project.id, reviewer.id, 'reviewer');
  await addMember(admin, project.id, annotator.id, 'annotator');

  state.managerClient = await login('carol', USER_PASS);
  state.reviewerClient = await login('bob', USER_PASS);
  state.annotatorClient = await login('alice', USER_PASS);
  state.outsiderClient = await login('dave', USER_PASS);

  const aliceView = await state.annotatorClient.req('GET', `/api/projects/${project.id}`);
  expectStatus(aliceView, 200, '标注员查看项目');
  assert.equal(aliceView.data.role, 'annotator');

  const outsiderView = await state.outsiderClient.req('GET', `/api/projects/${project.id}`);
  expectStatus(outsiderView, 403, '非成员访问项目');

  const aliceAdminUsers = await state.annotatorClient.req('GET', '/api/users');
  expectStatus(aliceAdminUsers, 403, '标注员访问用户管理');

  const reviewerAdd = await state.reviewerClient.req('POST', `/api/projects/${project.id}/members`, {
    body: { userId: outsider.id, role: 'annotator' },
  });
  expectStatus(reviewerAdd, 403, '复核员添加成员');

  const aliceManage = await state.annotatorClient.req('PATCH', `/api/projects/${project.id}`, {
    body: { name: '不应成功' },
  });
  expectStatus(aliceManage, 403, '标注员修改项目');

  const aliceAudit = await state.annotatorClient.req('GET', '/api/admin/audit');
  expectStatus(aliceAudit, 403, '标注员访问全局审计');

  const managerAudit = await state.managerClient.req('GET', `/api/projects/${project.id}/audit`);
  expectStatus(managerAudit, 200, '项目管理员读取项目审计');
  assert.ok(managerAudit.data.entries.length >= 3);
});

test('图片：上传、尺寸识别、标注、提交、驳回与 COCO 导出', async () => {
  const admin = state.admin;
  const annotator = state.annotatorClient;
  const reviewer = state.reviewerClient;
  const project = state.imageProject;

  const uploaded = await upload(admin, project.id, 'street-01.png', PNG, 'image/png');
  expectStatus(uploaded, 201, '上传 PNG');
  const item = uploaded.data.item;
  state.imageItem = item;
  assert.equal(item.meta.width, 1);
  assert.equal(item.meta.height, 1);
  assert.equal(item.status, 'pending');

  const assigned = await admin.req('PATCH', `/api/items/${item.id}`, {
    body: { assigneeId: state.annotator.id },
  });
  expectStatus(assigned, 200, '指派条目');
  assert.equal(assigned.data.item.assigneeId, state.annotator.id);

  const draft = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: {
        shapes: [{ id: 's1', type: 'box', label: 'car', x: 0, y: 0, w: 1, h: 0.8 }],
        note: '测试框',
      },
      submit: false,
    },
  });
  expectStatus(draft, 200, '保存标注草稿');
  assert.equal(draft.data.annotation.status, 'draft');
  assert.equal(draft.data.annotation.version, 1);
  assert.equal(draft.data.item.status, 'in_progress');

  const invalidLabel = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: { data: { shapes: [{ id: 'bad', type: 'box', label: 'ghost', x: 0, y: 0, w: 1, h: 1 }] }, submit: false },
  });
  expectStatus(invalidLabel, 422, '不存在的标签');

  const submitted = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: {
        shapes: [
          { id: 's1', type: 'box', label: 'car', x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
          { id: 's2', type: 'polygon', label: 'ped', points: [{ x: 0.7, y: 0.7 }, { x: 0.9, y: 0.7 }, { x: 0.8, y: 0.9 }] },
        ],
        note: '遮挡目标已标注',
      },
      submit: true,
    },
  });
  expectStatus(submitted, 200, '提交标注');
  assert.equal(submitted.data.annotation.status, 'submitted');
  assert.equal(submitted.data.item.status, 'submitted');
  assert.equal(submitted.data.annotation.version, 2);

  const review = await reviewer.req('POST', `/api/items/${item.id}/review`, {
    body: { decision: 'reject', note: '请补全遮挡车辆并核对标签。' },
  });
  expectStatus(review, 200, '驳回标注');
  assert.equal(review.data.item.status, 'rejected');
  assert.equal(review.data.review.decision, 'rejected');
  assert.equal(review.data.annotation.version, 3);

  const editAfterReject = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: {
        shapes: [
          { id: 's1', type: 'box', label: 'car', x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
          { id: 's2', type: 'polygon', label: 'ped', points: [{ x: 0.7, y: 0.7 }, { x: 0.9, y: 0.7 }, { x: 0.8, y: 0.9 }] },
        ],
        note: '已修正',
      },
      submit: true,
    },
  });
  expectStatus(editAfterReject, 200, '驳回后重新提交');
  assert.equal(editAfterReject.data.item.status, 'submitted');
  assert.equal(editAfterReject.data.annotation.version, 4);

  const approve = await reviewer.req('POST', `/api/items/${item.id}/review`, {
    body: { decision: 'approve', note: '通过' },
  });
  expectStatus(approve, 200, '通过标注');
  assert.equal(approve.data.item.status, 'approved');
  assert.equal(approve.data.annotation.version, 5);

  const locked = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: { data: { shapes: [], note: '' }, submit: false },
  });
  expectStatus(locked, 409, '已通过条目只读');

  const history = await annotator.req('GET', `/api/items/${item.id}/history`);
  expectStatus(history, 200, '版本历史');
  assert.ok(history.data.versions.length >= 3);
  assert.ok(history.data.reviews.length >= 2);

  const exportCoco = await admin.req('GET', `/api/projects/${project.id}/export?format=coco&scope=approved`, {
    parse: 'text',
  });
  expectStatus(exportCoco, 200, 'COCO 导出');
  assert.match(exportCoco.headers.get('content-disposition'), /attachment/);
  const coco = JSON.parse(exportCoco.data);
  assert.equal(coco.annotations.length, 2);
  assert.equal(coco.images.length, 1);
  assert.equal(coco.categories.length, 2);
  assert.equal(coco.annotations[0].image_id, 1);
  assert.ok(coco.annotations.every((entry) => typeof entry.category_id === 'number'));

  const range = await annotator.req('GET', `/api/items/${item.id}/file`, {
    headers: { Range: 'bytes=0-7' },
    parse: 'buffer',
  });
  expectStatus(range, 206, 'Range 请求');
  assert.equal(range.data.length, 8);
  assert.deepEqual(range.data, PNG.subarray(0, 8));
  assert.match(range.headers.get('content-range'), /^bytes 0-7\/68$/);

  const invalidRange = await annotator.req('GET', `/api/items/${item.id}/file`, {
    headers: { Range: 'bytes=999-1000' },
    parse: 'text',
  });
  expectStatus(invalidRange, 416, '非法 Range');
});

test('标签体系：可新增，引用中的标签不可删除', async () => {
  const admin = state.admin;
  const project = state.imageProject;
  const schema = {
    labels: [
      { id: 'car', name: '车辆', color: '#f5a524', hotkey: '1' },
      { id: 'ped', name: '行人', color: '#4cc9f0', hotkey: '2' },
      { id: 'sign', name: '交通标志', color: '#48c78e', hotkey: '3' },
    ],
    documentLabels: [],
  };
  const added = await admin.req('PATCH', `/api/projects/${project.id}`, { body: { labelSchema: schema } });
  expectStatus(added, 200, '新增标签');
  assert.equal(added.data.project.labelSchema.labels.length, 3);

  const blocked = await admin.req('PATCH', `/api/projects/${project.id}`, {
    body: {
      labelSchema: {
        labels: [
          { id: 'ped', name: '行人', color: '#4cc9f0', hotkey: '2' },
          { id: 'sign', name: '交通标志', color: '#48c78e', hotkey: '3' },
        ],
        documentLabels: [],
      },
    },
  });
  expectStatus(blocked, 409, '删除引用中的标签');
  assert.equal(blocked.data.error.code, 'LABEL_IN_USE');

  const removed = await admin.req('PATCH', `/api/projects/${project.id}`, {
    body: { labelSchema: { labels: schema.labels.slice(0, 2), documentLabels: [] } },
  });
  expectStatus(removed, 200, '删除未使用标签');
  assert.equal(removed.data.project.labelSchema.labels.length, 2);
});

test('文本：重叠校验、NER 导出与文件类型限制', async () => {
  const admin = state.admin;
  const annotator = state.annotatorClient;
  const project = await createProject(admin, {
    name: '文本实体抽取',
    kind: 'text',
    labelSchema: {
      labels: [
        { id: 'person', name: '人名', color: '#f5a524', hotkey: '1' },
        { id: 'org', name: '机构', color: '#4cc9f0', hotkey: '2' },
      ],
      documentLabels: [{ id: 'news', name: '新闻', color: '#48c78e' }],
    },
  });
  state.textProject = project;
  await addMember(admin, project.id, state.annotator.id, 'annotator');
  await addMember(admin, project.id, state.reviewer.id, 'reviewer');
  const text = 'Hello annotated world';
  const uploaded = await upload(admin, project.id, 'sample.txt', Buffer.from(text, 'utf8'), 'text/plain');
  expectStatus(uploaded, 201, '上传文本');
  const item = uploaded.data.item;
  assert.equal(item.meta.width, undefined);

  const wrongType = await upload(admin, project.id, 'wrong.png', PNG, 'image/png');
  expectStatus(wrongType, 415, '文本项目拒绝图片');

  const overlapping = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: {
        entities: [
          { id: 'e1', start: 0, end: 8, label: 'person' },
          { id: 'e2', start: 6, end: 15, label: 'org' },
        ],
        documentLabels: ['news'],
        note: '',
      },
      submit: false,
    },
  });
  expectStatus(overlapping, 422, '重叠实体');

  const outOfRange = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: { entities: [{ id: 'e1', start: 0, end: 999, label: 'person' }], documentLabels: [], note: '' },
      submit: false,
    },
  });
  expectStatus(outOfRange, 422, '实体越界');

  const saved = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: {
        entities: [
          { id: 'e1', start: 0, end: 5, label: 'person' },
          { id: 'e2', start: 6, end: 15, label: 'org' },
        ],
        documentLabels: ['news'],
        note: '双实体',
      },
      submit: true,
    },
  });
  expectStatus(saved, 200, '保存文本标注');

  const approved = await admin.req('POST', `/api/items/${item.id}/review`, {
    body: { decision: 'approve', note: '' },
  });
  expectStatus(approved, 200, '管理员通过文本');

  const exportNer = await admin.req('GET', `/api/projects/${project.id}/export?format=ner&scope=approved`, {
    parse: 'text',
  });
  expectStatus(exportNer, 200, 'NER 导出');
  const lines = exportNer.data.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, text);
  assert.equal(lines[0].entities.length, 2);
  assert.equal(lines[0].entities[0].label, '人名');
  assert.deepEqual(lines[0].documentLabels, ['新闻']);

  const file = await annotator.req('GET', `/api/items/${item.id}/file`, { parse: 'text' });
  expectStatus(file, 200, '读取文本文件');
  assert.equal(file.data, text);
});

test('音频：时长补丁、区段校验与 JSONL 导出', async () => {
  const admin = state.admin;
  const annotator = state.annotatorClient;
  const project = await createProject(admin, {
    name: '语音片段切分',
    kind: 'audio',
    labelSchema: {
      labels: [
        { id: 'speech', name: '人声', color: '#f5a524', hotkey: '1' },
        { id: 'noise', name: '噪声', color: '#4cc9f0', hotkey: '2' },
      ],
      documentLabels: [],
    },
  });
  state.audioProject = project;
  await addMember(admin, project.id, state.annotator.id, 'annotator');
  const wav = Buffer.alloc(128);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(120, 4);
  wav.write('WAVE', 8, 'ascii');
  const uploaded = await upload(admin, project.id, 'voice.wav', wav, 'audio/wav');
  expectStatus(uploaded, 201, '上传 WAV');
  const item = uploaded.data.item;

  const meta = await annotator.req('PATCH', `/api/items/${item.id}`, {
    body: { meta: { duration: 10 } },
  });
  expectStatus(meta, 200, '补写音频时长');
  assert.equal(meta.data.item.meta.duration, 10);

  const overflow = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: { segments: [{ id: 'a1', start: 1, end: 12, label: 'speech' }], note: '' },
      submit: false,
    },
  });
  expectStatus(overflow, 422, '区段超出时长');

  const saved = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: {
        segments: [
          { id: 'a1', start: 0.5, end: 2.4, label: 'speech' },
          { id: 'a2', start: 2.8, end: 4.2, label: 'noise' },
        ],
        note: '对齐到 0.1s',
      },
      submit: true,
    },
  });
  expectStatus(saved, 200, '保存音频标注');
  state.audioItem = item;

  const exportAudio = await admin.req('GET', `/api/projects/${project.id}/export?format=audio&scope=all`, {
    parse: 'text',
  });
  expectStatus(exportAudio, 200, '音频导出');
  const lines = exportAudio.data.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].duration, 10);
  assert.equal(lines[0].segments.length, 2);
  assert.equal(lines[0].segments[0].label, '人声');
});

test('空间：GeoJSON 元数据、坐标校验与 GeoJSON 导出', async () => {
  const admin = state.admin;
  const annotator = state.annotatorClient;
  const reviewer = state.reviewerClient;
  const project = await createProject(admin, {
    name: '城市空间要素',
    kind: 'spatial',
    labelSchema: {
      labels: [
        { id: 'poi', name: '兴趣点', color: '#f5a524', hotkey: '1' },
        { id: 'road', name: '道路', color: '#4cc9f0', hotkey: '2' },
        { id: 'zone', name: '区域', color: '#48c78e', hotkey: '3' },
      ],
      documentLabels: [],
    },
  });
  state.spatialProject = project;
  await addMember(admin, project.id, state.annotator.id, 'annotator');
  await addMember(admin, project.id, state.reviewer.id, 'reviewer');

  const baseGeoJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: '示例公园' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[116.39, 39.9], [116.4, 39.9], [116.4, 39.91], [116.39, 39.91], [116.39, 39.9]]],
        },
      },
    ],
  };
  const uploaded = await upload(
    admin,
    project.id,
    'base.geojson',
    Buffer.from(JSON.stringify(baseGeoJson)),
    'application/geo+json'
  );
  expectStatus(uploaded, 201, '上传 GeoJSON 底图');
  const item = uploaded.data.item;
  assert.equal(item.meta.crs, 'EPSG:4326');
  assert.equal(item.meta.featureCount, 1);
  assert.deepEqual(item.meta.bounds, [116.39, 39.9, 116.4, 39.91]);
  state.spatialItem = item;

  const beforeInvalid = await admin.req('GET', `/api/projects/${project.id}/items`);
  expectStatus(beforeInvalid, 200, '空间条目列表');

  const badGeoJson = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [200, 100] },
  };
  const rejected = await upload(
    admin,
    project.id,
    'bad.geojson',
    Buffer.from(JSON.stringify(badGeoJson)),
    'application/geo+json'
  );
  expectStatus(rejected, 422, '越界 GeoJSON 拒绝');
  const afterInvalid = await admin.req('GET', `/api/projects/${project.id}/items`);
  assert.equal(afterInvalid.data.total, beforeInvalid.data.total);

  const badPoint = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: {
        features: [{ id: 'f0', label: 'poi', geometry: { type: 'Point', coordinates: [200, 100] } }],
        note: '',
      },
      submit: false,
    },
  });
  expectStatus(badPoint, 422, '越界坐标标注');

  const saved = await annotator.req('PUT', `/api/items/${item.id}/annotation`, {
    body: {
      data: {
        features: [
          { id: 'f1', label: 'poi', geometry: { type: 'Point', coordinates: [116.397, 39.908] } },
          {
            id: 'f2',
            label: 'zone',
            geometry: {
              type: 'Polygon',
              coordinates: [[[116.392, 39.903], [116.398, 39.903], [116.398, 39.907]]],
            },
          },
        ],
        note: '封闭多边形由服务端补齐',
      },
      submit: true,
    },
  });
  expectStatus(saved, 200, '保存空间标注');

  const polygon = saved.data.annotation.data.features.find((feature) => feature.id === 'f2');
  assert.equal(polygon.geometry.coordinates[0].length, 4);
  assert.deepEqual(polygon.geometry.coordinates[0][0], polygon.geometry.coordinates[0][3]);

  const approved = await reviewer.req('POST', `/api/items/${item.id}/review`, {
    body: { decision: 'approve', note: '' },
  });
  expectStatus(approved, 200, '通过空间标注');

  const exportGeo = await admin.req('GET', `/api/projects/${project.id}/export?format=geojson&scope=approved`, {
    parse: 'text',
  });
  expectStatus(exportGeo, 200, 'GeoJSON 导出');
  const geo = JSON.parse(exportGeo.data);
  assert.equal(geo.type, 'FeatureCollection');
  assert.equal(geo.features.length, 2);
  assert.deepEqual(geo.crs.properties.name, 'EPSG:4326');
  assert.ok(geo.features.every((feature) => feature.properties.crs === 'EPSG:4326'));
});

test('归档只读、项目删除与文件清理', async () => {
  const admin = state.admin;
  const project = await createProject(admin, {
    name: '归档测试',
    kind: 'image',
    labelSchema: {
      labels: [{ id: 'obj', name: '目标', color: '#f5a524', hotkey: '1' }],
      documentLabels: [],
    },
  });
  const uploaded = await upload(admin, project.id, 'archive.png', PNG, 'image/png');
  expectStatus(uploaded, 201, '归档前上传');
  const item = uploaded.data.item;

  const archived = await admin.req('PATCH', `/api/projects/${project.id}`, { body: { archived: true } });
  expectStatus(archived, 200, '归档项目');
  assert.equal(archived.data.project.archived, true);

  const writeBlocked = await admin.req('PUT', `/api/items/${item.id}/annotation`, {
    body: { data: { shapes: [], note: '' }, submit: false },
  });
  expectStatus(writeBlocked, 409, '归档项目拒绝写入');
  assert.equal(writeBlocked.data.error.code, 'PROJECT_ARCHIVED');

  const uploadBlocked = await upload(admin, project.id, 'later.png', PNG, 'image/png');
  expectStatus(uploadBlocked, 409, '归档项目拒绝上传');

  const unarchived = await admin.req('PATCH', `/api/projects/${project.id}`, { body: { archived: false } });
  expectStatus(unarchived, 200, '取消归档');

  const badDelete = await admin.req('DELETE', `/api/projects/${project.id}`, { body: { confirmName: '错误名称' } });
  expectStatus(badDelete, 422, '删除确认名错误');

  const deleted = await admin.req('DELETE', `/api/projects/${project.id}`, { body: { confirmName: project.name } });
  expectStatus(deleted, 204, '删除项目');
  assert.equal(fs.existsSync(path.join(tempDir, 'uploads', project.id)), false);

  const missing = await admin.req('GET', `/api/projects/${project.id}`);
  expectStatus(missing, 404, '已删除项目');
});

test('停用账号会吊销会话并禁止登录', async () => {
  const admin = state.admin;
  const client = state.outsiderClient;
  const user = state.outsider;

  const disabled = await admin.req('PATCH', `/api/users/${user.id}`, { body: { status: 'disabled' } });
  expectStatus(disabled, 200, '停用账号');
  assert.equal(disabled.data.user.status, 'disabled');

  const sessionDead = await client.req('GET', '/api/auth/me');
  expectStatus(sessionDead, 401, '停用后旧会话');

  const failedLogin = await client.req('POST', '/api/auth/login', {
    body: { username: user.username, password: USER_PASS },
  });
  expectStatus(failedLogin, 403, '停用账号登录');
  assert.equal(failedLogin.data.error.code, 'ACCOUNT_DISABLED');

  const enabled = await admin.req('PATCH', `/api/users/${user.id}`, { body: { status: 'active' } });
  expectStatus(enabled, 200, '启用账号');
  const relogin = await client.req('POST', '/api/auth/login', {
    body: { username: user.username, password: USER_PASS },
  });
  expectStatus(relogin, 200, '启用后登录');
});

test('全局审计支持操作与操作者过滤', async () => {
  const result = await state.admin.req('GET', '/api/admin/audit?limit=50&action=user.create&actor=admin');
  expectStatus(result, 200, '过滤审计');
  assert.ok(result.data.entries.length >= 4);
  assert.ok(result.data.entries.every((entry) => entry.action === 'user.create'));
  assert.ok(result.data.entries.every((entry) => entry.actorName === '管理员' || entry.actorName === 'admin'));
  const detail = result.data.entries[0].detail;
  assert.ok(detail.username);
});
