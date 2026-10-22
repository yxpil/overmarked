import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(serverDir, '..');

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`环境变量 ${name} 必须是 ${min}..${max} 的整数`);
  }
  return n;
}

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir || process.env.DATA_DIR || path.join(projectRoot, 'data'));
  return {
    port: intEnv('PORT', 8787, 1, 65535),
    host: process.env.HOST || '127.0.0.1',
    dataDir,
    uploadDir: path.join(dataDir, 'uploads'),
    dbFile: path.join(dataDir, 'overmarked.db'),
    publicDir: path.join(projectRoot, 'public'),
    sessionDays: intEnv('SESSION_DAYS', 7, 1, 365),
    uploadMaxBytes: intEnv('UPLOAD_MAX_MB', 512, 1, 4096) * 1024 * 1024,
    textMaxBytes: intEnv('TEXT_MAX_MB', 10, 1, 256) * 1024 * 1024,
    adminUsername: (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD || '',
    trustProxy: process.env.TRUST_PROXY === '1',
    cookieSecure: process.env.COOKIE_SECURE === '1',
    ...overrides,
  };
}
