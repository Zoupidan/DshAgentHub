/**
 * 状态 bridge 路由（`GET /plugin-opencode/status`）—— 设置卡片与诊断的**唯一数据面**。
 *
 * 载荷形状 = `src/host/types/index.js` 的 `StatusPayload`（字段名即契约；卡片逐字消费）。
 * 安全：**loopback-only，fail-closed** —— 载荷含本机路径（service.json 命中路径、探测证据），
 * 若 dsh webserver 被配置为 `0.0.0.0`，裸 exact 路由不经 `/api` 网关鉴权 ⇒ 非回环一律 403。
 *
 * 纪律：
 *   - **不带凭据**：password 不进载荷（service.json 只回传路径与"是否可用"）；
 *   - 模型清单走 dispatch.models()（30s TTL）；服务不可用 ⇒ `modelsSource='unavailable:<reason>'`，
 *     不拿旧缓存冒充实况；
 *   - approvals 是**最近一轮的观察**（lastRun.permissionRequests 的 pending 项），不是此刻的网络读数
 *     —— 实时清点用 `opencode_approvals` 工具（路由不因卡片轮询而打服务）。
 *
 * @module host/routes/status/get
 */
import { PACKAGE_NAME, ROUTE_STATUS } from '../../../shared/constants.js';
import { APPROVAL_ITEMS_LIMIT } from '../../config/constants.js';
import { isLoopback, isLoopbackHost } from '../loopback.js';

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  try {
    res.statusCode = status;
    res.setHeader?.('content-type', 'application/json; charset=utf-8');
    res.end(text);
  } catch {
    /* 连接已断开等 —— 无事可做 */
  }
}

/**
 * 档位能力表（★ 红线行为的真实消费者：`launch.variantValues` 数据表 ——
 * 由 `tools/ci/check-consumed-knobs.mjs` 的 PROBE_TARGETS 按包指名本函数）。
 *
 * 三态来源（StatusPayload.variant.source）：
 *   - `service`：服务实况（`/api/model` 的 variants[].id，调用方传入）；
 *   - `config`：服务不可用/模型未在目录里，但用户在 `launch.variantValues` 里声明了该模型的档位域
 *     —— 离线兜底，**不冒充服务实况**；
 *   - `unavailable:<reason>` / `pending:<reason>`：两条来源都没有 ⇒ 如实说不知道。
 *
 * @param {any} config 生效配置（**已解包**的普通对象；probe 传哨兵值也可，表原样回传）
 * @param {string[]|null} [serviceValues] 服务实况档位
 */
export function variantCapability(config, serviceValues = null) {
  const table = config?.launch?.variantValues;
  const model = typeof config?.model === 'string' ? config.model : '';
  if (Array.isArray(serviceValues)) {
    return { model, values: serviceValues, source: 'service', table: table ?? {} };
  }
  const fromTable = table !== null && table !== undefined && typeof table === 'object'
    && Array.isArray(table[model])
    ? table[model]
    : [];
  if (fromTable.length > 0) {
    return { model, values: fromTable, source: 'config', table };
  }
  return { model, values: [], source: 'unavailable:no-data', table: table ?? {} };
}

/** lastRun 的 pending 审批 → StatusPayload.approvals（截断上限）。 */
export function approvalsFromLastRun(last) {
  const items = [];
  if (last !== null && typeof last === 'object' && Array.isArray(last.permissionRequests)) {
    for (const p of last.permissionRequests) {
      if (p?.state !== 'pending') continue;
      items.push({
        sessionID: typeof last.sessionId === 'string' ? last.sessionId : '',
        requestID: typeof p.requestID === 'string' ? p.requestID : '',
        action: typeof p.action === 'string' ? p.action : '',
        at: typeof last.at === 'number' ? last.at : 0,
      });
    }
  }
  return { pendingCount: items.length, items: items.slice(0, APPROVAL_ITEMS_LIMIT) };
}

/**
 * @param {object} runtime config/runtime.js 实例
 * @param {object} sessions session/map.js api
 * @param {{models: Function}} dispatch
 * @returns {{kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void>}}
 */
export function makeStatusRoute(runtime, sessions, dispatch, { now = Date.now } = {}) {
  return {
    kind: 'exact',
    path: ROUTE_STATUS,
    handler: async (req, res) => {
      if (!isLoopback(req) || !isLoopbackHost(req)) {
        sendJson(res, 403, { error: 'loopback-only' });
        return;
      }
      try {
        const cfg = runtime.currentConfig() ?? {};
        const ps = runtime.probeState();
        let models = [];
        let modelsSource = 'unavailable:unknown';
        try {
          const cat = await dispatch.models();
          if (cat.ok === true) {
            models = cat.models.map((m) => ({
              id: m.id,
              providerID: m.providerID,
              label: `${m.providerID}/${m.id}`,
              variants: m.variants,
              isFree: m.isFree,
              status: m.status,
              enabled: m.enabled,
            }));
            modelsSource = 'service';
          } else {
            modelsSource = `unavailable:${cat.reason}`;
          }
        } catch (err) {
          modelsSource = `unavailable:${err instanceof Error ? err.message : String(err)}`;
        }
        const targetModel = models.find((m) => `${m.providerID}/${m.id}` === cfg.model);
        const variant = variantCapability(cfg, targetModel === undefined ? null : targetModel.variants);
        if (variant.source === 'unavailable:no-data') {
          variant.source = modelsSource === 'service'
            ? (typeof cfg.model === 'string' && cfg.model !== '' ? 'unavailable:model-not-in-catalog' : 'pending:no-model')
            : modelsSource;
        }
        const last = runtime.lastRun();
        sendJson(res, 200, {
          pluginId: PACKAGE_NAME,
          registry: runtime.registry(),
          probe: ps.result,
          config: {
            enabled: cfg.enabled === true,
            model: typeof cfg.model === 'string' ? cfg.model : '',
            variant: typeof cfg.variant === 'string' ? cfg.variant : '',
            workspace: typeof cfg.workspace === 'string' ? cfg.workspace : '',
            boundSessionId: typeof cfg.boundSessionId === 'string' ? cfg.boundSessionId : '',
            serviceDir: typeof cfg.serviceDir === 'string' ? cfg.serviceDir : '',
            baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
            waitTimeoutMs: typeof cfg.waitTimeoutMs === 'number' ? cfg.waitTimeoutMs : 900_000,
          },
          variant,
          models,
          modelsSource,
          inFlight: runtime.inFlight(),
          lastRun: last ?? null,
          approvals: approvalsFromLastRun(last),
          at: now(),
        });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
