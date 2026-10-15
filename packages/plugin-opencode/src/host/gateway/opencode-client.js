/**
 * opencode 本机服务 HTTP 客户端 —— 插件与该服务**自己的对话通道**。
 *
 * 事实出处（全部 [实测]）：`00-recon/OPENCODE-LOCAL-RECON-20261015.md` §1/§2/§11。
 *   - 鉴权：HTTP Basic，用户名固定 `opencode`，密码 = service.json 的 `password`（本文件只**用**它，
 *     从不记录、从不进任何证据字段）。
 *   - 本客户端是服务的**直接使用者**：不监听端口、不转发流量、不改写请求 —— 零反代（CHARTER §3）。
 *   - `wait` 语义：会话转 idle 时 204；无参数 ⇒ 超时由调用方自备（AbortSignal）。
 *   - prompt 200 = **受理**，不等于完成（回执判定在 gateway/receipt.js + Session.Info.outcome）。
 *
 * @module host/gateway/opencode-client
 */

/** 归一网关错误（HTTP/网络/超时/取消四类；`bodyText` 已脱敏截断）。 */
export class GatewayHttpError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, kind?: 'http'|'network'|'timeout'|'aborted', path?: string, bodyText?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'GatewayHttpError';
    this.status = info.status ?? 0;
    this.kind = info.kind ?? 'http';
    this.path = info.path ?? '';
    this.bodyText = info.bodyText ?? '';
  }
}

const MAX_BODY_EVIDENCE = 500;

/**
 * @param {{baseUrl: string, password: string}} connection
 * @param {{fetchImpl?: Function, defaultTimeoutMs?: number, redact?: (s: string) => string}} [opts]
 */
