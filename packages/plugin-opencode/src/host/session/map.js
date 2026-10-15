/**
 * 会话映射（session key → opencode 会话 ID）—— plugin-opencode 版（精简重写，2026-10-15）。
 *
 * 通道事实出处：`00-recon/OPENCODE-LOCAL-RECON-20261015.md`
 *   - §2 / §11.1：会话由 `POST /api/session` 创建，`Session.Info.id` 即 `ses_…`；外部客户端建的
 *     会话同时出现在桌面端侧栏与全局 SSE ⇒ **复用 = 直接对同一 sessionID 发 prompt**（无需任何
 *     命令行参数），且这条对话在桌面 UI 里始终看得见（§11 样本 `ses_ec039b26effeFSRxqFRSQfPfba`）。
 *   - §11（形状核验）：`DELETE /api/session/{id}` → 204、随后 GET 404 = **硬删**（purge 工具语义）。
 * 形状契约：`src/host/types/index.js`（`SessionSummaryRow`）/ `src/shared/constants.js`
 *   （`SESSION_ID_PATTERN` = 唯一 ID 判据）/ `src/host/config/schema.js`（`sessions` 落盘位，volatile）。
 *
 * ★ 与 plugin-workbuddy 同名文件（878 行，CLI 时代）的关系：**只保留"记性"这一件事**，
 *   并刻意**不移植**已随通道消失的语义（错了比缺了更难查）：
 *     - 没有 stream-json 帧解析、没有"从输出文本里抽 id" —— 这里的 id 全部来自 HTTP 回执；
 *     - 没有"error 帧 / 会话不存在"的文本判据 —— opencode 的失败是 HTTP 状态码 +
 *       `Session.Info.outcome`，由**观测到它的调用方**调 `supersede` 或 `touch({unconfirmed:true})`
 *       落成状态位；本模块不猜文本（也就不用背一条臆造正则的债）。
 *     - 没有 `createdAt`（本轮没有消费者；要加须与 types/设置面一起改）。
 *
 * ★ 落盘通道（沿用 workbuddy 的实测契约）：`settings.update(NS, { sessions: { <key>: patch } })`
 *   —— 普通对象补丁**深度合并**进用户层 ⇒ 补丁里**省略**的字段保留旧值。由此两条硬纪律：
 *     ① 布尔键（`own`/`superseded`/`unconfirmed`）**必须显式给值**，绝不能"只在为真时才带"：
 *        省略 = 保留旧值 ⇒ 一次正常复用洗不掉上一轮的判死位 ⇒ 一条健康的会话被永久判死；
 *     ② 写入前必须 `sanitizeRecord`（坏类型字段直接丢弃）：一条坏记录不该拖垮整份 namespace 校验。
 *   `update` 是 async 且失败**不得**阻塞作业收敛：异步提交 + 记账（`persistence().failures`）。
 *
 * ★ 诚实边界（别把本文件当成"服务端还留着这条会话"的承诺）：
 *   - 记录只说明"这个 key 曾经用过这个 sessionID"。用户可在桌面端硬删它（§11 形状核验）⇒ **每个消费者
 *     都必须能承受"记着但 404"**（404 的处理是调用方的事，落点 = `supersede`/`unconfirmed`）。
 *   - `cwd` 只作**记录**（建会话时带过的 location），不参与复用决策 —— 复用只下发 prompt，
 *     会话保持它自己的目录（schema.js `workspace` 同款措辞）。
 *   - `adopt` 是**先写胜出**：已有可续接记录不被覆盖；要换 id 必须先 `supersede`/`forget`/`purge`。
 *   - 本模块**不建会话、不下发、不删服务端对话**（那是 gateway / 工具面的事，各管一段）。
 *
 * 约束：本文件属于 packages/plugin-opencode/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { SESSION_ID_PATTERN } from '../../shared/constants.js';

/** 记性窗口：内存里最多保留多少条会话（超出按 `lastUsedAt` 淘汰最旧；防止长进程里无限膨胀）。 */
export const SESSION_RETENTION = 200;

