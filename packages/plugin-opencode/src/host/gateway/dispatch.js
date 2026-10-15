/**
 * 下发编排 —— 把「八步契约」落成一条可复核的主流程（本插件的核心业务文件）。
 *
 * 八步 ↔ 实现的对应（CHARTER §4）：
 *   ① 创建对话   → `POST /api/session`（带 location.directory；标题带 `dsh: ` 前缀便于人识别）
 *   ② 指定工作目录 → 建会话时的 `location.directory`（复用既有会话时**不改**它的目录 —— 会话的目录
 *                    是它自己的事实，插件不偷偷搬会话）
 *   ③ 指定模型   → `POST /api/session/{id}/model`，`Model.Ref = {providerID, id, variant?}`
 *   ④ 思考强度   → 同一个 Model.Ref 的 `variant`（值域 = 服务实况 `/api/model` 的 variants[].id）
 *   ⑤ 任务下发   → `POST /api/session/{id}/prompt`（200 = **受理**，不等于完成）
 *   ⑥ 会话复用   → 会话记性（session/map.js）三级解析：bound > 记性 > 新建
 *   ⑦ 收到回执   → `POST …/wait`（idle 204）→ 读 Session.Info.outcome + 消息表本轮 assistant 正文
 *   ⑧ 审批       → wait 收敛后该会话仍有待批权限请求 ⇒ 报 `approval_pending` 并把清单带出来
 *                    （回复走 opencode_approvals 工具；本文件也提供 replyApproval）
 *
 * 判定纪律：**只认结构化事实**（HTTP 状态 / outcome / wait 结论）——不读模型正文猜成败（项目铁律）。
 *
 * 边界（v0.1，诚实登记）：
 *   - 不启动/不重启 opencode 桌面端（服务缺失 = 如实报 service_missing）。
 *   - 取消（signal）只撤**等待**：任务在桌面端继续跑（它是用户可见的会话，不是后台进程）。
 *   - 长任务超时不解除任务：waitStatus='timeout' + 当轮现状照实回传；用同会话再等可拿回执。
 *
 * @module host/gateway/dispatch
 */
import { SESSION_ID_PATTERN } from '../../shared/constants.js';
import { PROMPT_EXCERPT_LIMIT } from '../config/constants.js';
import { REASON_CODES, REASON_TEXT, oneLine, redact } from '../launch/reason-codes.js';
import { GatewayHttpError, createOpencodeClient } from './opencode-client.js';
import { buildReceipt } from './receipt.js';
import { createServiceAccess } from './service.js';

export const DEFAULT_WAIT_MS = 900_000;
export const MIN_WAIT_MS = 5_000;
export const MAX_WAIT_MS = 3_600_000;
const CATALOG_TTL_MS = 30_000;

/** 等待上限归一（越界即夹到边界 —— 不报错：等待时长不是正确性问题）。 */
export function clampWaitMs(value, fallback = DEFAULT_WAIT_MS) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  if (n < MIN_WAIT_MS) return MIN_WAIT_MS;
  if (n > MAX_WAIT_MS) return MAX_WAIT_MS;
  return n;
}

/** 解析 'providerID/id'（首个 '/' 切分；两侧非空且无空白）。 */
export function parseModelRef(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (s === '') return null;
  const i = s.indexOf('/');
  if (i <= 0 || i >= s.length - 1) return null;
  const providerID = s.slice(0, i);
  const id = s.slice(i + 1);
  if (/\s/.test(providerID) || /\s/.test(id)) return null;
  return { providerID, id };
}

/** 目录归一（供 sessionKey 派生；Windows 盘符大小写不敏感）。 */
export function normalizeDirKey(p) {
  let s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase();
  return s;
}

/** 会话键派生：显式 key > 工作目录（'dir:<归一目录>'）> ''（不记性、每轮新建）。 */
export function deriveSessionKey({ sessionKey, workspace }) {
  const explicit = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (explicit !== '') return explicit;
  const dir = typeof workspace === 'string' ? workspace.trim() : '';
  if (dir !== '') return `dir:${normalizeDirKey(dir)}`;
  return '';
}

/** 标题派生：显式 title > `dsh: <prompt 摘录>`（60 字符）。 */
export function deriveTitle(prompt, explicit) {
  const t = typeof explicit === 'string' ? explicit.trim() : '';
  if (t !== '') return t;
  const excerpt = oneLine(prompt).slice(0, 60);
  return excerpt === '' ? 'dsh: (empty prompt)' : `dsh: ${excerpt}`;
}

