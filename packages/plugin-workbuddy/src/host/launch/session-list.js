/**
 * 桌面端**真实会话清单**（只读）—— `workbuddy_status` 的 `conversations` 段与状态路由
 * `sessionList` 字段的**唯一**数据源。
 *
 * ## 为什么需要它
 * 插件自己的会话记性（`session/map.js`）只记住 `key → CLI 会话 ID` 与热度，**没有标题**；
 * 用户问「我桌上最近那几条对话叫什么」时，答案只在桌面端的 SQLite 里。本机实测（2026-11-08，
 * `new DatabaseSync(<home>/workbuddy.db, { readOnly: true })` 只读抽查）：`sessions` 表 217 行、
 * `PRAGMA table_info` 41 列，其中本模块消费的 10 列是
 *   `id / title / custom_title / created_at / updated_at / last_activity_at /
 *    deleted_at / is_background_automation / model / cwd`
 * （另有 `status` 等列，本模块不消费 —— 不把不展示的字段摊进载荷）。
 * 40 余列里挑这 10 列的理由：清单只要回答「哪条对话、什么时候、还活着没」；
 * `session_settings` / `plugin_context_json` 这类字段是桌面端内部状态，回传等于无谓扩散。
 *
 * ## 三条硬纪律
 * 1. **只读是结构性的，不是自觉**：生产路径永远是 `new DatabaseSync(path, { readOnly: true })`。
 *    这个库是**用户的**：桌面端正在写、调度器正在读，插件写一行就是事故
 *    （AGENTS.md §4；两次真库写入事故的复盘见 `tools/dev/test-home-guard.mjs` 头注释）。
 *    本模块没有任何 INSERT/UPDATE/DELETE 语句，也没有任何写 PRAGMA。
 * 2. **未知不是空**：库缺失 / 被锁 / 旧 schema 缺列 ⇒ `{ ok: false, reason }`，
 *    绝**不**以空数组冒充「没有会话」—— 那会把「读不到」谎报成「你没有对话」，
 *    正是本仓反复踩的「静默缺席」家族（见 `credit-anchor.js` 的「未知不是 0」同源纪律）。
 * 3. **永不 throw**：这是诊断面。抛错会让整个 `workbuddy_status` 一起崩，
 *    而它存在的意义恰恰是「出问题时还能说清问题」。
 *
 * ## 排序与字段口径（为什么这样选）
 * - 排序键 = `COALESCE(last_activity_at, created_at)` DESC：桌面端列表按「最后活动」排；
 *   但 `last_activity_at` 是可空列（本机实测 0 行为 NULL，不能假定它永远有值），
 *   NULL 时用 `created_at` 顶替 —— 既不是沉底也不是当 0，而是「这条对话在时间轴上的位置」。
 * - 标题优先 `title`，空则 `custom_title`，再空 `(untitled)`：**按任务书口径**。
 *   ⚠️ 本机实测 `custom_title` 只有 6/217 行非空，且与 `title` **逐字相同**（桌面端重命名时两列同写）
 *   ⇒ 本机数据分不出哪种优先级更符合产品语义。若将来确认「`title` 是自动名、`custom_title` 是用户改名」，
 *   这里的优先级需要重新裁定（已登记为交付说明的「仍不确定点」，不是拍脑袋改）。
 * - `active = deleted_at IS NULL`：桌面端用软删表达「已从列表移除」。本机 217 行里 **212 行**
 *   带 `deleted_at`（完成/关闭时落软删时间戳），只有 5 行真活跃 —— 若把软删行也报「活跃」，
 *   界面上会是一片已经不存在的对话。这与调度器读 `automations` 表的判据同源
 *   （`gateway/automation.js` 的 `countArmedRows`：`deleted_at IS NULL` 才算活行）。
 * - 标题截断 120 **字符**（`Array.from` 按 code point 计数，不按 UTF-16 码元，避免把 emoji 劈成半个）：
 *   本机实测最长标题 105 字符（120 足够展示）；但桌面端会把**整段 prompt** 直接写进标题
 *   （本机样本里可见 200+ 字的 prompt 原样落在 `title`），不截断会把状态载荷无谓撑大。
 *
 * ## 失败面（每一条都带可复核的证据串）
 * - `db-missing: <path>`                  —— 库文件不存在（桌面端从未启动过 / 换了 profile）
 * - `db-open-failed: <msg> <path>`         —— 打开失败（权限 / 文件损坏 / sqlite 不可用）
 * - `sessions-table-missing`               —— 库里没有 `sessions` 表（不是 WorkBuddy 的库？）
 * - `schema-missing-columns: a, b`         —— 旧 schema 缺列：**逐列点名**，而不是等 SELECT 抛
 * - `schema-unreadable: <msg>`             —— 连 schema 都读不到（典型：库被独占锁，`database is locked`）
 * - `query-failed: <msg>`                  —— 列都在但查询失败（锁 / IO）
 * - `unexpected: <msg>`                    —— 兜底；出现即说明上面某条判据漏了形态，但仍是 ok:false
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { existsSync } from 'node:fs';

import { workbuddyDbPath, loadSqlite } from '../gateway/automation.js';

/** 默认回传条数。50 条 × 短标题 ≈ 几 KB；再大就该用 `limit` 显式要，而不是默认倾倒。 */
export const SESSION_LIST_DEFAULT_LIMIT = 50;