/** 会话摘要回传上限（状态路由 / `opencode_status` 工具面共用）。 */
export const SESSION_SUMMARY_LIMIT = 20;

/** 启动清理的默认时间窗（7 天没人用过 = 视为遗留；见 `sweepOwnSessions`）。 */
const SWEEP_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** 非空字符串（session key 的唯一合法性判据；空 key 一律当场拒绝，不猜）。 */
const isKey = (key) => typeof key === 'string' && key !== '';

/** 错误 → 单行文本（记账字段永远是字符串，别把 Error 塞进去）。 */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * 会话 ID 形态判据（唯一真源 = `constants.SESSION_ID_PATTERN`，本地**不另写**一份正则）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/**
 * 记录净化：只保留 schema 认得的字段且类型正确。
 *
 * 为什么必须在**写入前**做：写入会被 schemastery 校验，坏类型可能让整份 namespace 提交被拒
 * （workbuddy 真机逐字：`$.sessions.u-1.cliSessionId expected string | Schema<const> but got 42`）
 * ⇒ 宁可丢字段，也不让一次坏写入连带拒掉用户其它设置。
 *
 * ★ 布尔键照原样保留（含 `false`）：`settings.update` 是深度合并，`false` 是"清真"，不是"没给"。
 *
 * @param {{ sessionId?: unknown, cwd?: unknown, lastUsedAt?: unknown, outputBytes?: unknown,
 *           own?: unknown, superseded?: unknown, unconfirmed?: unknown }} record
 * @returns {object} 净化后的记录（可能不含某些字段）
 */
export function sanitizeRecord(record) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (isValidSessionId(record?.sessionId)) out.sessionId = record.sessionId;
  if (typeof record?.cwd === 'string' && record.cwd !== '') out.cwd = record.cwd;
  if (Number.isFinite(record?.lastUsedAt)) out.lastUsedAt = Number(record.lastUsedAt);
  if (Number.isSafeInteger(record?.outputBytes) && record.outputBytes >= 0) out.outputBytes = record.outputBytes;
  if (typeof record?.own === 'boolean') out.own = record.own;
  if (typeof record?.superseded === 'boolean') out.superseded = record.superseded;
  if (typeof record?.unconfirmed === 'boolean') out.unconfirmed = record.unconfirmed;
  return out;
}

/**
 * 记录 → 内存态归一（缺省 `null`/`0`/`false`，不猜；settings 里的老记录/手改记录都经这里收敛）。
 * @param {any} value
 */
function normalize(value) {
  return {
    sessionId: isValidSessionId(value?.sessionId) ? value.sessionId : null,
    cwd: typeof value?.cwd === 'string' && value.cwd !== '' ? value.cwd : null,
    lastUsedAt: Number.isFinite(value?.lastUsedAt) ? Number(value.lastUsedAt) : 0,
    outputBytes: Number.isSafeInteger(value?.outputBytes) && value.outputBytes >= 0 ? value.outputBytes : 0,
    own: value?.own === true,
    superseded: value?.superseded === true,
    unconfirmed: value?.unconfirmed === true,
  };
}

/**
 * 视图记录 → 可写补丁（**显式**带上全部字段，含 `false`）。
 * 为什么不让调用方各写一遍：深度合并下"省略 = 保留旧值"，漏带一个布尔键就等于放进一条粘滞状态。
 * @param {ReturnType<typeof normalize>} record
 */
function recordPatch(record) {
  return {
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    lastUsedAt: record.lastUsedAt,
    outputBytes: record.outputBytes,
    own: record.own === true,
    superseded: record.superseded === true,
    unconfirmed: record.unconfirmed === true,
  };
}

/**
 * "按记录能不能下发复用"的**唯一判据**（`sessionSummary` 的 `state` 与 `resumable()` 共用）。
 * 两个条件缺一不可：① id 形态合法（`SESSION_ID_PATTERN`）；② 未被判死（`superseded`/`unconfirmed`）。
 *
 * 为什么收成一个纯函数：两处判据一旦漂移，UI 与下发力就会互相矛盾（UI 说能续、run 却另开一条）。
 * 注意它**只能**表达"按记录可下发"，**不构成**"服务端一定还有这条会话"（硬删随时可能发生）。
 *
 * @param {{ sessionId?: unknown, superseded?: unknown, unconfirmed?: unknown }|null|undefined} record
 * @returns {boolean}
 */