/** prompt 摘录（记录的 promptExcerpt 字段）。 */
export function promptExcerpt(prompt) {
  return oneLine(prompt).slice(0, PROMPT_EXCERPT_LIMIT);
}

/** 失败/部分结果的统一组装。 */
function outcome(partial) {
  return {
    ok: partial.ok === true,
    reason: partial.reason ?? REASON_CODES.INTERNAL,
    reasonText: REASON_TEXT[partial.reason ?? REASON_CODES.INTERNAL] ?? '',
    reasonEvidence: redact(oneLine(partial.reasonEvidence ?? '')),
    sessionId: partial.sessionId ?? '',
    sessionKey: partial.sessionKey ?? '',
    sessionOrigin: partial.sessionOrigin ?? '',
    resumed: partial.resumed === true,
    fallbackReason: partial.fallbackReason ?? null,
    model: partial.model ?? null,
    promptExcerpt: partial.promptExcerpt ?? '',
    delivery: partial.delivery ?? 'queue',
    acceptedAt: partial.acceptedAt ?? null,
    idleAt: partial.idleAt ?? null,
    waitStatus: partial.waitStatus ?? 'n/a',
    outcome: partial.outcome ?? null,
    reply: partial.reply ?? '',
    replyTruncated: partial.replyTruncated === true,
    cost: partial.cost ?? null,
    tokens: partial.tokens ?? null,
    permissionRequests: Array.isArray(partial.permissionRequests) ? partial.permissionRequests : [],
    permissionsError: partial.permissionsError ?? null,
    version: partial.version ?? '',
    text: partial.text ?? '',
    at: Date.now(),
  };
}

/** 权限请求归一（服务端 Permission.Request → 本插件形状）。 */
export function normalizePermissionRequest(p) {
  const source = p?.source ?? {};
  return {
    requestID: typeof p?.id === 'string' ? p.id : '',
    action: typeof p?.action === 'string' ? p.action : '',
    save: p?.save === true,
    sourceType: typeof source.type === 'string' ? source.type : '',
    sourceID: typeof source.id === 'string' ? source.id : '',
    messageID: typeof source.messageID === 'string' ? source.messageID : '',
  };
}

/**
 * @param {{resolveConfig: () => any, sessions: any, runtime?: any,
 *   fetchImpl?: Function, env?: () => Record<string, string | undefined>}} deps
 */