/**
 * `limit` 的硬上限（**不是**任务书要求，是防呆）：避免调用方一句 `limit: 1e9` 把 217 行全量
 * 摊进模型上下文。超过上限按上限截断，`truncated` 仍如实标出（截断≠失败）。
 */
export const SESSION_LIST_MAX_LIMIT = 200;

/** 标题字符上限（见文件头「截断」段）。 */
export const SESSION_TITLE_MAX_CHARS = 120;

/**
 * 只读连接的 busy 等待上限（毫秒）。
 *
 * ★ 为什么不借用 `AUTOMATION_DEFAULTS.dbBusyTimeoutMs`（8s）：那个值是**写**路径的语义 ——
 *   写要等锁，等到了才算成功；读不一样，卡 8 秒会把状态路由/GUI 卡片一起拖住。
 *   1s 足够让桌面端完成一次短事务；等不到就如实报 `database is locked`（`ok:false`），
 *   比"静默少几条"或"界面转圈 8 秒"都诚实。
 */
export const SESSION_LIST_BUSY_TIMEOUT_MS = 1_000;

/** 输出列（与文件头逐个对应）。缺任意一列 ⇒ 旧 schema，整段报 `schema-missing-columns`。 */
const EXPECTED_COLUMNS = Object.freeze([
  'id', 'title', 'custom_title', 'created_at', 'updated_at', 'last_activity_at',
  'deleted_at', 'is_background_automation', 'model', 'cwd',
]);

/** 标题缺失时的占位 —— 与桌面端列表的「未命名」语义一致；绝不用 ''（空串在界面上是不可见的欺骗）。 */
const UNTITLED = '(untitled)';

/** 失败信封：`sessions: []` + 原因，形状与成功分支**同键**（调用方不必分支判字段是否在场）。 */
function fail(reason) {
  return {
    ok: false,
    sessions: [],
    count: 0,
    truncated: false,
    reason: typeof reason === 'string' && reason !== '' ? reason : 'unknown',
  };
}

