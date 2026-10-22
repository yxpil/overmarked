import http from 'node:http';
import path from 'node:path';
import {
  createLoginLimiter,
  ensureAdmin,
  pruneSessions,
} from './auth.js';
import { openDatabase } from './db.js';
import {
  clientIp,
  parseCookies,
  sendError,
  sendJson,
  serveStatic,
  setSecurityHeaders,
} from './http.js';
import { HttpError, notFound } from './errors.js';
import { createRouter } from './router.js';
import { registerAuthRoutes, attachSession } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerItemRoutes } from './routes/items.js';
import { registerAnnotationRoutes } from './routes/annotations.js';
import { registerExportRoutes } from './routes/export.js';

export async function createApp(config) {
  const db = openDatabase(config);
  const adminBootstrap = ensureAdmin(db, config);
  pruneSessions(db);
  const limiter = createLoginLimiter();
  const router = createRouter();

  router.get('/api/health', async (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      name: 'OVERMARKED',
      version: '1.0.0',
      time: new Date().toISOString(),
    });
  });

  registerAuthRoutes(router);
  registerUserRoutes(router);
  registerProjectRoutes(router);
  registerItemRoutes(router);
  registerAnnotationRoutes(router);
  registerExportRoutes(router);

  const logRequests = config.logRequests !== false;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    setSecurityHeaders(res);
    let ctx = null;
    res.on('finish', () => {
      if (!logRequests) return;
      const user = ctx?.user?.username || '-';
      console.log(
        `${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms ${user}`
      );
    });
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      ctx = {
        req,
        res,
        db,
        config,
        url,
        pathname: url.pathname,
        query: url.searchParams,
        cookies: parseCookies(req.headers.cookie),
        ip: clientIp(req, config),
        user: null,
        params: {},
        limiter,
      };
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-om-request'] !== '1') {
          throw new HttpError(403, 'CSRF_BLOCKED', '缺少 X-OM-Request 请求头');
        }
        ctx.user = attachSession(db, ctx.cookies);
        const matched = await router.dispatch(ctx);
        if (!matched) throw notFound('接口不存在');
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, config.publicDir, url.pathname);
      } else {
        throw notFound('页面不存在');
      }
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status >= 500) console.error('[http]', error);
        sendError(res, error);
      } else if (/SQLITE_BUSY|database is locked/i.test(String(error?.message))) {
        sendError(res, new HttpError(503, 'DB_BUSY', '数据库忙，请稍后重试'));
      } else {
        console.error('[http] unhandled:', error);
        sendError(res, error);
      }
    }
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const cleanupTimer = setInterval(() => {
    try {
      pruneSessions(db);
      limiter.sweep();
    } catch (error) {
      console.error('[cleanup]', error.message);
    }
  }, 6 * 60 * 60 * 1000);
  cleanupTimer.unref?.();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(cleanupTimer);
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    db.close();
  }

  async function listen(port = config.port, host = config.host) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    return server.address();
  }

  return { server, db, config, adminBootstrap, listen, close, publicDir: path.resolve(config.publicDir) };
}