export function createDispatcher({ resolveConfig, sessions, runtime = null, fetchImpl, env = () => process.env }) {
  const service = createServiceAccess({ resolveConfig });
  const catalogCache = { at: 0, value: null };

  /**
   * 连接 + 存活校验（所有对外动作的公共前置）。
   * @returns {{ok: true, client: any, conn: any, version: string} | {ok: false, reason: string, reasonEvidence: string}}
   */
  async function connect() {
    const conn = service.resolveConnection(env());
    if (!conn.ok) {
      const evidence = `${conn.reason}${conn.servicePath !== undefined && conn.servicePath !== '' ? ` @ ${conn.servicePath}` : ''}`;
      return { ok: false, reason: REASON_CODES.SERVICE_MISSING, reasonEvidence: evidence };
    }
    const client = createOpencodeClient(
      { baseUrl: conn.baseUrl, password: conn.password },
      { fetchImpl, redact: (s) => redact(s, [conn.password]) },
    );
    let info = null;
    try {
      info = await client.info();
    } catch (err) {
      const mapped = mapError(err, REASON_CODES.SERVICE_UNREACHABLE);
      return { ok: false, reason: mapped.code, reasonEvidence: mapped.evidence };
    }
    return { ok: true, client, conn, version: typeof info?.version === 'string' ? info.version : '' };
  }

  /** 网关错误 → 原因码 + 证据（证据先脱敏再截断）。 */
  function mapError(err, fallback) {
    if (err instanceof GatewayHttpError) {
      const evidence = `HTTP ${err.status || '-'} ${err.path}${err.bodyText !== '' ? ` · ${err.bodyText}` : ''}`;
      if (err.status === 401 || err.status === 403) return { code: REASON_CODES.AUTH_REJECTED, evidence };
      if (err.kind === 'network' || err.kind === 'timeout' || (err.status >= 500)) {
        return { code: REASON_CODES.SERVICE_UNREACHABLE, evidence };
      }
      return { code: fallback, evidence };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { code: fallback, evidence: message };
  }

  /** GET 会话；404 ⇒ null；其它异常原样抛。 */
  async function getOrNull(client, sessionId) {
    try {
      return await client.getSession(sessionId);
    } catch (err) {
      if (err instanceof GatewayHttpError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * 会话三级解析：explicit > bound > 记性；都没有 ⇒ 新建（记性命中但 404 ⇒ 清记性并新建）。
   * @returns {{ok: true, mode: string, sessionId: string, sessionInfo: any, fallbackReason: string|null}
   *   | {ok: false, reason: string, reasonEvidence: string}}
   */
  async function resolveSession({ client, cfg, args }) {
    const key = typeof args.sessionKey === 'string' ? args.sessionKey : '';
    const explicit = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    if (explicit !== '') {
      if (!SESSION_ID_PATTERN.test(explicit)) {
        return { ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: `session_id 形态非法：${explicit}` };
      }
      const info = await getOrNull(client, explicit);
      if (info === null) return { ok: false, reason: REASON_CODES.SESSION_NOT_FOUND, reasonEvidence: explicit };
      return { ok: true, mode: 'explicit', sessionId: explicit, sessionInfo: info, fallbackReason: null };
    }
    const bound = typeof cfg.boundSessionId === 'string' ? cfg.boundSessionId.trim() : '';
    if (bound !== '') {
      if (!SESSION_ID_PATTERN.test(bound)) {
        return { ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: `boundSessionId 形态非法：${bound}` };
      }
      const info = await getOrNull(client, bound);
      if (info === null) {
        // 绑定是**用户显式意图** —— 不静默回退到任何别的会话。
        return { ok: false, reason: REASON_CODES.BOUND_SESSION_MISSING, reasonEvidence: bound };
      }
      return { ok: true, mode: 'bound', sessionId: bound, sessionInfo: info, fallbackReason: null };
    }
    if (key !== '' && args.resume !== false) {
      const record = sessions.lookup(key);
      if (record !== null && typeof record?.sessionId === 'string' && record.sessionId !== '') {
        const info = await getOrNull(client, record.sessionId);
        if (info !== null) {
          sessions.touch(key);
          return { ok: true, mode: 'resumed', sessionId: record.sessionId, sessionInfo: info, fallbackReason: null };
        }
        sessions.forget(key);
        return {
          ok: true,
          mode: 'new',
          sessionId: '',
          sessionInfo: null,
          fallbackReason: `记性的会话已不在（${record.sessionId}，404）—— 已清除记性并新开`,
        };
      }
    }
    return { ok: true, mode: 'new', sessionId: '', sessionInfo: null, fallbackReason: null };
  }

  /** 等 idle + 收证据（run 与 replyApproval 共用）。 */
  async function waitAndReceipt({ client, sessionId, inboxId, waitMs, signal, onPhase }) {
    onPhase?.('waiting');
    const waitCtrl = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      waitCtrl.abort();
    }, waitMs);
    const onUpstreamAbort = () => {
      cancelled = true;
      waitCtrl.abort();
    };
    if (signal !== undefined) {
      if (signal.aborted) onUpstreamAbort();
      else signal.addEventListener?.('abort', onUpstreamAbort, { once: true });
    }
    let waitStatus = 'idle-204';
    let waitEvidence = '';
    try {
      await client.wait(sessionId, { signal: waitCtrl.signal });
    } catch (err) {
      if (cancelled) waitStatus = 'aborted';
      else if (timedOut || (err instanceof GatewayHttpError && (err.kind === 'timeout' || err.kind === 'aborted'))) waitStatus = 'timeout';
      else {
        waitStatus = 'error';
        const mapped = mapError(err, REASON_CODES.SERVICE_UNREACHABLE);
        waitEvidence = mapped.evidence;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onUpstreamAbort);
    }
    const idleAt = waitStatus === 'idle-204' ? Date.now() : null;

    onPhase?.('receipt');
    let sessionNow = null;
    let messages = [];
    try {
      sessionNow = await client.getSession(sessionId);
    } catch (err) {
      const mapped = mapError(err, REASON_CODES.SERVICE_UNREACHABLE);
      return { waitStatus, waitEvidence, sessionNow: null, receipt: null, permissions: [], permissionsError: null, mapped };
    }
    try {
      messages = await client.messages(sessionId, { limit: 50, order: 'desc' });
    } catch {
      messages = [];
    }
    const receipt = buildReceipt({ session: sessionNow, messages, inboxId });
    // 权限清单只在"没成功"或"没等到 idle"时才值得多打一次请求（成功路径不给界面制造噪音数据）。
    let permissions = [];
    let permissionsError = null;
    if (receipt.outcome !== 'succeeded' || waitStatus !== 'idle-204') {
      try {
        permissions = await client.permissions(sessionId);
      } catch (err) {
        permissionsError = oneLine(err instanceof Error ? err.message : String(err));
      }
    }
    return { waitStatus, waitEvidence, sessionNow, receipt, permissions, permissionsError, mapped: null };
  }

  /** 回执 + 等待结论 → 归一原因（★ 判定顺序即纪律，改动前先读这段注释）。 */
  function judge({ waitStatus, waitEvidence, receipt, permissionRequests }) {
    // ① 待批审批最具体、最可行动（无论等没等到 idle，只要确实有待批就先说它）。
    if (permissionRequests.length > 0) return { ok: false, reason: REASON_CODES.APPROVAL_PENDING, evidence: `${permissionRequests.length} 条待批` };
    // ② 等待没收敛到 idle 时，**不许**拿 outcome 判成败：超时/取消一刻读到的 outcome
    //    可能是**上一轮**的残留（会话仍在跑）⇒ 拿旧回执冒充本轮 = 撒谎。如实报在途。
    if (waitStatus === 'aborted') return { ok: false, reason: REASON_CODES.WAIT_ABORTED, evidence: '' };
    if (waitStatus === 'error') return { ok: false, reason: REASON_CODES.SERVICE_UNREACHABLE, evidence: waitEvidence };
    if (waitStatus === 'timeout') return { ok: false, reason: REASON_CODES.WAIT_TIMEOUT, evidence: '' };
    // ③ 只有 idle-204（wait 亲口说会话已空闲）才用结构化 outcome 判成败。
    if (receipt !== null && receipt.outcome === 'succeeded') return { ok: true, reason: REASON_CODES.OK, evidence: '' };
    if (receipt !== null && receipt.outcome === 'failed') return { ok: false, reason: REASON_CODES.TASK_FAILED, evidence: receipt.finish ?? '' };
    if (receipt !== null && receipt.outcome === 'interrupted') return { ok: false, reason: REASON_CODES.TASK_INTERRUPTED, evidence: '' };
    return { ok: false, reason: REASON_CODES.RECEIPT_MISSING, evidence: '' };
  }

  /**
   * 回执**新鲜度**闸：只有 `idle-204`（wait 亲口说会话已空闲）才放行本轮回执字段。
   * 超时/取消/错误一刻读到的消息可能是**上一轮**的 —— reply/cost/outcome 一律不冒充本轮。
   * （model 例外：它是会话配置属性，不是某一轮的产物。）
   */
  function receiptView(receipt, waitStatus) {
    const fresh = waitStatus === 'idle-204' && receipt !== null && receipt !== undefined;
    return {
      outcome: fresh ? receipt.outcome : null,
      reply: fresh && typeof receipt.reply === 'string' ? receipt.reply : '',
      replyTruncated: fresh ? receipt.replyTruncated === true : false,
      tokens: fresh ? receipt.tokens : null,
      cost: fresh ? receipt.cost : null,
      model: receipt !== null && receipt !== undefined ? receipt.model : null,
    };
  }

  return {
    /**
     * 跑一轮下发（或只等待 -- waitOnly）。
     * @param {{prompt?: string, sessionKey?: string, sessionId?: string, resume?: boolean,
     *   waitOnly?: boolean, title?: string, model?: string, variant?: string, workspace?: string,
     *   delivery?: 'queue'|'steer', waitTimeoutMs?: number, signal?: AbortSignal}} args
     * @param {{onPhase?: (phase: string) => void}} [hooks]
     */
    async run(args = {}, hooks = {}) {
      const onPhase = hooks.onPhase;
      const cfg = resolveConfig() ?? {};
      if (cfg.enabled !== true) {
        return outcome({ ok: false, reason: REASON_CODES.DISABLED });
      }
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!args.waitOnly && prompt === '') {
        return outcome({ ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: '空 prompt' });
      }
      const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
      const delivery = args.delivery === 'steer' ? 'steer' : 'queue';
      const base = {
        sessionKey,
        promptExcerpt: promptExcerpt(prompt),
        delivery,
        fallbackReason: null,
        text: '',
      };

      onPhase?.('connecting');
      const connected = await connect();
      if (!connected.ok) {
        return outcome({ ...base, ok: false, reason: connected.reason, reasonEvidence: connected.reasonEvidence });
      }
      const { client, version } = connected;

      onPhase?.('resolving-session');
      let resolved;
      try {
        resolved = await resolveSession({ client, cfg, args });
      } catch (err) {
        const mapped = mapError(err, REASON_CODES.SERVICE_UNREACHABLE);
        return outcome({ ...base, ok: false, reason: mapped.code, reasonEvidence: mapped.evidence, version });
      }
      if (!resolved.ok) {
        return outcome({ ...base, ok: false, reason: resolved.reason, reasonEvidence: resolved.reasonEvidence, version });
      }

      let sessionId = resolved.sessionId;
      let sessionInfo = resolved.sessionInfo;
      const sessionOrigin = resolved.mode;
      const fallbackReason = resolved.fallbackReason;

      if (args.waitOnly) {
        if (sessionId === '') {
          return outcome({ ...base, ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: 'waitOnly 需要能解析出会话（session_id / session_key / 绑定）', version });
        }
      } else {
        if (sessionId === '') {
          onPhase?.('creating-session');
          const directory = typeof args.workspace === 'string' && args.workspace.trim() !== ''
            ? args.workspace.trim()
            : (typeof cfg.workspace === 'string' ? cfg.workspace.trim() : '');
          try {
            sessionInfo = await client.createSession({ title: deriveTitle(prompt, args.title), directory });
          } catch (err) {
            const mapped = mapError(err, REASON_CODES.SESSION_CREATE_FAILED);
            return outcome({ ...base, ok: false, reason: mapped.code, reasonEvidence: mapped.evidence, version });
          }
          sessionId = sessionInfo.id;
          if (sessionKey !== '') {
            sessions.adopt(sessionKey, {
              sessionId,
              cwd: typeof sessionInfo.location?.directory === 'string' ? sessionInfo.location.directory : directory,
              own: true,
              superseded: false,
              unconfirmed: false,
              lastUsedAt: Date.now(),
            });
          }
        }

        // ── ③ 模型 / ④ 档位 ──
        const wantModelText = typeof args.model === 'string' && args.model.trim() !== ''
          ? args.model.trim()
          : (typeof cfg.model === 'string' ? cfg.model.trim() : '');
        const wantVariant = typeof args.variant === 'string' && args.variant.trim() !== ''
          ? args.variant.trim()
          : (typeof cfg.variant === 'string' ? cfg.variant.trim() : '');
        let wantModel = null;
        if (wantModelText !== '' || wantVariant !== '') {
          if (wantModelText !== '') {
            wantModel = parseModelRef(wantModelText);
            if (wantModel === null) {
              return outcome({ ...base, ok: false, reason: REASON_CODES.MODEL_INVALID, reasonEvidence: `model=${wantModelText}（需 providerID/id）`, sessionId, sessionOrigin, fallbackReason, version });
            }
          } else {
            const cur = sessionInfo?.model;
            if (cur === null || typeof cur !== 'object' || typeof cur.id !== 'string' || typeof cur.providerID !== 'string') {
              return outcome({ ...base, ok: false, reason: REASON_CODES.MODEL_INVALID, reasonEvidence: `variant=${wantVariant} 但会话没有可挂的模型上下文`, sessionId, sessionOrigin, fallbackReason, version });
            }
            wantModel = { providerID: cur.providerID, id: cur.id };
          }
          if (wantVariant !== '') wantModel.variant = wantVariant;
          onPhase?.('setting-model');
          try {
            await client.setModel(sessionId, wantModel);
          } catch (err) {
            const mapped = mapError(err, REASON_CODES.MODEL_INVALID);
            const code = mapped.code === REASON_CODES.MODEL_INVALID && /variant/i.test(err?.bodyText ?? '')
              ? REASON_CODES.VARIANT_INVALID
              : mapped.code;
            return outcome({ ...base, ok: false, reason: code, reasonEvidence: mapped.evidence, sessionId, sessionOrigin, fallbackReason, version });
          }
          try {
            sessionInfo = await client.getSession(sessionId);
          } catch (err) {
            const mapped = mapError(err, REASON_CODES.SERVICE_UNREACHABLE);
            return outcome({ ...base, ok: false, reason: mapped.code, reasonEvidence: mapped.evidence, sessionId, sessionOrigin, fallbackReason, version });
          }
        }

        // ── ⑤ 任务下发 ──
        onPhase?.('prompting');
        let inboxId = '';
        try {
          const accepted = await client.prompt(sessionId, { text: prompt, delivery });
          inboxId = typeof accepted?.data?.id === 'string' ? accepted.data.id : '';
        } catch (err) {
          const mapped = mapError(err, REASON_CODES.PROMPT_REJECTED);
          return outcome({ ...base, ok: false, reason: mapped.code, reasonEvidence: mapped.evidence, sessionId, sessionOrigin, fallbackReason, version });
        }
        const acceptedAt = Date.now();

        // ── ⑦ 等待 + 回执 ──
        const waitMs = clampWaitMs(typeof args.waitTimeoutMs === 'number' ? args.waitTimeoutMs : cfg.waitTimeoutMs);
        const waited = await waitAndReceipt({ client, sessionId, inboxId, waitMs, signal: args.signal, onPhase });
        if (waited.sessionNow === null && waited.receipt === null) {
          const mapped = waited.mapped ?? { code: REASON_CODES.SERVICE_UNREACHABLE, evidence: '' };
          return outcome({
            ...base, ok: false, reason: mapped.code, reasonEvidence: mapped.evidence,
            sessionId, sessionOrigin, fallbackReason, version, acceptedAt, waitStatus: waited.waitStatus,
          });
        }
        const permissionRequests = waited.permissions.map(normalizePermissionRequest);
        const verdict = judge({ waitStatus: waited.waitStatus, waitEvidence: waited.waitEvidence, receipt: waited.receipt, permissionRequests });
        if (verdict.ok && sessionKey !== '') sessions.touch(sessionKey);
        const view = receiptView(waited.receipt, waited.waitStatus);
        return outcome({
          ...base,
          ok: verdict.ok,
          reason: verdict.reason,
          reasonEvidence: verdict.evidence,
          text: view.reply,
          sessionId,
          sessionOrigin,
          fallbackReason,
          resumed: sessionOrigin === 'resumed' || sessionOrigin === 'bound' || sessionOrigin === 'explicit',
          model: view.model,
          acceptedAt,
          idleAt: waited.idleAt,
          waitStatus: waited.waitStatus,
          outcome: view.outcome,
          reply: view.reply,
          replyTruncated: view.replyTruncated,
          cost: view.cost,
          tokens: view.tokens,
          permissionRequests,
          permissionsError: waited.permissionsError,
          version,
        });
      }

      // waitOnly 路径：不 prompt，直接等/取现状。
      const waitMs = clampWaitMs(typeof args.waitTimeoutMs === 'number' ? args.waitTimeoutMs : cfg.waitTimeoutMs);
      const waited = await waitAndReceipt({ client, sessionId, inboxId: '', waitMs, signal: args.signal, onPhase });
      if (waited.sessionNow === null && waited.receipt === null) {
        const mapped = waited.mapped ?? { code: REASON_CODES.SERVICE_UNREACHABLE, evidence: '' };
        return outcome({
          ...base, ok: false, reason: mapped.code, reasonEvidence: mapped.evidence,
          sessionId, sessionOrigin, fallbackReason, version, waitStatus: waited.waitStatus,
        });
      }
      const permissionRequests = waited.permissions.map(normalizePermissionRequest);
      const verdict = judge({ waitStatus: waited.waitStatus, waitEvidence: waited.waitEvidence, receipt: waited.receipt, permissionRequests });
      const view = receiptView(waited.receipt, waited.waitStatus);
      return outcome({
        ...base,
        ok: verdict.ok,
        reason: verdict.reason,
        reasonEvidence: verdict.evidence,
        text: view.reply,
        sessionId,
        sessionOrigin,
        fallbackReason,
        resumed: true,
        model: view.model,
        idleAt: waited.idleAt,
        waitStatus: waited.waitStatus,
        outcome: view.outcome,
        reply: view.reply,
        replyTruncated: view.replyTruncated,
        cost: view.cost,
        tokens: view.tokens,
        permissionRequests,
        permissionsError: waited.permissionsError,
        version,
      });
    },

    /** 列出某会话的待批权限请求（审批面之「列」）。 */
    async listApprovals({ sessionKey = '', sessionId = '' } = {}) {
      const cfg = resolveConfig() ?? {};
      const connected = await connect();
      if (!connected.ok) return { ok: false, reason: connected.reason, reasonEvidence: connected.reasonEvidence, sessionId: '', items: [] };
      const target = resolveTargetSession({ cfg, sessionKey, sessionId, sessions });
      if (target === '') return { ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: '给一个能解析出会话的 session_key / session_id（或先在设置里绑定）', sessionId: '', items: [] };
      try {
        const raw = await connected.client.permissions(target);
        return { ok: true, reason: REASON_CODES.OK, reasonEvidence: '', sessionId: target, items: raw.map(normalizePermissionRequest) };
      } catch (err) {
        // 404 = 会话不存在（删除后仍在问它的待批 = 说会话没了，不是"服务不可达"）。
        if (err instanceof GatewayHttpError && err.status === 404) {
          return { ok: false, reason: REASON_CODES.SESSION_NOT_FOUND, reasonEvidence: `HTTP 404 ${err.path}`, sessionId: target, items: [] };
        }
        const mapped = mapError(err, REASON_CODES.SERVICE_UNREACHABLE);
        return { ok: false, reason: mapped.code, reasonEvidence: mapped.evidence, sessionId: target, items: [] };
      }
    },

    /** 回复一条权限请求（审批面之「回」）。`waitMs>0` ⇒ 回复后继续等并取回执。 */
    async replyApproval({ sessionKey = '', sessionId = '', requestId = '', decision = '', message = '', waitMs = 0, signal } = {}) {
      if (!['once', 'always', 'reject'].includes(decision)) {
        return { ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: `decision=${decision}（合法：once|always|reject）` };
      }
      if (typeof requestId !== 'string' || requestId.trim() === '') {
        return { ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: '缺少 request_id' };
      }
      const cfg = resolveConfig() ?? {};
      const connected = await connect();
      if (!connected.ok) return { ok: false, reason: connected.reason, reasonEvidence: connected.reasonEvidence };
      const target = resolveTargetSession({ cfg, sessionKey, sessionId, sessions });
      if (target === '') return { ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: '给一个能解析出会话的 session_key / session_id（或先在设置里绑定）' };
      try {
        await connected.client.replyPermission(target, requestId.trim(), { decision, message });
      } catch (err) {
        // [实测] 对不存在/已回复的请求回复 ⇒ 404 `PermissionNotFoundError` —— 说"请求没了"，
        // 不说"服务不可达"（归因失真会把排障引到错误方向）。
        if (err instanceof GatewayHttpError && err.status === 404) {
          return { ok: false, reason: REASON_CODES.APPROVAL_NOT_FOUND, reasonEvidence: `HTTP 404 ${err.path}`, sessionId: target };
        }
        const mapped = mapError(err, REASON_CODES.APPROVAL_REPLY_REJECTED);
        return { ok: false, reason: mapped.code, reasonEvidence: mapped.evidence, sessionId: target };
      }
      const result = { ok: true, reason: REASON_CODES.OK, reasonEvidence: '', sessionId: target, decision, receipt: null, waitStatus: 'n/a', itemsAfter: [] };
      if (typeof waitMs === 'number' && waitMs > 0) {
        const waited = await waitAndReceipt({ client: connected.client, sessionId: target, inboxId: '', waitMs: clampWaitMs(waitMs), signal });
        if (waited.sessionNow !== null && waited.receipt !== null) {
          const verdict = judge({ waitStatus: waited.waitStatus, waitEvidence: waited.waitEvidence, receipt: waited.receipt, permissionRequests: [] });
          const view = receiptView(waited.receipt, waited.waitStatus);
          result.receipt = {
            outcome: view.outcome,
            reply: view.reply,
            replyTruncated: view.replyTruncated,
            cost: view.cost,
            tokens: view.tokens,
            model: view.model,
          };
          result.waitStatus = waited.waitStatus;
          result.ok = verdict.ok;
          result.reason = verdict.reason;
          result.reasonText = REASON_TEXT[verdict.reason] ?? '';
          result.reasonEvidence = redact(oneLine(verdict.evidence));
        }
      }
      try {
        const raw = await connected.client.permissions(target);
        result.itemsAfter = raw.map(normalizePermissionRequest);
      } catch {
        result.itemsAfter = [];
      }
      return result;
    },

    /** 清理：默认只清本插件记性；remote:true ⇒ 连同服务端会话**硬删**（DELETE 204）。 */
    async purge({ sessionKey = '', sessionId = '', remote = false } = {}) {
      const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
      const record = key !== '' ? sessions.lookup(key) : null;
      let target = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (target === '' && record !== null && typeof record?.sessionId === 'string') target = record.sessionId;
      const forgot = key !== '' ? sessions.forget(key) : false;
      if (target === '') {
        if (forgot) return { ok: true, reason: REASON_CODES.OK, reasonEvidence: '', sessionId: '', deleted: false, forgot: true };
        return { ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: '给 session_id（要删服务端会话）或 session_key（清记性；有记性才能解析出会话）' };
      }
      if (!SESSION_ID_PATTERN.test(target)) {
        return { ok: false, reason: REASON_CODES.BAD_ARGS, reasonEvidence: `session_id 形态非法：${target}` };
      }
      if (remote !== true) {
        return { ok: true, reason: REASON_CODES.OK, reasonEvidence: '', sessionId: target, deleted: false, forgot };
      }
      const connected = await connect();
      if (!connected.ok) return { ok: false, reason: connected.reason, reasonEvidence: connected.reasonEvidence, sessionId: target, deleted: false, forgot };
      try {
        await connected.client.deleteSession(target);
      } catch (err) {
        if (err instanceof GatewayHttpError && err.status === 404) {
          return { ok: true, reason: REASON_CODES.OK, reasonEvidence: 'already-gone', sessionId: target, deleted: false, forgot };
        }
        const mapped = mapError(err, REASON_CODES.SERVICE_UNREACHABLE);
        return { ok: false, reason: mapped.code, reasonEvidence: mapped.evidence, sessionId: target, deleted: false, forgot };
      }
      return { ok: true, reason: REASON_CODES.OK, reasonEvidence: '', sessionId: target, deleted: true, forgot };
    },

    /** 模型清单（状态卡/工具面共用；30s TTL 防卡片轮询打服务）。 */
    async models() {
      const now = Date.now();
      if (catalogCache.value !== null && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
      const connected = await connect();
      if (!connected.ok) {
        return { ok: false, reason: connected.reason, reasonEvidence: connected.reasonEvidence, models: [], source: 'none' };
      }
      try {
        const models = await connected.client.models();
        const value = { ok: true, reason: REASON_CODES.OK, reasonEvidence: '', models, source: connected.conn.baseUrl };
        catalogCache.at = now;
        catalogCache.value = value;
        return value;
      } catch (err) {
        const mapped = mapError(err, REASON_CODES.SERVICE_UNREACHABLE);
        return { ok: false, reason: mapped.code, reasonEvidence: mapped.evidence, models: [], source: 'none' };
      }
    },

    /** 诊断快照（诊断路由用；逐项留痕，不猜）。 */
    async inspect() {
      const cfg = resolveConfig() ?? {};
      const checks = [];
      checks.push({ id: 'config', ok: cfg.enabled === true, detail: `enabled=${cfg.enabled === true}` });
      const conn = service.resolveConnection(env());
      checks.push({
        id: 'service-json',
        ok: conn.ok,
        detail: conn.ok ? `${conn.authLine} @ ${conn.baseUrl}` : `${conn.reason} @ ${conn.servicePath === '' ? '(no candidate)' : conn.servicePath}`,
      });
      if (conn.ok) {
        try {
          const info = await createOpencodeClient(
            { baseUrl: conn.baseUrl, password: conn.password },
            { fetchImpl, redact: (s) => redact(s, [conn.password]) },
          ).info();
          checks.push({ id: 'http-info', ok: true, detail: `version=${info?.version ?? 'unknown'} pid=${info?.pid ?? 'unknown'}` });
        } catch (err) {
          const mapped = mapError(err, REASON_CODES.SERVICE_UNREACHABLE);
          checks.push({ id: 'http-info', ok: false, detail: `${mapped.code} · ${mapped.evidence}` });
        }
      }
      const probeState = typeof runtime?.probeState === 'function' ? runtime.probeState() : null;
      if (probeState !== null) {
        checks.push({
          id: 'probe',
          ok: probeState.status === 'done' ? probeState.result?.installed === true : false,
          detail: `status=${probeState.status} reason=${probeState.result?.reason ?? '(pending)'}`,
        });
      }
      return { ok: checks.every((c) => c.ok), checks, at: Date.now() };
    },
  };
}

/** 解析审批/清理的目标会话（bound > 显式 > 记性；与 run 的优先级保持同序）。 */
function resolveTargetSession({ cfg, sessionKey, sessionId, sessions }) {
  const explicit = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (explicit !== '' && SESSION_ID_PATTERN.test(explicit)) return explicit;
  const bound = typeof cfg.boundSessionId === 'string' ? cfg.boundSessionId.trim() : '';
  if (bound !== '' && SESSION_ID_PATTERN.test(bound)) return bound;
  const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (key !== '') {
    const record = sessions.lookup(key);
    if (record !== null && typeof record?.sessionId === 'string' && SESSION_ID_PATTERN.test(record.sessionId)) return record.sessionId;
  }
  return '';
}