/** 错误 → 单行证据串（带上限，避免一条超长 stack/路径把 reason 撑爆）。 */
function evidenceOf(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** 时间列归一为毫秒。取不到 ⇒ null（未知），绝不折成 0（0 = 1970 是假事实）。 */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // 本机 schema 是 INTEGER；容忍 ISO 文本只是为了让旧版/别处 schema 不至于整段报错。
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** 标题按 code point 截断，超长补 `…`（理由见文件头）。 */
function clipTitle(text) {
  const chars = Array.from(text);
  return chars.length <= SESSION_TITLE_MAX_CHARS ? text : `${chars.slice(0, SESSION_TITLE_MAX_CHARS).join('')}…`;
}

/** 标题三态：`title` → `custom_title` → `(untitled)`（顺序按任务书，见文件头的待裁定说明）。 */
function titleOf(row) {
  const primary = typeof row?.title === 'string' ? row.title.trim() : '';
  if (primary !== '') return clipTitle(primary);
  const custom = typeof row?.custom_title === 'string' ? row.custom_title.trim() : '';
  return custom === '' ? UNTITLED : clipTitle(custom);
}

/**
 * 数据库行 → 契约行。`id` 非法（空/非字符串）⇒ null（调用方丢弃：没有 id 的行无法被引用，
 * 回传它只会制造「一条点不开的对话」）。其余字段缺值一律如实 null/占位，不猜。
 */
function mapRow(row) {
  const id = typeof row?.id === 'string' ? row.id.trim() : '';
  if (id === '') return null;
  return {
    id,
    title: titleOf(row),
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
    lastActivityAt: toMs(row.last_activity_at),
    // `deleted_at IS NULL` 才是活跃（见文件头）。注意 `0` 是一个**值**，不是 NULL ⇒ 判软删。
    active: row.deleted_at === null || row.deleted_at === undefined,
    // SQLite 没有布尔类型：桌面端写 1/NULL（本机实测 169 行 NULL、48 行 1）⇒ 只认真值形状。
    background: row.is_background_automation === 1
      || row.is_background_automation === true
      || row.is_background_automation === '1',
    model: typeof row.model === 'string' && row.model !== '' ? row.model : null,
    cwd: typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null,
  };
}

/** `limit` 归一：非正整数 / 缺省 ⇒ 默认 50；超上限 ⇒ 上限（理由见常量注释）。 */
function normalizeLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) return SESSION_LIST_DEFAULT_LIMIT;
  return Math.min(limit, SESSION_LIST_MAX_LIMIT);
}

/** busy 等待归一：非负整数才认，否则默认值（防止测试/调用方传 NaN 把连接行为弄成未定义）。 */
function normalizeTimeout(timeout) {
  if (!Number.isSafeInteger(timeout) || timeout < 0) return SESSION_LIST_BUSY_TIMEOUT_MS;
  return timeout;
}

/**
 * 探测 `sessions` 表的列集 —— **先探测再查询**，因为 `SELECT` 缺列时 SQLite 只给一句
 * `no such column: custom_title`，既说不清「是旧 schema」还是「查错了」，也无法逐列点名。
 *
 * @param {{ prepare: (sql: string) => { all: () => any[] } }} db
 * @returns {{ ok: true }|{ ok: false, reason: string }}
 */
function probeColumns(db) {
  const rows = db.prepare("PRAGMA table_info('sessions')").all();
  const present = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.name === 'string' && row.name !== '') present.add(row.name);
  }
  if (present.size === 0) return { ok: false, reason: 'sessions-table-missing' };
  const missing = EXPECTED_COLUMNS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    // 逐列点名：下一个人一眼能看出是哪一代 schema，而不是去猜 SELECT 里的哪个字段。
    return { ok: false, reason: `schema-missing-columns: ${missing.join(', ')}` };
  }
  return { ok: true };
}

/**
 * 读桌面端真实会话清单（**只读**；永不 throw）。
 *
 * @param {{
 *   db?: string | { prepare: Function, close?: Function } | null,
 *   limit?: number,
 *   timeout?: number,
 * }} [opts]
 *   - `db`：缺省 = `<WORKBUDDY_HOME 或 ~>/.workbuddy/workbuddy.db`（本模块**自开自关**，
 *     永远 `readOnly: true`）。也可传**已打开**的 `DatabaseSync`（测试/诊断复用连接）
 *     —— 外部句柄本模块**不 close**（谁开谁关）；或传库文件路径（测试夹具/诊断脚本）。
 *   - `limit`：默认 `SESSION_LIST_DEFAULT_LIMIT`，上限 `SESSION_LIST_MAX_LIMIT`。
 *   - `timeout`：只读连接 busy 等待毫秒（仅本模块自己开连接时生效）。
 * @returns {{ ok: true, sessions: object[], count: number, truncated: boolean, reason: null }
 *          | { ok: false, sessions: [], count: 0, truncated: false, reason: string }}
 */
