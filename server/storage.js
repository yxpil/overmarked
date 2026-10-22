import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { uuid } from './util.js';
import { EXT_MIME, KIND_EXTENSIONS, IMAGE_EXTENSIONS, detectImageSize, parseGeoJsonBuffer } from './media.js';
import { HttpError, invalid, notFound, tooLarge } from './errors.js';

const STORAGE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i;
const GEOJSON_PARSE_LIMIT = 64 * 1024 * 1024;

export function sanitizeOriginalName(raw) {
  const base = String(raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const name = base.replace(/^\.+/, '').slice(0, 200);
  if (!name) throw invalid('文件名不能为空');
  return name;
}

export function extensionOf(filename) {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0 || idx === filename.length - 1) throw invalid('文件名必须包含扩展名');
  const ext = filename.slice(idx + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw invalid('文件扩展名非法');
  return ext;
}

export function assertAllowedForKind(kind, filename) {
  const ext = extensionOf(filename);
  const allowed = KIND_EXTENSIONS[kind];
  if (!allowed.includes(ext)) {
    throw new HttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      `${kind} 项目不支持 .${ext} 文件，可用：${allowed.join(', ')}`,
      { ext, allowed }
    );
  }
  return ext;
}

export function maxBytesFor(config, kind, ext) {
  if (kind === 'text') return config.textMaxBytes;
  if (kind === 'spatial' && ['geojson', 'json'].includes(ext)) {
    return Math.min(config.uploadMaxBytes, GEOJSON_PARSE_LIMIT);
  }
  return config.uploadMaxBytes;
}

export function projectUploadDir(config, projectId) {
  return path.join(config.uploadDir, projectId);
}

export async function saveUpload(req, { config, projectId, filename, maxBytes }) {
  const ext = extensionOf(filename);
  const dir = projectUploadDir(config, projectId);
  await fs.promises.mkdir(dir, { recursive: true });
  const storageKey = `${uuid()}.${ext}`;
  const tmpPath = path.join(dir, `${storageKey}.part`);
  const finalPath = path.join(dir, storageKey);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (Number.isFinite(declared) && declared === 0) throw invalid('文件为空');
  let size = 0;
  const stream = fs.createWriteStream(tmpPath, { flags: 'wx' });
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw tooLarge();
      if (!stream.write(chunk)) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
    if (size === 0) throw invalid('文件为空');
    await fs.promises.rename(tmpPath, finalPath);
  } catch (error) {
    stream.destroy();
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  const mime = kindMime(ext);
  return { storageKey, size, mime, ext };
}

function kindMime(ext) {
  return EXT_MIME[ext] || 'application/octet-stream';
}

export async function inspectStoredFile({ kind, ext, filePath, size }) {
  const meta = {};
  if (IMAGE_EXTENSIONS.has(ext)) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(262144, size));
      await handle.read(buffer, 0, buffer.length, 0);
      const dims = detectImageSize(buffer);
      if (dims && dims.width > 0 && dims.height > 0) {
        meta.width = dims.width;
        meta.height = dims.height;
      }
    } finally {
      await handle.close();
    }
  }
  if (kind === 'spatial' && ['geojson', 'json'].includes(ext)) {
    if (size > GEOJSON_PARSE_LIMIT) throw tooLarge('GeoJSON 文件不能超过 64 MB');
    const buffer = await fs.promises.readFile(filePath);
    const parsed = parseGeoJsonBuffer(buffer);
    meta.featureCount = parsed.featureCount;
    meta.crs = 'EPSG:4326';
    if (parsed.bounds) meta.bounds = parsed.bounds;
  }
  if (kind === 'spatial' && IMAGE_EXTENSIONS.has(ext) && !meta.crs) {
    meta.crs = 'pixel';
  }
  return meta;
}

export function resolveStoredPath(config, projectId, storageKey) {
  if (!STORAGE_KEY_RE.test(storageKey)) throw notFound('文件不存在');
  const dir = path.resolve(projectUploadDir(config, projectId));
  const filePath = path.resolve(dir, storageKey);
  if (!filePath.startsWith(dir + path.sep)) throw notFound('文件不存在');
  return filePath;
}

export async function removeStoredFile(config, projectId, storageKey) {
  const filePath = resolveStoredPath(config, projectId, storageKey);
  await fs.promises.rm(filePath, { force: true });
}

export async function removeProjectFiles(config, projectId) {
  const dir = projectUploadDir(config, projectId);
  await fs.promises.rm(dir, { recursive: true, force: true });
}

export async function readTextFile(config, projectId, storageKey, maxBytes) {
  const filePath = resolveStoredPath(config, projectId, storageKey);
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat) throw notFound('文件不存在');
  if (stat.size > maxBytes) throw tooLarge();
  return fs.promises.readFile(filePath, 'utf8');
}

export function contentTypeForItem(kind, ext) {
  if (kind === 'text') return 'text/plain; charset=utf-8';
  if (kind === 'spatial' && ['geojson', 'json'].includes(ext)) {
    return 'application/json; charset=utf-8';
  }
  return EXT_MIME[ext] || 'application/octet-stream';
}
