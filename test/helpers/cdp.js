import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

export function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`));
        else entry.resolve(message.result);
        return;
      }
      for (const handler of this.handlers.get(message.method) || []) handler(message.params);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, timeout = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout after ${timeout}ms: ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        method,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Thin browser page driver over the Chrome DevTools Protocol.
 * Uses real input events (Input.dispatchMouseEvent / Input.dispatchKeyEvent) so
 * exercises hit the same code path a human user would.
 */
export class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.consoleErrors = [];
    this.exceptions = [];
    this.failedRequests = [];
  }

  static async open(browserWsUrl) {
    const cdp = await Cdp.connect(browserWsUrl);
    const page = new Page(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') return;
      page.consoleErrors.push(
        (params.args || [])
          .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
          .join(' ')
      );
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails;
      page.exceptions.push(details.exception?.description || details.text || 'unknown exception');
    });
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry.level === 'error') page.consoleErrors.push(params.entry.text);
    });
    cdp.on('Network.loadingFailed', (params) => {
      page.failedRequests.push(`${params.type} ${params.errorText}`);
    });
    // The workbench guards navigation with beforeunload when there are unsaved
    // changes; a real browser asks the user, so the harness answers for them.
    cdp.on('Page.javascriptDialogOpening', () => {
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    return page;
  }

  send(method, params) {
    return this.cdp.send(method, params);
  }

  async evaluate(expression) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `evaluate failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`
      );
    }
    return result.result.value;
  }

  async waitFor(expression, { timeout = 15000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(interval);
    }
    throw new Error(`waitFor timed out: ${expression}${lastError ? ` (${lastError.message})` : ''}`);
  }

  async goto(url) {
    await this.cdp.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"');
  }

  async setViewport(width, height, mobile = false) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
  }

  /** Drops every cookie so the next load starts as a signed-out visitor. */
  async clearCookies() {
    await this.cdp.send('Network.clearBrowserCookies');
  }

  async box(selector) {
    const rect = await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    if (!rect) throw new Error(`element not found: ${selector}`);
    return rect;
  }

  async click(selector) {
    const rect = await this.box(selector);
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await this.mouseClick(x, y);
    return { x, y };
  }

  async mouseClick(x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  async mouseDrag(x1, y1, x2, y2, steps = 8) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 });
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: x1,
      y: y1,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= steps; i += 1) {
      const ratio = i / steps;
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x1 + (x2 - x1) * ratio,
        y: y1 + (y2 - y1) * ratio,
        button: 'left',
        buttons: 1,
      });
      await sleep(16);
    }
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x2,
      y: y2,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  /** Selects a text range inside the element by character offsets. */
  async selectText(selector, start, end) {
    return this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let acc = 0;
      let rangeStart = null;
      let rangeEnd = null;
      let text;
      while (walker.nextNode()) {
        const value = walker.currentNode.nodeValue;
        const next = acc + value.length;
        if (rangeStart === null && start >= acc && start < next) {
          rangeStart = { node: walker.currentNode, offset: start - acc };
        }
        if (rangeEnd === null && end > acc && end <= next) {
          rangeEnd = { node: walker.currentNode, offset: end - acc };
        }
        acc = next;
        text = (text || '') + value;
      }
      if (!rangeStart || !rangeEnd) return false;
      const range = document.createRange();
      range.setStart(rangeStart.node, rangeStart.offset);
      range.setEnd(rangeEnd.node, rangeEnd.offset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return { text: selection.toString(), length: text.length };
    })()`);
  }

  /** Client rect of a character range, used to aim real mouse drags at text. */
  async rangeRect(selector, start, end) {
    return this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const from = ${Number(start)};
      const to = ${Number(end)};
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let acc = 0;
      let rangeStart = null;
      let rangeEnd = null;
      while (walker.nextNode()) {
        const value = walker.currentNode.nodeValue;
        const next = acc + value.length;
        if (!rangeStart && from >= acc && from < next) {
          rangeStart = { node: walker.currentNode, offset: from - acc };
        }
        if (!rangeEnd && to > acc && to <= next) {
          rangeEnd = { node: walker.currentNode, offset: to - acc };
        }
        acc = next;
      }
      if (!rangeStart || !rangeEnd) return null;
      const range = document.createRange();
      range.setStart(rangeStart.node, rangeStart.offset);
      range.setEnd(rangeEnd.node, rangeEnd.offset);
      const rects = Array.from(range.getClientRects());
      if (!rects.length) return null;
      const first = rects[0];
      const last = rects[rects.length - 1];
      return {
        left: first.left,
        top: first.top,
        right: last.right,
        bottom: last.bottom,
        height: first.height,
        lines: rects.length,
      };
    })()`);
  }

  /** Selects text the way a user does: press, drag, release over the range. */
  async dragSelectText(selector, start, end) {
    const rect = await this.rangeRect(selector, start, end);
    if (!rect) throw new Error(`range not found: ${selector}[${start},${end}]`);
    const y = rect.top + rect.height / 2;
    await this.mouseDrag(rect.left + 1, y, rect.right - 1, y, 6);
    return this.evaluate('window.getSelection() ? window.getSelection().toString() : ""');
  }

  async fill(selector, value) {
    await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      node.focus();
      node.value = '';
      return true;
    })()`);
    await this.cdp.send('Input.insertText', { text: value });
    await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  async pressKey(key, code, keyCode) {
    const base = { key, code: code || key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async screenshot(filePath) {
    const result = await this.cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
    return filePath;
  }

  async resetErrorLog() {
    this.consoleErrors = [];
    this.exceptions = [];
    this.failedRequests = [];
  }
}

export async function launchBrowser({ executablePath } = {}) {
  const binary = executablePath || findChrome();
  if (!binary) return null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-e2e-chrome-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('chrome start timeout')), 30000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`chrome exited with code ${code}`));
    });
  });

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((entry) => entry.type === 'page');
  if (!target) throw new Error('no page target');

  return {
    port,
    wsUrl: target.webSocketDebuggerUrl,
    async close() {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      await sleep(300);
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