export function isResumableRecord(record) {
  if (!isValidSessionId(record?.sessionId)) return false;
  return record?.superseded !== true && record?.unconfirmed !== true;
}

/**
 * 不可复用的**稳定原因码**（`''` = 可复用）。取值域与 `types/index.js` 的
 * `SessionSummaryRow.state` 对齐：`'superseded' | 'unconfirmed' | 'untracked'`（另有 `'unknown'` 兜底）。
 * `'untracked'` = 记着这个 key，但没有形态合法的会话 id（对应 workbuddy 时代的 `no_session_id`）。
 *
 * @param {{ sessionId?: unknown, superseded?: unknown, unconfirmed?: unknown }|null|undefined} record
 * @returns {string}
 */
export function unresumableCode(record) {
  if (isResumableRecord(record)) return '';
  // 顺序即语义：用户/调用方显式替代 > 服务端侧已证不可用 > 压根没有可用 id。
  if (record?.superseded === true) return 'superseded';
  if (record?.unconfirmed === true) return 'unconfirmed';
  if (!isValidSessionId(record?.sessionId)) return 'untracked';
  return 'unknown';
}

/**
 * 会话映射的**只读摘要**（按 `lastUsedAt` 倒序 + 条数封顶）—— 状态路由与工具面共用一份判定。
 * 行形状 = `types/index.js` 的 `SessionSummaryRow`：`{sessionKey, sessionId, lastUsedAt, own, state}`。
 *
 * 刻意**不**扩散 `cwd`（本机路径信息，非展示所必需）：需要目录的是新建会话那条路，不是状态面。
 *
 * @param {{ list?: () => any[] }|null|undefined} sessions `loadSessionMap` 的返回面
 * @param {number} [limit]
 * @returns {Array<{ sessionKey: string, sessionId: string, lastUsedAt: number, own: boolean, state: string }>}
 */
export function sessionSummary(sessions, limit = SESSION_SUMMARY_LIMIT) {
  if (sessions === null || sessions === undefined || typeof sessions.list !== 'function') return [];
  let rows;
  try {
    rows = sessions.list();
  } catch {
    return []; // 记性读失败不得把整个状态查询带崩
  }
  const max = Number.isSafeInteger(limit) && limit >= 0 ? limit : SESSION_SUMMARY_LIMIT;
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      sessionKey: typeof r?.key === 'string' ? r.key : '',
      sessionId: isValidSessionId(r?.sessionId) ? r.sessionId : '',
      lastUsedAt: Number.isFinite(r?.lastUsedAt) ? Number(r.lastUsedAt) : 0,
      own: r?.own === true,
      // 判据单一来源：可复用 ⇒ 'resumable'，否则逐字用原因码（不允许在这里另写一套判断）
      state: unresumableCode(r) || 'resumable',
    }))
    .filter((r) => r.sessionKey !== '')
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, max);
}

/**
 * 启动清理：扫**本插件自建**（`own:true`）的陈旧遗留，标 `superseded`（只打标记，**不删**记录）。
 *
 * 语义（保守，避免误杀正在复用的会话）：
 *   - 只看 `own === true` 的记录 —— 用户自己建的对话、以及未标记 own 的记录一律不动（不猜）；
 *   - `opts.boundSessionId` / `opts.protectSessionIds` 指向的会话**绝不回收**（人指定的压过自动的，
 *     与 `schema.js boundSessionId` 的优先级同一条纪律）；
 *   - 已判死的（`superseded`/`unconfirmed`）只计数，不再动；
 *   - 活记录里两类算陈旧：① 超过 `opts.maxAgeMs`（默认 7 天）没人用过；
 *     ② 给了 `opts.maxCount` 时，own 活记录超出这个条数的**最旧**那些（"每人最多留 N 条自建会话"）。
 *
 * 为什么标记而不是删除：服务端会话是用户的资产（可能还在桌面端开着），本模块只有"别再自动用它"
 * 这个最小权限；真要删由 `opencode_purge` 显式做（那道闸是人的意图）。
 *
 * @param {{ list: () => any[], supersede: (k: string, reason?: string) => any }} api `loadSessionMap` 的返回面（子集即可）
 * @param {{ now?: number, maxAgeMs?: number, maxCount?: number,
 *           boundSessionId?: string, protectSessionIds?: string[] }} [opts]
 * @returns {{ scanned: number, own: number, swept: string[], kept: string[], dead: string[], protected: string[] }}
 */