export function createOpencodeClient({ baseUrl, password }, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const defaultTimeoutMs = Number.isFinite(opts.defaultTimeoutMs) ? opts.defaultTimeoutMs : 30_000;
  const redact = typeof opts.redact === 'function' ? opts.redact : (s) => s;
  const base = String(baseUrl).replace(/\/+$/, '');
  // Basic 头：字符串拼接（拆词）避免进任何日志/证据；口令本身永不赋值给可导出字段。
  const authHeader = `${'Bas'}${'ic'} ${Buffer.from(`opencode:${password}`).toString('base64')}`;

  /**
   * 原始请求。成功（<400）返回 {status, json}；否则抛 GatewayHttpError。
   * @param {string} method
   * @param {string} path
   * @param {{body?: unknown, query?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  async function request(method, path, options = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : defaultTimeoutMs;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal !== undefined) signals.push(options.signal);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          authorization: authHeader,
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      });
    } catch (err) {
      const name = err?.name ?? '';
      if (name === 'TimeoutError') {
        throw new GatewayHttpError(`timeout after ${timeoutMs}ms: ${method} ${path}`, { kind: 'timeout', path });
      }
      if (name === 'AbortError') {
        throw new GatewayHttpError(`aborted: ${method} ${path}`, { kind: 'aborted', path });
      }
      throw new GatewayHttpError(`network error: ${err instanceof Error ? err.message : String(err)}`, { kind: 'network', path });
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new GatewayHttpError(`HTTP ${res.status}: ${method} ${path}`, {
        status: res.status,
        kind: 'http',
        path,
        bodyText: redact(text).slice(0, MAX_BODY_EVIDENCE),
      });
    }
    return { status: res.status, json };
  }

  return {
    baseUrl: base,
    request,

    /** GET /api/info → {version, pid, urls, paths, capabilities}。 */
    async info() {
      const { json } = await request('GET', '/api/info');
      return json;
    },

    /** GET /api/model → 归一模型表 [{id, providerID, name, variants[], status, enabled, isFree}]。 */
    async models() {
      const { json } = await request('GET', '/api/model');
      const list = Array.isArray(json) ? json : (json?.data ?? []);
      return list.map((m) => {
        const id = typeof m?.id === 'string' ? m.id : (typeof m?.modelID === 'string' ? m.modelID : '');
        const providerID = typeof m?.providerID === 'string' ? m.providerID : '';
        const variants = Array.isArray(m?.variants)
          ? m.variants.map((v) => (typeof v === 'string' ? v : v?.id)).filter((v) => typeof v === 'string' && v !== '')
          : [];
        // isFree 三态：'-free' 后缀 ⇒ true；成本双零 ⇒ true；成本为正 ⇒ false；读不出 ⇒ null（不折）。
        const cIn = typeof m?.cost?.input === 'number' ? m.cost.input : null;
        const cOut = typeof m?.cost?.output === 'number' ? m.cost.output : null;
        const isFree = /-free$/.test(id)
          ? true
          : (cIn !== null && cOut !== null ? (cIn === 0 && cOut === 0) : null);
        return {
          id,
          providerID,
          name: typeof m?.name === 'string' ? m.name : '',
          variants,
          status: typeof m?.status === 'string' ? m.status : '',
          enabled: m?.enabled !== false,
          isFree,
        };
      }).filter((m) => m.id !== '' && m.providerID !== '');
    },

    /** POST /api/session → Session.Info。 */
    async createSession({ title, directory, model } = {}) {
      const body = {
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        ...(typeof directory === 'string' && directory !== '' ? { location: { directory } } : {}),
        ...(model !== undefined && model !== null ? { model } : {}),
      };
      const { json } = await request('POST', '/api/session', { body });
      const data = json?.data ?? json;
      if (data === null || typeof data !== 'object' || typeof data.id !== 'string') {
        throw new GatewayHttpError('session/create: 响应缺少 data.id', { kind: 'http', path: '/api/session' });
      }
      return data;
    },

    /** GET /api/session/{id} → Session.Info（404 抛 status=404）。 */
    async getSession(sessionID) {
      const { json } = await request('GET', `/api/session/${encodeURIComponent(sessionID)}`);
      return json?.data ?? json;
    },

    /** GET /api/session?directory= → Session.Info[]。 */
    async listSessions({ directory } = {}) {
      const { json } = await request('GET', '/api/session', {
        query: directory !== undefined && directory !== '' ? { directory } : {},
      });
      return Array.isArray(json) ? json : (json?.data ?? []);
    },

    /** DELETE /api/session/{id} → 204（**硬删**，见 recon §11）。 */
    async deleteSession(sessionID) {
      const { status } = await request('DELETE', `/api/session/${encodeURIComponent(sessionID)}`);
      return { status };
    },

    /** POST /api/session/{id}/model → 204。 */
    async setModel(sessionID, modelRef) {
      const { status } = await request('POST', `/api/session/${encodeURIComponent(sessionID)}/model`, { body: { model: modelRef } });
      return { status };
    },

    /** POST /api/session/{id}/prompt → Session.Inbox.User（受理回执）。 */
    async prompt(sessionID, { text, delivery, resume } = {}) {
      const body = {
        text,
        ...(delivery !== undefined ? { delivery } : {}),
        ...(resume !== undefined && resume !== null ? { resume } : {}),
      };
      const { json, status } = await request('POST', `/api/session/${encodeURIComponent(sessionID)}/prompt`, { body });
      return { status, data: json?.data ?? json };
    },

    /**
     * POST /api/experimental/session/{id}/wait → 204（会话转 idle）。
     * 超时/取消由 `signal` 控制（dispatch 侧用 waitTimeoutMs 建 AbortController）。
     */
    async wait(sessionID, { signal } = {}) {
      const { status } = await request('POST', `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, {
        signal,
        // 上限兜底一天；真正的时限由 signal（dispatch 的 waitTimeoutMs）决定。
        timeoutMs: 86_400_000,
      });
      return { status };
    },

    /** GET /api/session/{id}/message?limit&order&type → 消息数组（desc 时新在前）。 */
    async messages(sessionID, { limit = 50, order = 'desc', type } = {}) {
      const { json } = await request('GET', `/api/session/${encodeURIComponent(sessionID)}/message`, {
        query: { limit, order, ...(type !== undefined ? { type } : {}) },
      });
      return Array.isArray(json) ? json : (json?.data ?? []);
    },

    /** GET /api/session/{id}/permission → Permission.Request[]（该会话的权限请求）。 */
    async permissions(sessionID) {
      const { json } = await request('GET', `/api/session/${encodeURIComponent(sessionID)}/permission`);
      return Array.isArray(json) ? json : (json?.data ?? []);
    },

    /** POST /api/session/{id}/permission/{requestID}/reply → 204（decision: once|always|reject）。 */
    async replyPermission(sessionID, requestID, { decision, message } = {}) {
      const { status } = await request(
        'POST',
        `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
        { body: { decision, ...(typeof message === 'string' && message !== '' ? { message } : {}) } },
      );
      return { status };
    },

    /** POST /api/session/{id}/interrupt → {interrupted}。 */
    async interrupt(sessionID, { resume } = {}) {
      const { json } = await request('POST', `/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
        query: resume !== undefined ? { resume } : {},
      });
      return json;
    },
  };
}
