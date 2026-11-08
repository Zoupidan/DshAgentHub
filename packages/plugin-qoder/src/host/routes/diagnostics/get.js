/**
 * 诊断路由 GET /plugin-qoder/diagnostics（loopback-only）。
 * @module host/routes/diagnostics/get
 */
import { ROUTE_DIAGNOSTICS } from '../../../shared/constants.js';
import { isLoopback, isLoopbackHost } from '../loopback.js';

export const DIAGNOSTICS_TTL_MS = 15_000;

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  try { res.statusCode = status; res.setHeader?.('content-type', 'application/json; charset=utf-8'); res.end(text); } catch {}
}

export function makeDiagnosticsRoute(dispatch = null, runtime = null, { ttlMs = DIAGNOSTICS_TTL_MS, now = Date.now } = {}) {
  let cached = null;
  return {
    kind: 'exact',
    path: ROUTE_DIAGNOSTICS,
    handler: async (req, res) => {
      if (!isLoopback(req) || !isLoopbackHost(req)) return sendJson(res, 403, { error: 'loopback-only' });
      const cfg = runtime?.currentConfig?.() ?? runtime?.current?.() ?? null;
      if (cfg && cfg.enabled !== true) return sendJson(res, 200, { available: false, reason: 'plugin-disabled' });
      if (!dispatch || typeof dispatch.inspect !== 'function') return sendJson(res, 200, { available: false, reason: 'dispatcher not wired' });
      const at = now();
      if (cached && at - cached.at < ttlMs) return sendJson(res, 200, { ...cached.body, cached: true });
      try {
        const body = await dispatch.inspect(cfg ?? {});
        cached = { at, body };
        sendJson(res, 200, { ...body, cached: false });
      } catch (e) {
        sendJson(res, 200, { available: true, inspectThrew: true, error: String(e?.message ?? e).slice(0, 200), at });
      }
    },
  };
}
