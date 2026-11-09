/**
 * 状态路由 GET /plugin-qoder/status（loopback-only, fail-closed）。不带凭据。
 * 导出 modelCapability(config) 供 check-consumed-knobs 行为探针使用。
 * @module host/routes/status/get
 */
import { PACKAGE_NAME, ROUTE_STATUS } from '../../../shared/constants.js';
import { isLoopback, isLoopbackHost } from '../loopback.js';
import { getCredentialMeta } from '../../signin/credentials.js';

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  try {
    res.statusCode = status;
    res.setHeader?.('content-type', 'application/json; charset=utf-8');
    res.end(text);
  } catch {}
}

/** ★ knobs 探针的真实消费者：必须读取/返回 launch 数据表（含哨兵形态）。 */
export function modelCapability(config, serviceValues = {}) {
  const launch = config?.launch && typeof config.launch === 'object' ? config.launch : {};
  return {
    effortValues: Object.prototype.hasOwnProperty.call(launch, 'effortValues') ? launch.effortValues : {},
    contextWindowValues: Object.prototype.hasOwnProperty.call(launch, 'contextWindowValues') ? launch.contextWindowValues : {},
    service: serviceValues && typeof serviceValues === 'object' ? serviceValues : {},
  };
}

export function makeStatusRoute(runtime, sessions, dispatch) {
  return {
    kind: 'exact',
    path: ROUTE_STATUS,
    handler: async (req, res) => {
      if (!isLoopback(req) || !isLoopbackHost(req)) {
        sendJson(res, 403, { error: 'loopback-only' });
        return;
      }
      const cfg = runtime.currentConfig?.() ?? runtime.current?.() ?? {};
      let models = { source: 'pending', models: [] };
      if (dispatch && typeof dispatch.models === 'function' && cfg.enabled === true) {
        try { models = await dispatch.models(cfg); } catch (e) { models = { source: `unavailable:${String(e?.message ?? e).slice(0, 80)}`, models: [] }; }
      }
      const cred = getCredentialMeta();
      const sessionRows = typeof sessions?.summary === 'function' ? await sessions.summary(20) : [];
      const runtimeCredits = runtime.credits?.() ?? null;
      sendJson(res, 200, {
        pluginId: PACKAGE_NAME,
        registry: runtime.registry?.() ?? 'unknown',
        probe: runtime.probe?.() ?? null,
        config: {
          enabled: cfg.enabled === true,
          cdpPort: Number(cfg.cdpPort) || 9333,
          model: String(cfg.model ?? ''),
          reasoningEffort: String(cfg.reasoningEffort ?? ''),
          contextWindow: Number(cfg.contextWindow ?? 0),
          workspace: String(cfg.workspace ?? ''),
          workspaceId: String(cfg.workspaceId ?? ''),
          boundSessionId: String(cfg.boundSessionId ?? ''),
          endpointId: String(cfg.endpointId ?? ''),
          waitTimeoutMs: Number(cfg.waitTimeoutMs ?? 900000),
        },
        capability: modelCapability(cfg),
        models: Array.isArray(models.models) ? models.models : [],
        modelsSource: models.source,
        sessions: sessionRows,
        inFlight: runtime.inFlight?.() ?? [],
        lastRun: runtime.lastRun?.() ?? null,
        credits: cred.configured ? runtimeCredits : { claimState: 'unconfigured', region: 'cn' },
        signin: { configured: cred.configured, region: 'cn', accountId: cred.accountId, masked: cred.masked },
        scheduledTasks: { supported: false, count: 0, note: 'Qoder 无计划任务列表；scheduled_tasks=0 不变式' },
        approvalRelay: { status: 'unknown', verified: false },
        at: Date.now(),
      });
    },
  };
}
