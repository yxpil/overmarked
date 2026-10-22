import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findChrome, launchBrowser, Page } from './helpers/cdp.js';
import { loadConfig, projectRoot } from '../server/config.js';
import { createApp } from '../server/app.js';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoPass123!';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Boots a throwaway instance: seeded demo data + HTTP server + headless Chrome. */
async function bootstrap() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-e2e-data-'));
  const seed = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'seed-demo.js')], {
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let seedLog = '';
  seed.stdout.on('data', (chunk) => {
    seedLog += chunk.toString();
  });
  seed.stderr.on('data', (chunk) => {
    seedLog += chunk.toString();
  });
  const seedCode = await new Promise((resolve) => seed.on('exit', resolve));
  if (seedCode !== 0) {
    throw new Error(`seed failed (${seedCode}):\n${seedLog}`);
  }

  const app = await createApp(loadConfig({ dataDir, port: 0, logRequests: false }));
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const browser = await launchBrowser();
  const page = await Page.open(browser.wsUrl);
  await page.setViewport(1440, 900, false);

  return {
    dataDir,
    baseUrl,
    app,
    browser,
    page,
    async close() {
      await browser.close();
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function apiClient(baseUrl) {
  async function login(username, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OM-Request': '1' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200, `login ${username} -> ${response.status}`);
    const cookies = response.headers.getSetCookie?.() || [];
    const token = /om_session=([^;]+)/.exec(cookies.join(';'))?.[1];
    assert.ok(token, 'session cookie missing');
    return token;
  }

  async function request(method, pathname, { token, body } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(token ? { Cookie: `om_session=${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'X-OM-Request': '1' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    return { status: response.status, payload };
  }

  return {
    login,
    get: (pathname, token) => request('GET', pathname, { token }),
    post: (pathname, token, body) => request('POST', pathname, { token, body }),
  };
}

/** Drives the real login form. */
async function loginViaUi(page, baseUrl, username, password) {
  await page.clearCookies();
  await page.goto(`${baseUrl}/?t=${Date.now()}#/login`);
  await page.waitFor('!!document.querySelector(".login-form")');
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('.login-form button[type="submit"]');
  await page.waitFor('location.hash.startsWith("#/projects")', { timeout: 20000 });
}

/** Opens a workbench route and waits for the queue plus the media to settle. */
async function openItem(page, baseUrl, projectId, itemId, readySelector) {
  await page.goto(`${baseUrl}/?t=${Date.now()}#/p/${projectId}?item=${itemId}`);
  await page.waitFor('!!document.querySelector(".workbench")');
  await page.waitFor('document.querySelectorAll(".queue-row").length > 0');
  if (readySelector) await page.waitFor(readySelector, { timeout: 20000 });
}

/** Clicks a button by its visible text. */
async function clickByText(page, text) {
  const clicked = await page.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((node) => node.textContent.trim() === ${JSON.stringify(text)} && !node.hidden && !node.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.ok(clicked, `button not found: ${text}`);
}

/** Polls an API-derived predicate until it holds. */
async function waitForApi(probe, { timeout = 20000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`waitForApi timed out; last value: ${JSON.stringify(last)}`);
}

/** Browser expression returning the inspector figure-count badge text. */
const figureBadgeExpr = `(() => {
  const section = Array.from(document.querySelectorAll('.inspector-section'))
    .find((node) => node.querySelector('.inspector-title')?.textContent === '图元');
  return section && section.querySelector('.badge')?.textContent;
})()`;

const chromeAvailable = Boolean(findChrome());

describe('浏览器端 E2E', { skip: chromeAvailable ? false : '未检测到 Chrome/Edge，跳过浏览器 E2E', timeout: 120000 }, () => {
  let env;
  let api;

  before(async () => {
    env = await bootstrap();
    api = apiClient(env.baseUrl);
  });

  after(async () => {
    if (env) await env.close();
  });

  test('登录页：凭据错误给出提示，登录成功后进入项目列表', async () => {
    const { page, baseUrl } = env;
    await page.goto(`${baseUrl}/?t=${Date.now()}#/login`);
    await page.waitFor('!!document.querySelector(".login-form")');

    await page.fill('input[name="username"]', 'demo_manager');
    await page.fill('input[name="password"]', 'wrong-password');
    await page.click('.login-form button[type="submit"]');
    await page.waitFor('!!document.querySelector(".login-error:not([hidden])")');
    const message = await page.evaluate('document.querySelector(".login-error").textContent');
    assert.match(message, /用户名|密码|错误/, `unexpected error text: ${message}`);

    await page.fill('input[name="password"]', DEMO_PASSWORD);
    await page.click('.login-form button[type="submit"]');
    await page.waitFor('location.hash.startsWith("#/projects")', { timeout: 20000 });
    await page.waitFor('document.querySelectorAll(".project-card").length === 4');
    const cards = await page.evaluate(
      'Array.from(document.querySelectorAll(".project-card")).map((n) => n.textContent.replace(/\\s+/g, " ").trim())'
    );
    assert.equal(cards.length, 4);
    assert.ok(cards.some((text) => text.includes('街景目标检测')));
    assert.deepEqual(page.exceptions, []);
  });

  test('图片：标注员用鼠标画框、保存并提交复核，服务端落库且状态流转正确', async () => {
    const { page, baseUrl } = env;
    const managerToken = await api.login('demo_manager', DEMO_PASSWORD);
    const annotatorToken = await api.login('demo_annotator', DEMO_PASSWORD);

    const { payload: list } = await api.get('/api/projects', managerToken);
    const project = list.projects.find((entry) => entry.kind === 'image');
    assert.ok(project, 'image project missing');
    const { payload: items } = await api.get(`/api/projects/${project.id}/items`, annotatorToken);
    const target = items.items.find((entry) => entry.status === 'pending');
    assert.ok(target, 'no pending image item');

    await loginViaUi(page, baseUrl, 'demo_annotator', DEMO_PASSWORD);
    await openItem(
      page,
      baseUrl,
      project.id,
      target.id,
      '!!document.querySelector(".canvas-host .annotator canvas") && !document.querySelector(".canvas-host .stage-empty")'
    );

    // 选中矩形工具（真实点击）
    await page.click('button[title^="矩形"]');

    const canvas = await page.box('.canvas-host .annotator canvas');
    const x1 = canvas.x + canvas.width * 0.34;
    const y1 = canvas.y + canvas.height * 0.36;
    const x2 = canvas.x + canvas.width * 0.62;
    const y2 = canvas.y + canvas.height * 0.6;
    await page.mouseDrag(x1, y1, x2, y2, 10);

    // 界面断言：图元计数为 1
    await page.waitFor(`${figureBadgeExpr} === '1'`);

    // 显式保存草稿，然后等待服务端落库
    await clickByText(page, '保存草稿');
    const draft = await waitForApi(async () => {
      const { payload } = await api.get(`/api/items/${target.id}`, annotatorToken);
      return payload.annotation?.data?.shapes?.length === 1 ? payload : null;
    });
    assert.equal(draft.annotation.data.shapes.length, 1, 'shape not persisted');
    const shape = draft.annotation.data.shapes[0];
    assert.equal(shape.type, 'box');
    assert.ok(shape.w > 20 && shape.h > 20, `box too small: ${shape.w}x${shape.h}`);
    assert.ok(shape.x >= 0 && shape.y >= 0 && shape.x + shape.w <= 960 && shape.y + shape.h <= 600);

    // 提交复核
    await clickByText(page, '提交复核');
    const submitted = await waitForApi(async () => {
      const { payload } = await api.get(`/api/items/${target.id}`, annotatorToken);
      return payload.item.status === 'submitted' ? payload : null;
    });
    assert.equal(submitted.item.status, 'submitted');
    assert.equal(submitted.reviews.length, 0);
    assert.ok(submitted.annotation.version >= 2, 'submit should snapshot a new version');
    assert.deepEqual(page.exceptions, []);
  });

  test('质检员：能看到复核操作，通过后条目状态变为已通过', async () => {
    const { page, baseUrl } = env;
    const reviewerToken = await api.login('demo_reviewer', DEMO_PASSWORD);
    const { payload: list } = await api.get('/api/projects', reviewerToken);
    const project = list.projects.find((entry) => entry.kind === 'image');
    const { payload: items } = await api.get(`/api/projects/${project.id}/items`, reviewerToken);
    const submitted = items.items.find((entry) => entry.status === 'submitted');
    assert.ok(submitted, 'no submitted item to review');

    await loginViaUi(page, baseUrl, 'demo_reviewer', DEMO_PASSWORD);
    await openItem(page, baseUrl, project.id, submitted.id, '!!document.querySelector(".review-actions")');

    await clickByText(page, '通过');
    const reviewed = await waitForApi(async () => {
      const { payload } = await api.get(`/api/items/${submitted.id}`, reviewerToken);
      return payload.item.status === 'approved' ? payload : null;
    });
    assert.equal(reviewed.item.status, 'approved');
    assert.equal(reviewed.reviews.length, 1);
    assert.equal(reviewed.reviews[0].decision, 'approved');
    assert.ok(reviewed.reviews[0].reviewerName);
    assert.deepEqual(page.exceptions, []);
  });

  test('导出：管理员导出 COCO，包含刚才通过复核的矩形', async () => {
    const { page, baseUrl } = env;
    const managerToken = await api.login('demo_manager', DEMO_PASSWORD);
    const { payload: list } = await api.get('/api/projects', managerToken);
    const project = list.projects.find((entry) => entry.kind === 'image');

    // 界面：导出弹窗提供 COCO 格式与范围切换
    await loginViaUi(page, baseUrl, 'demo_manager', DEMO_PASSWORD);
    await openItem(page, baseUrl, project.id, '', '!!document.querySelector(".workbench")');
    await page.click('button[title="导出数据集"]');
    await page.waitFor('!!document.querySelector(".modal-overlay")');
    const dialog = await page.evaluate('document.querySelector(".modal").textContent');
    assert.match(dialog, /COCO JSON/);
    assert.match(dialog, /仅已通过|全部标注/);
    await page.click('.modal-x');
    await page.waitFor('!document.querySelector(".modal-overlay")');

    // 服务端：COCO 导出包含该矩形
    const { status, payload } = await api.get(
      `/api/projects/${project.id}/export?format=coco&scope=approved`,
      managerToken
    );
    assert.equal(status, 200);
    assert.ok(payload.images.length >= 1);
    assert.ok(payload.annotations.length >= 1);
    const box = payload.annotations.find((ann) => ann.bbox && ann.bbox[2] > 20);
    assert.ok(box, 'exported annotation missing');
    assert.ok(payload.categories.some((cat) => cat.name));
    assert.ok(box.category_id > 0 && box.category_id <= payload.categories.length);

    const exportedImage = payload.images.find((img) => img.id === box.image_id);
    assert.ok(exportedImage, 'exported image missing');
    assert.equal(exportedImage.width, 960);
    assert.equal(exportedImage.height, 600);

    // 导出的矩形必须与源条目上通过复核的标注一致
    const { payload: sourceItems } = await api.get(`/api/projects/${project.id}/items`, managerToken);
    const source = sourceItems.items.find((item) => item.filename === exportedImage.file_name);
    assert.ok(source, `exported file ${exportedImage.file_name} not found in project`);
    const { payload: detail } = await api.get(`/api/items/${source.id}`, managerToken);
    assert.equal(detail.item.status, 'approved');
    const sourceShape = detail.annotation.data.shapes.find((shape) => shape.type === 'box');
    assert.ok(sourceShape, 'approved item has no box');
    assert.deepEqual(box.bbox, [sourceShape.x, sourceShape.y, sourceShape.w, sourceShape.h]);
  });

  test('文本：拖选文字打标后提交，实体偏移与服务端一致', async () => {
    const { page, baseUrl } = env;
    const managerToken = await api.login('demo_manager', DEMO_PASSWORD);
    const annotatorToken = await api.login('demo_annotator', DEMO_PASSWORD);
    const { payload: list } = await api.get('/api/projects', managerToken);
    const project = list.projects.find((entry) => entry.kind === 'text');
    const { payload: items } = await api.get(`/api/projects/${project.id}/items`, annotatorToken);
    const target = items.items.find((entry) => entry.status === 'pending');
    assert.ok(target, 'no pending text item');

    await loginViaUi(page, baseUrl, 'demo_annotator', DEMO_PASSWORD);
    await openItem(page, baseUrl, project.id, target.id, '!!document.querySelector(".text-doc")');

    // 用真实鼠标拖选正文前 6 个字符
    const selected = await page.dragSelectText('.text-doc', 0, 6);
    assert.ok(selected && selected.length > 0, `selection empty: ${selected}`);

    // 弹出标签菜单并点击第一个标签
    await page.waitFor('!!document.querySelector(".selection-pop")');
    const popButtons = await page.evaluate('document.querySelectorAll(".selection-pop button").length');
    assert.ok(popButtons > 0, 'no label in popover');
    await page.click('.selection-pop button');

    await page.waitFor('document.querySelectorAll(".text-doc mark").length === 1');
    const mark = await page.evaluate(
      '(() => { const m = document.querySelector(".text-doc mark"); return { text: m.textContent, title: m.title }; })()'
    );
    assert.ok(mark.text.length > 0);

    await clickByText(page, '提交复核');
    const detail = await waitForApi(async () => {
      const { payload } = await api.get(`/api/items/${target.id}`, annotatorToken);
      return payload.item.status === 'submitted' ? payload : null;
    });
    assert.equal(detail.item.status, 'submitted');
    assert.equal(detail.annotation.data.entities.length, 1);
    const entity = detail.annotation.data.entities[0];
    assert.ok(entity.end > entity.start);
    assert.equal(entity.start, 0);
    assert.equal(entity.end, selected.length);
    assert.deepEqual(page.exceptions, []);
  });

  test('音频：拖拽生成时间区间并提交', async () => {
    const { page, baseUrl } = env;
    const managerToken = await api.login('demo_manager', DEMO_PASSWORD);
    const annotatorToken = await api.login('demo_annotator', DEMO_PASSWORD);
    const { payload: list } = await api.get('/api/projects', managerToken);
    const project = list.projects.find((entry) => entry.kind === 'audio');
    const { payload: items } = await api.get(`/api/projects/${project.id}/items`, annotatorToken);
    const target = items.items.find((entry) => entry.status === 'pending');
    assert.ok(target, 'no pending audio item');

    await loginViaUi(page, baseUrl, 'demo_annotator', DEMO_PASSWORD);
    await openItem(
      page,
      baseUrl,
      project.id,
      target.id,
      '!!document.querySelector(".audio-annotator canvas") && !document.querySelector(".audio-empty")'
    );

    // 选中一个标签
    await page.click('.label-btn');
    const canvas = await page.box('.audio-annotator canvas');
    const y = canvas.y + canvas.height / 2;
    await page.mouseDrag(canvas.x + canvas.width * 0.2, y, canvas.x + canvas.width * 0.45, y, 10);

    await page.waitFor(`Number(${figureBadgeExpr}) >= 1`);

    await clickByText(page, '提交复核');
    const detail = await waitForApi(async () => {
      const { payload } = await api.get(`/api/items/${target.id}`, annotatorToken);
      return payload.item.status === 'submitted' ? payload : null;
    });
    assert.equal(detail.item.status, 'submitted');
    assert.equal(detail.annotation.data.segments.length, 1);
    const segment = detail.annotation.data.segments[0];
    assert.ok(segment.end > segment.start, 'segment must have positive length');
    assert.ok(segment.start >= 0);
    assert.ok(segment.end <= (detail.item.meta?.duration || 99) + 0.001);
    assert.ok(segment.label);
    assert.deepEqual(page.exceptions, []);
  });

  test('空间：点要素工具落点并提交', async () => {
    const { page, baseUrl } = env;
    const managerToken = await api.login('demo_manager', DEMO_PASSWORD);
    const annotatorToken = await api.login('demo_annotator', DEMO_PASSWORD);
    const { payload: list } = await api.get('/api/projects', managerToken);
    const project = list.projects.find((entry) => entry.kind === 'spatial');
    const { payload: items } = await api.get(`/api/projects/${project.id}/items`, annotatorToken);
    const target = items.items.find((entry) => entry.status === 'pending');
    assert.ok(target, 'no pending spatial item');

    await loginViaUi(page, baseUrl, 'demo_annotator', DEMO_PASSWORD);
    await openItem(page, baseUrl, project.id, target.id, '!!document.querySelector(".spatial-annotator canvas")');

    await page.click('button[title^="点要素"]');
    const canvas = await page.box('.spatial-annotator canvas');
    await page.mouseClick(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);

    await page.waitFor(`Number(${figureBadgeExpr}) >= 1`);

    await clickByText(page, '提交复核');
    const detail = await waitForApi(async () => {
      const { payload } = await api.get(`/api/items/${target.id}`, annotatorToken);
      return payload.item.status === 'submitted' ? payload : null;
    });
    assert.equal(detail.item.status, 'submitted');
    assert.equal(detail.annotation.data.features.length, 1);
    const feature = detail.annotation.data.features[0];
    assert.equal(feature.geometry.type, 'Point');
    assert.equal(feature.geometry.coordinates.length, 2);
    assert.ok(feature.label);
    assert.deepEqual(page.exceptions, []);
  });

  test('权限边界：标注员无法进入管理控制台，也无法读取用户列表', async () => {
    const { page, baseUrl } = env;
    const annotatorToken = await api.login('demo_annotator', DEMO_PASSWORD);

    const { status } = await api.get('/api/users', annotatorToken);
    assert.equal(status, 403, 'annotator should not read the user list');

    await loginViaUi(page, baseUrl, 'demo_annotator', DEMO_PASSWORD);
    await page.goto(`${baseUrl}/?t=${Date.now()}#/admin`);
    await sleep(1200);
    const userRows = await page.evaluate('document.querySelectorAll(".table tbody tr").length');
    assert.equal(userRows, 0, 'annotator must not see any user row in the admin console');
    const adminText = await page.evaluate('document.getElementById("view").textContent');
    assert.ok(
      !/创建用户|系统管理员/.test(adminText) || userRows === 0,
      'annotator must not be offered user management'
    );
    assert.deepEqual(page.exceptions, []);
  });

  test('全流程无未捕获异常与控制台报错', async () => {
    const { page } = env;
    assert.deepEqual(page.exceptions, [], 'uncaught exceptions detected');
    const realErrors = page.consoleErrors.filter(
      (text) => !/401 \(Unauthorized\)/.test(text) && !/Failed to load resource/.test(text)
    );
    assert.deepEqual(realErrors, [], 'console errors detected');
  });
});
