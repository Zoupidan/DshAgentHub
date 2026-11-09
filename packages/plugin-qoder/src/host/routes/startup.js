/**
 * 启动项路由（loopback-only）。
 * @module host/routes/startup
 */
import { ROUTE_STARTUP } from '../../shared/constants.js';
import { isLoopback, isLoopbackHost } from './loopback.js';
import { applyStartup, inspectStartup, revokeStartup } from '../startup/manager.js';

function sendJson(res, status, payload) {
  try { res.statusCode = status; res.setHeader?.('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(payload)); } catch {}
}

export function makeStartupRoute(runtime) {
  return {
    kind: 'exact',
    path: ROUTE_STARTUP,
    handler: async (req, res) => {
      try {
        if (!isLoopback(req) || !isLoopbackHost(req)) return sendJson(res, 403, { error: 'loopback-only' });
        const cfg = runtime.currentConfig?.() ?? {};
        if (req.method === 'GET') return sendJson(res, 200, inspectStartup(cfg));
        if (req.method === 'POST') return sendJson(res, 200, applyStartup(cfg));
        if (req.method === 'DELETE') return sendJson(res, 200, revokeStartup());
        sendJson(res, 405, { error: 'method-not-allowed' });
      } catch (e) {
        sendJson(res, 200, { ok: false, exists: false, error: String(e?.message ?? e).slice(0, 200), port: 9333 });
      }
    },
  };
}