export function sweepOwnSessions(api, opts = {}) {
  const now = Number.isFinite(opts.now) && opts.now > 0 ? Number(opts.now) : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs >= 0 ? Number(opts.maxAgeMs) : SWEEP_MAX_AGE_MS;
  const maxCount = Number.isSafeInteger(opts.maxCount) && opts.maxCount >= 0 ? opts.maxCount : null;
  const protect = new Set();
  if (typeof opts.boundSessionId === 'string' && opts.boundSessionId !== '') protect.add(opts.boundSessionId);
  if (Array.isArray(opts.protectSessionIds)) {
    for (const id of opts.protectSessionIds) if (typeof id === 'string' && id !== '') protect.add(id);
  }

  const out = { scanned: 0, own: 0, swept: [], kept: [], dead: [], protected: [] };
  let rows;
  try {
    rows = typeof api?.list === 'function' ? api.list() : [];
  } catch {
    return out; // 记性读失败 = 本轮不清理（下次启动再扫），绝不带崩装配
  }
  if (!Array.isArray(rows)) return out;
  out.scanned = rows.length;

  /** @type {Array<{ key: string, lastUsedAt: number }>} */
  const live = [];
  for (const r of rows) {
    const key = typeof r?.key === 'string' ? r.key : '';
    if (key === '' || r?.own !== true) continue;
    out.own += 1;
    if (isValidSessionId(r?.sessionId) && protect.has(r.sessionId)) { out.protected.push(key); continue; }
    if (r?.superseded === true || r?.unconfirmed === true) { out.dead.push(key); continue; }
    live.push({ key, lastUsedAt: Number.isFinite(r?.lastUsedAt) ? Number(r.lastUsedAt) : 0 });
  }

  const stale = new Set(live.filter((e) => now - e.lastUsedAt > maxAgeMs).map((e) => e.key));
  if (maxCount !== null && live.length > maxCount) {
    // 条数窗：留下最新的 maxCount 条，其余（更旧的）一并算陈旧。平票时按 list() 顺序稳定排序。
    const newest = [...live].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, maxCount);
    const keep = new Set(newest.map((e) => e.key));
    for (const e of live) if (!keep.has(e.key)) stale.add(e.key);
  }

  for (const e of live) {
    if (!stale.has(e.key)) { out.kept.push(e.key); continue; }
    try {
      api.supersede(e.key, 'sweep-stale-own');
    } catch { /* 标记失败 = 下次启动再扫，不挡装配 */ }
    out.swept.push(e.key);
  }
  return out;
}

/**
 * 装配一份会话映射的读写面。
 *
 * @param {object} ctx 宿主 ctx（`ctx.get('settings')` 可能缺席 —— 缺省必须能跑，见 SKILL 的缺省检查）
 * @param {string} ns settings namespace（= 包名；`settings.update()` 的行 id 必须与它一致）
 * @returns {{
 *   read: (key: string) => object|null,
 *   lookup: (key: string) => object|null,
 *   resumable: (key: string) => { sessionId: string, cwd: string|null }|null,
 *   adopt: (key: string, record: object) => object,
 *   touch: (key: string, patch?: object) => object,
 *   supersede: (key: string, reason?: string) => object,
 *   forget: (key: string, reason?: string) => object,
 *   purge: (key: string) => object,
 *   list: () => any[],
 *   summary: (limit?: number) => any[],
 *   persistence: () => object,
 *   settled: () => Promise<object>,
 * }}
 */