export function readSessionList({ db = null, limit = SESSION_LIST_DEFAULT_LIMIT, timeout = SESSION_LIST_BUSY_TIMEOUT_MS } = {}) {
  let handle = null;
  let ownsHandle = false;
  try {
    // ── 0. 取连接：外部句柄直接用；显式路径只读打开；缺省走桌面端家目录 ──
    /** @type {string|null} */
    let path = null;
    if (db !== null && db !== undefined) {
      if (typeof db === 'object') {
        // 形似连接才当连接；其它对象一律如实报「选项不合法」，不静默忽略（静默忽略 = 假装读过了）。
        if (typeof db.prepare !== 'function') return fail('db-invalid: the db option is an object without a prepare() method');
        handle = db;
      } else if (typeof db === 'string') {
        if (db === '') return fail('db-missing: <empty path>');
        path = db;
      } else {
        return fail(`db-invalid: unsupported db option type (${typeof db})`);
      }
    }
    if (handle === null) {
      if (path === null) {
        try {
          path = workbuddyDbPath();
        } catch (err) {
          // 典型：测试进程没经 test-home-guard 就解析真实家目录 —— `workbuddyHome()` 会 fail-closed 抛错。
          // 这里把它降级成「读不到 + 原因」，而不是把调用方一起炸掉（本函数永不 throw）。
          return fail(`home-unresolved: ${evidenceOf(err)}`);
        }
      }
      if (typeof path !== 'string' || path === '') return fail('db-missing: <empty path>');
      if (!existsSync(path)) return fail(`db-missing: ${path}`);
      try {
        const DatabaseSync = loadSqlite();
        // ★★ 只读在此处钉死：生产路径没有第二扇门（见文件头纪律 1）。
        handle = new DatabaseSync(path, { readOnly: true, timeout: normalizeTimeout(timeout) });
        ownsHandle = true;
      } catch (err) {
        return fail(`db-open-failed: ${evidenceOf(err)} (path=${path})`);
      }
    }

    // ── 1. schema 探测（旧 schema / 缺表 / 库被锁都在这里先说话） ──
    let columns;
    try {
      columns = probeColumns(handle);
    } catch (err) {
      return fail(`schema-unreadable: ${evidenceOf(err)}`);
    }
    if (columns.ok !== true) return fail(columns.reason);

    // ── 2. 查询（多取 1 行判 truncated，避免再跑一次 COUNT(*)） ──
    const max = normalizeLimit(limit);
    let raw;
    try {
      raw = handle.prepare(
        'SELECT id, title, custom_title, created_at, updated_at, last_activity_at, '
        + 'deleted_at, is_background_automation, model, cwd '
        + 'FROM sessions '
        // 排序键见文件头；`created_at DESC, id ASC` 只是同值时的稳定断点（分页/快照可复现）。
        + 'ORDER BY COALESCE(last_activity_at, created_at) DESC, created_at DESC, id ASC '
        + 'LIMIT ?',
      ).all(max + 1);
    } catch (err) {
      return fail(`query-failed: ${evidenceOf(err)}`);
    }

    const rows = Array.isArray(raw) ? raw : [];
    const truncated = rows.length > max;
    const sessions = [];
    for (const row of rows.slice(0, max)) {
      const mapped = mapRow(row);
      if (mapped !== null) sessions.push(mapped);
    }
    return {
      ok: true,
      sessions,
      // `count` = 本次**实际回传**的条数（不是库里总数 —— 总数需要额外 COUNT，而"是否还有更多"
      // 已由 truncated 回答；把两者混成一个数字是典型的假精确）。
      count: sessions.length,
      truncated,
      reason: null,
    };
  } catch (err) {
    // 兜底：走到这里说明上面某条判据漏了形态，但对外承诺不变 —— 读不到就说读不到。
    return fail(`unexpected: ${evidenceOf(err)}`);
  } finally {
    // 只关**自己开的**：外部句柄由调用方负责（否则调用方的连接会被静默弄死）。
    if (ownsHandle) {
      try { handle?.close(); } catch { /* 关闭失败不覆盖上面的结论 */ }
    }
  }
}
