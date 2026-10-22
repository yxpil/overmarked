function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

function matchSegments(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length) return null;
  const params = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const p = patternSegments[i];
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(pathSegments[i]);
      } catch {
        return null;
      }
    } else if (p !== pathSegments[i]) {
      return null;
    }
  }
  return params;
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const segments = normalizePath(pattern).split('/').filter(Boolean);
    routes.push({ method, segments, handler, pattern });
  }

  const get = (pattern, handler) => add('GET', pattern, handler);
  const post = (pattern, handler) => add('POST', pattern, handler);
  const put = (pattern, handler) => add('PUT', pattern, handler);
  const patch = (pattern, handler) => add('PATCH', pattern, handler);
  const del = (pattern, handler) => add('DELETE', pattern, handler);

  async function dispatch(ctx) {
    const pathSegments = normalizePath(ctx.pathname).split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== ctx.req.method) continue;
      const params = matchSegments(route.segments, pathSegments);
      if (params) {
        ctx.params = params;
        await route.handler(ctx);
        return true;
      }
    }
    return false;
  }

  return { add, get, post, put, patch, del, delete: del, dispatch, routes };
}