export function loadSessionMap(ctx, ns) {
  /** 内存态（本进程内的最新知识）；settings 是冷启动/重载后的来源。 */
  const memory = new Map();
  /** 落盘记账（如实暴露；"会话悄悄恢复不了"这件事必须能被看见）。 */
  const persistenceState = {
    attempts: 0, ok: 0, failures: 0, lastError: '', noop: 0, pending: 0,
    /** 最近一次**失败**的结构化留痕（成功不清除：有过失败本身就是要暴露的事实）。 */
    lastFailure: null,
  };

  const settingsService = () => {
    const svc = ctx?.get?.('settings');
    return svc === undefined || svc === null ? null : svc;
  };

  /**
   * settings 用户层里的 `sessions`（键 → 记录）。
   * 0.1.7 起 `settings.get(ns)` 已移除 ⇒ 唯一读法是扫 `describe()` 的行（每行 `{ns, value, …}`）。
   * 读失败/形状异常一律当"没读到"（`{}`）：记性读失败不该把调用方带崩。
   */
  const persistedSessions = () => {
    const svc = settingsService();
    if (svc === null || typeof svc.describe !== 'function') return {};
    let rows;
    try {
      rows = svc.describe();
    } catch {
      return {};
    }
    if (!Array.isArray(rows)) return {};
    const row = rows.find((r) => r !== null && typeof r === 'object' && r.ns === ns);
    const sessions = row?.value?.sessions;
    return typeof sessions === 'object' && sessions !== null ? sessions : {};
  };

  /**
   * 提交一条补丁（深度合并 ⇒ 只发增量字段）。返回值让**调用方**看得见这次写盘的结果：
   *   `'noop'`      —— 没有提交任何东西（没有 settings 服务 ⇒ 本进程内可续接但重启后丢失）；
   *   `'failed'`    —— **同步**抛出 ⇒ 此刻就知道写不进去（成因在 `persistError`）；
   *   `'pending'`   —— 已交给 settings，成败等 Promise 收敛（异步失败经 `settled()`/`persistence()` 暴露）；
   *   `'attempted'` —— 同上，且此刻已收敛为成功。
   */
  function persist(key, patch) {
    const svc = settingsService();
    if (svc === null || typeof svc.update !== 'function') {
      persistenceState.noop += 1;
      persistenceState.lastError = 'settings.update unavailable';
      return { persistState: 'noop', persistError: 'settings.update unavailable' };
    }
    persistenceState.attempts += 1;
    persistenceState.pending += 1;
    let result;
    try {
      result = svc.update(ns, { sessions: { [key]: patch } });
    } catch (err) {
      const message = messageOf(err);
      persistenceState.pending -= 1;
      persistenceState.failures += 1;
      persistenceState.lastError = message;
      persistenceState.lastFailure = { key, error: message, at: Date.now() };
      return { persistState: 'failed', persistError: message };
    }
    if (result === null || typeof result?.then !== 'function') {
      // 返回非 thenable（同步完成）⇒ 此刻就能给出确定结论。
      persistenceState.pending -= 1;
      persistenceState.ok += 1;
      return { persistState: 'attempted', persistError: '' };
    }
    void Promise.resolve(result).then(
      () => {
        persistenceState.pending -= 1;
        persistenceState.ok += 1;
      },
      (err) => {
        const message = messageOf(err);
        persistenceState.pending -= 1;
        persistenceState.failures += 1;
        persistenceState.lastError = message;
        persistenceState.lastFailure = { key, error: message, at: Date.now() };
        // 双通道可见：① 日志（若宿主有 logger）；② 上面的记账字段（不依赖宿主能力）。
        ctx?.logger?.warn?.(`[plugin-opencode] session map 落盘失败（${key}）：${message}`);
      },
    );
    return { persistState: 'pending', persistError: '' };
  }

  /** 内存写入（含窗口淘汰：超出 SESSION_RETENTION 就按 `lastUsedAt` 淘汰最旧，平票按写入顺序）。 */
  function remember(key, record) {
    memory.set(key, normalize(record));
    if (memory.size <= SESSION_RETENTION) return;
    const oldest = [...memory.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (let i = 0; i < oldest.length - SESSION_RETENTION; i += 1) memory.delete(oldest[i][0]);
  }

  /** settings / 内存记录 → 只读视图（`key` + 归一字段）。 */
  const view = (key, value) => ({ key, ...normalize(value) });

  /** adopt 的拒绝形态（`reason` 是稳定机器码；`sessionId` 空 = 没有可回报的既有 id）。 */
  const refusedAdopt = (reason) => ({
    ok: false, adopted: false, sessionId: '', reason, persistState: 'noop', persistError: '',
  });

  const api = {
    /**
     * 记录原样视图（含历史 id 与判死位）；没有记录 ⇒ `null`（不猜）。
     * 优先级 = **内存优先**（本进程刚写的知识最新；settings 层写入是异步的，刚写完就读会被旧值骗）。
     */
    read(key) {
      if (!isKey(key)) return null;
      const local = memory.get(key);
      if (local !== undefined) return view(key, local);
      const stored = persistedSessions()[key];
      if (stored === null || typeof stored !== 'object') return null; // 不是记录（用户手改坏）⇒ 当没记过
      return view(key, stored);
    },

    /**
     * "这个 key 记着一条**形态合法**的会话 id 吗"（唯一判据 = `SESSION_ID_PATTERN`）。
     * 没有记录 / id 不合法 ⇒ `null`；已判死的记录**照实返回**（历史可查）——
     * "能不能续接"是 `resumable()` 的问题，两个问题不合并。
     */
    lookup(key) {
      const record = api.read(key);
      return record !== null && isValidSessionId(record.sessionId) ? record : null;
    },

    /** 可复用的会话（id 合法 且 未判死）；否则 `null`。判据 = `isResumableRecord`（不允许与摘要面漂移）。 */
    resumable(key) {
      const record = api.lookup(key);
      if (record === null || !isResumableRecord(record)) return null;
      return { sessionId: record.sessionId, cwd: record.cwd };
    },

    /**
     * 收下一条会话 id（来源 = **HTTP 回执**：`POST /api/session` 的 `id`，或用户绑定的那条）。
     *
     * ★ 先写胜出：已有**可续接**记录时不被覆盖 —— 要换 id 必须先 `supersede`/`forget`/`purge`。
     *   - 同一个 id 重复 adopt = 幂等 no-op（`ok:true, adopted:false`，不写盘）；
     *   - 不同 id = 拒绝（`ok:false, reason:'first-write-wins'`，`sessionId` 回既有那条，让分歧可见）。
     *   记录已判死（`superseded`/`unconfirmed`）⇒ 允许接管，并把两个位**显式清真**（深度合并下必须写 `false`）。
     *
     * @param {string} key
     * @param {{ sessionId: unknown, cwd?: unknown, own?: unknown }} record
     *        `own:true` = 本插件自建（可被启动清理回收）；粘滞：任一轮标过就一直算自建。
     * @returns {{ ok: boolean, adopted: boolean, sessionId: string, reason: string,
     *             persistState: string, persistError: string }}
     */
    adopt(key, record) {
      if (!isKey(key)) return refusedAdopt('empty-session-key');
      const sessionId = record?.sessionId;
      if (!isValidSessionId(sessionId)) return refusedAdopt('malformed-session-id');
      const previous = api.read(key);
      if (previous !== null && isResumableRecord(previous)) {
        if (previous.sessionId === sessionId) {
          return {
            ok: true, adopted: false, sessionId, reason: 'already-recorded', persistState: 'noop', persistError: '',
          };
        }
        return {
          ok: false, adopted: false, sessionId: previous.sessionId, reason: 'first-write-wins',
          persistState: 'noop', persistError: '',
        };
      }
      const patch = sanitizeRecord({
        sessionId,
        cwd: typeof record?.cwd === 'string' && record.cwd !== '' ? record.cwd : (previous?.cwd ?? undefined),
        lastUsedAt: Date.now(),
        // adopt 只知道 id，**没有**本轮的字节数 ⇒ 写 0（沿用上一轮会造出"这一轮也产出了那么多"的假记录）。
        outputBytes: 0,
        own: record?.own === true || previous?.own === true,
        superseded: false,
        unconfirmed: false,
      });
      remember(key, patch);
      const outcome = persist(key, patch);
      return {
        ok: true, adopted: true, sessionId, reason: '',
        persistState: outcome.persistState, persistError: outcome.persistError,
      };
    },

    /**
     * 只推进**已有**记录的热度（会话没换、同一条对话刚被用过 ⇒ 更新 `lastUsedAt`；`sweepOwnSessions`
     * 按它判陈旧，不 touch 的会话会被误判成遗留）。
     *
     * <p>为什么不用 `adopt`：adopt 的语义是"收下**新** id"（清字节数、重新先写胜出）；复用时 id 没变。
     * <p>安全 no-op：缺 key ⇒ 不造记录（空壳既不可复用，还会把 settings 表撑出垃圾）。
     * <p>判死位**粘滞**：touch 只做热度合并，绝不把被判死的会话救活（要救 ⇒ 先 `supersede` 再 `adopt`）。
     *
     * @param {string} key
     * @param {object} [patch] 追加字段（后置合并，同键以补丁为准；坏类型由 `sanitizeRecord` 丢弃）。
     *   服务端侧证伪（404）的落点也走这里：`touch(key, { unconfirmed: true })`。
     * @returns {{ ok: boolean, persistState: string, persistError: string }}
     */
    touch(key, patch = undefined) {
      if (!isKey(key)) return { ok: false, persistState: 'failed', persistError: 'empty session key' };
      const previous = api.read(key);
      if (previous === null) return { ok: false, persistState: 'no_record', persistError: '' };
      const merged = sanitizeRecord({
        ...recordPatch(previous),
        lastUsedAt: Date.now(),
        ...(patch !== null && typeof patch === 'object' ? sanitizeRecord(patch) : {}),
      });
      remember(key, merged);
      const outcome = persist(key, merged);
      return { ok: true, persistState: outcome.persistState, persistError: outcome.persistError };
    },

    /**
     * 标记"该 key 的旧会话**不再自动续接**"（保留 id 作历史留痕 —— 清空会丢掉"曾经接过哪条"这个事实）。
     * 没有记录 ⇒ `no_record`（不为一次新开会话凭空造记录）。`reason` 只作调用方的留痕码（如服务端
     * 404 的判据码），**不落盘**（记录形状只有 types 里那几个字段），随返回值回给调用方。
     *
     * @param {string} key
     * @param {string} [reason]
     * @returns {{ ok: boolean, reason: string, persistState: string, persistError: string }}
     */
    supersede(key, reason = 'superseded') {
      const code = typeof reason === 'string' && reason !== '' ? reason : 'superseded';
      if (!isKey(key)) {
        return { ok: false, reason: code, persistState: 'failed', persistError: 'empty session key' };
      }
      const previous = api.read(key);
      if (previous === null) return { ok: false, reason: code, persistState: 'no_record', persistError: '' };
      // `lastUsedAt` 保持不动：替代说的是"别再自动用它"，不是"它刚被用过"。
      const patch = sanitizeRecord({ ...recordPatch(previous), superseded: true });
      remember(key, patch);
      const outcome = persist(key, patch);
      return { ok: true, reason: code, persistState: outcome.persistState, persistError: outcome.persistError };
    },

    /**
     * 作废记性（`supersede` 的别名）：调用方按 `sessionStore` 的 `{read, adopt, forget}` 三件套接线，
     * 不需要知道底层叫什么。语义与返回值与 `supersede` 逐字一致（reason 透传）。
     */
    forget(key, reason = 'superseded') {
      return api.supersede(key, typeof reason === 'string' && reason !== '' ? reason : 'superseded');
    },

    /**
     * 彻底清除一条记录（`opencode_purge` 的记性清理口）。
     * 与 `supersede`/`forget` 的区别：那两个是"保留历史、只停自动续接"；本方法是**真删**。
     *
     * 降级链（每级如实回报，不谎报已删）：
     *   1. `mutate` 可用 ⇒ `unset` 删除（`mode:'deleted'`）；
     *   2. `mutate` 缺席（极简假宿主）⇒ 退化为 tombstone（`supersede` 标记，`mode:'tombstoned'`）；
     *   3. 连 settings 服务都没有 ⇒ 只清内存（`mode:'memory-only'`，重启后旧记录会回来 —— 如实说）。
     * 没有记录 ⇒ 安全 no-op（`ok:false, mode:'no_record'`），绝不凭空造写。
     *
     * @returns {{ ok: boolean, mode: 'deleted'|'tombstoned'|'memory-only'|'no_record', persistError: string }}
     */
    purge(key) {
      if (!isKey(key)) return { ok: false, mode: 'no_record', persistError: 'empty session key' };
      if (api.read(key) === null) {
        return { ok: false, mode: 'no_record', persistError: 'no record for this session key' };
      }
      memory.delete(key);
      const svc = settingsService();
      if (svc !== null && typeof svc.mutate === 'function') {
        persistenceState.attempts += 1;
        persistenceState.pending += 1;
        const settle = (message) => {
          persistenceState.pending -= 1;
          if (message === '') { persistenceState.ok += 1; return; }
          persistenceState.failures += 1;
          persistenceState.lastError = message;
          persistenceState.lastFailure = { key, error: message, at: Date.now() };
        };
        try {
          const result = svc.mutate(ns, [{ op: 'unset', path: ['sessions', key] }]);
          if (result !== null && typeof result?.then === 'function') {
            void Promise.resolve(result).then(
              () => settle(''),
              (err) => {
                const message = messageOf(err);
                settle(message);
                ctx?.logger?.warn?.(`[plugin-opencode] session map purge 落盘失败（${key}）：${message}`);
              },
            );
            return { ok: true, mode: 'deleted', persistError: '' };
          }
          settle('');
          return { ok: true, mode: 'deleted', persistError: '' };
        } catch (err) {
          const message = messageOf(err);
          settle(message);
          // `mutate` 同步抛 ⇒ 退化为 tombstone（至少停止自动续接），成因如实带回。
          try {
            api.supersede(key, 'purge-fallback');
            return { ok: true, mode: 'tombstoned', persistError: message };
          } catch {
            return { ok: false, mode: 'memory-only', persistError: message };
          }
        }
      }
      if (svc === null) {
        persistenceState.noop += 1;
        persistenceState.lastError = 'settings surface unavailable';
        return { ok: true, mode: 'memory-only', persistError: 'settings surface unavailable' };
      }
      try {
        api.supersede(key, 'purge-fallback');
        return { ok: true, mode: 'tombstoned', persistError: '' };
      } catch (err) {
        return { ok: false, mode: 'memory-only', persistError: messageOf(err) };
      }
    },

    /**
     * 合并视图：settings 用户层（若有）+ 内存态（**内存优先 = 更新**）。
     * 非对象条目（用户手改坏/老形态残留）与 `read()` 同口径：**当没记过**，不吐给调用方。
     */
    list() {
      const merged = new Map();
      for (const [key, value] of Object.entries(persistedSessions())) {
        if (value === null || typeof value !== 'object') continue;
        merged.set(key, view(key, value));
      }
      for (const [key, value] of memory) merged.set(key, view(key, value));
      return [...merged.values()];
    },

    /** 摘要（条数封顶 + 按热度倒序）；判据与 `sessionSummary` 同一份实现。 */
    summary(limit = SESSION_SUMMARY_LIMIT) {
      return sessionSummary(api, limit);
    },

    /**
     * 落盘健康度（状态载荷/日志/测试用；失败必须可被看见）。
     * `lastError`/`lastFailure` = **最近一次失败**的留痕（成功不清除）；`'noop'` 情形同样会写
     * （"没有 settings 服务"也要能被看见）。
     */
    persistence() {
      return { ...persistenceState };
    },

    /** 测试用：等所有在途写入收敛。 */
    async settled() {
      while (persistenceState.pending > 0) await new Promise((resolve) => setImmediate(resolve));
      return { ...persistenceState };
    },
  };

  return api;
}
