import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, tooLarge } from './errors.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function setSecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL';
  const message =
    error instanceof HttpError ? error.message : '服务器内部错误';
  const body = { error: { code, message } };
  if (error instanceof HttpError && error.details !== undefined) {
    body.error.details = error.details;
  }
  if (status === 429 && error.retryAfter) body.error.retryAfter = error.retryAfter;
  const extra = status === 429 && error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {};
  sendJson(res, status, body, extra);
}

export function sendNoContent(res, extraHeaders = {}) {
  res.writeHead(204, { 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  const contentType = String(req.headers['content-type'] || '');
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw tooLarge();
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'JSON 格式错误');
  }
}

export function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(value);
      } catch {
        result[key] = value;
      }
    }
  }
  return result;
}

export function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

export function serveStatic(req, res, publicDir, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const looksLikeAsset = /\.[a-zA-Z0-9]+$/.test(pathname);
    if (looksLikeAsset) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return true;
    }
    relative = 'index.html';
    filePath = path.join(root, 'index.html');
  }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    ETag: etag,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

export function parseRange(rangeHeader, total) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return { invalid: true };
  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return { invalid: true };
  let start;
  let end;
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? total - 1 : Number(endRaw);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, total - 1) };
}

export function makeEtag(size, mtimeMs) {
  return crypto.createHash('sha1').update(`${size}:${mtimeMs}`).digest('hex');
}
