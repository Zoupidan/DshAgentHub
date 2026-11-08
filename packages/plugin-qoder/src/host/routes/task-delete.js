/**
 * 任务删除兼容路由：Qoder 无计划任务列表，永远返回 not_applicable。
 * @module host/routes/task-delete
 */
import { ROUTE_TASK_DELETE } from '../../shared/constants.js';
import { isLoopback, isLoopbackHost } from '../loopback.js';

function sendJson(res, status, payload) {
  try { res.statusCode = status; res.setHeader?.('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(payload)); } catch {}
}

export function makeTaskDeleteRoute() {
  return {
    kind: 'exact',
    path: ROUTE_TASK_DELETE,
    handler: async (req, res) => {
      if (!isLoopback(req) || !isLoopbackHost(req)) return sendJson(res, 403, { error: 'loopback-only' });
      sendJson(res, 200, { ok: false, notApplicable: true, supported: false, scheduledTasks: 0, reason: 'Qoder 无计划任务列表（scheduled_tasks 不支持）；本路由仅为兼容探测面。' });
    },
  };
}
