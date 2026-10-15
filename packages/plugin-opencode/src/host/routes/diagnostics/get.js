/**
 * 诊断路由（`GET /plugin-opencode/diagnostics`）—— 只读体检（只 loopback）。
 *
 * 逐项 checks 由 `dispatch.inspect()` 产出（config / service-json / http-info / probe），
 * 15s TTL 缓存：卡片与人工查障共用，且不会因轮询打炸服务。
 *
 * @module host/routes/diagnostics/get
 */
import { ROUTE_DIAGNOSTICS } from '../../../shared/constants.js';
import { isLoopback, isLoopbackHost } from '../loopback.js';

export const DIAGNOSTICS_TTL_MS = 15_000;

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  try {
    res.statusCode = status;
    res.setHeader?.('content-type', 'application/json; charset=utf-8');
    res.end(text);
  } catch {
    /* 连接已断开等 */
  }
}

/**
 * @param {{inspect: Function}|null} dispatch
 * @param {object|null} runtime
 * @returns {{kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void>}}
 */
export function makeDiagnosticsRoute(dispatch = null, runtime = null, { ttlMs = DIAGNOSTICS_TTL_MS, now = Date.now } = {}) {
  let cached = null;
  return {
    kind: 'exact',
    path: ROUTE_DIAGNOSTICS,
    handler: async (req, res) => {
      if (!isLoopback(req) || !isLoopbackHost(req)) {
        sendJson(res, 403, { error: 'loopback-only' });
        return;
      }
      // 关闭状态不体检（PRD-v4 ①硬闸的同一语义：关了就是关了，包括体检本身）。
      const cfg = runtime !== null && typeof runtime?.currentConfig === 'function' ? runtime.currentConfig() : null;
      if (cfg !== null && cfg !== undefined && cfg.enabled !== true) {
        sendJson(res, 200, { available: false, reason: 'plugin-disabled' });
        return;
      }
      if (dispatch === null || typeof dispatch?.inspect !== 'function') {
        sendJson(res, 200, { available: false, reason: 'dispatcher not wired' });
        return;
      }
      const at = now();
      if (cached !== null && at - cached.at < ttlMs) {
        sendJson(res, 200, { ...cached.body, cached: true });
        return;
      }
      let body;
      try {
        body = await dispatch.inspect();
      } catch (err) {
        sendJson(res, 200, { available: true, inspectThrew: true, error: err instanceof Error ? err.message : String(err), at });
        return;
      }
      cached = { at, body };
      sendJson(res, 200, { ...body, cached: false });
    },
  };
}
