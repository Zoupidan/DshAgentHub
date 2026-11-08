/**
 * 桌面端**任务清单**（只读）—— `workbuddy_status` 的 `tasks` 段与状态路由 `taskList` 字段的
 * **唯一**数据源。
 *
 * ## 为什么需要它
 * 之前 `workbuddy_status` 只能看到"在途作业"（`inFlight`）与本插件最近一次下发（`lastRun`），
 * **看不到桌面上那些计划任务**：用户问「我桌面上还有几个任务、都叫什么」时，工具面答不出来
 * （历史结论是 `workbuddy_harvest` 必须先有 `automation_id`，而状态面没有这个字段）。
 * 但真源一直都在：桌面端 SQLite 的 `automations` 表，`name` 列就是**任务标题**
 * （本机实测：8 条活行的 `name` = 下发时的 prompt 首段，`prompt` 列是全文）。
 * ⇒ 本模块把这张表读成一份只读清单（标题 / 状态 / 计划类型 / 起止时间 / 是否仍活跃）。
 *
 * ## 三条硬纪律（与 `session-list.js` 同源）
 * 1. **只读是结构性的**：生产路径永远 `new DatabaseSync(path, { readOnly: true })`；
 *    本模块没有任何 INSERT/UPDATE/DELETE，也没有写 PRAGMA。桌面端正在读写这个库，
 *    插件写一行就是事故。
 * 2. **未知不是空**：库缺失 / 被锁 / 旧 schema 缺列 ⇒ `{ ok:false, reason }`，
 *    绝不以空数组冒充「没有任务」。
 * 3. **永不 throw**：这是诊断面；抛错会把整个 `workbuddy_status` 一起带崩。
 *
 * ## 口径
 * - `active = deleted_at IS NULL`：桌面端用软删表达"已从任务列表移除"。
 *   本机 2026-11-08 实测 217 行里 209 行已软删、8 行活行（那 8 行 `valid_until` 已过期，
 *   属历史遗留，已由 Lead 手工退役）。默认**只列活行**；要看历史用 `includeDeleted:true`。
 * - 标题优先 `name`，空则取 `prompt` 的**首行**（桌面端把整段 prompt 写进 `name` 的样本很多，
 *   首行足够辨识），仍空 ⇒ `(untitled)`；上限 120 个 code point，超长补 `…`。
 * - 排序 `created_at DESC, id ASC`（同值稳定断点，快照可复现）。
 *
 * ## 失败面（每条都带可复核证据串）
 * - `db-missing: <path>` / `db-open-failed: <msg>` / `automations-table-missing`
 * - `schema-missing-columns: a, b`（逐列点名）
 * - `schema-unreadable: <msg>` / `query-failed: <msg>` / `unexpected: <msg>`
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { existsSync } from 'node:fs';

import { workbuddyDbPath, loadSqlite } from '../gateway/automation.js';

/** 默认回传条数（50 × 短标题 ≈ 几 KB）。 */
export const TASK_LIST_DEFAULT_LIMIT = 50;

/** 硬上限（防呆：避免 limit:1e9 把整张表摊进上下文）。 */
export const TASK_LIST_MAX_LIMIT = 200;

/** 标题字符上限（code point）。 */
export const TASK_TITLE_MAX_CHARS = 120;

/** 只读连接的 busy 等待上限（1s：读不该把状态路由拖住 8 秒）。 */
export const TASK_LIST_BUSY_TIMEOUT_MS = 1_000;

/** 输出列（缺任意一列 ⇒ 旧 schema，整段报 `schema-missing-columns`）。 */
const EXPECTED_COLUMNS = Object.freeze([
  'id', 'name', 'prompt', 'status', 'schedule_type', 'created_at', 'updated_at',
  'last_run_at', 'next_run_at', 'valid_until', 'deleted_at',
]);

const UNTITLED = '(untitled)';

/** 失败信封（与成功分支同键，调用方不必分支判字段是否在场）。 */
function fail(reason) {
  return {
    ok: false,
    tasks: [],
    count: 0,
    truncated: false,
    reason: typeof reason === 'string' && reason !== '' ? reason : 'unknown',
  };
}

/** 错误 → 单行证据串。 */
function evidenceOf(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** 时间归一为毫秒；取不到 ⇒ null（0 是假事实）。 */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** 按 code point 截断，超长补 `…`。 */
function clipTitle(text) {
  const chars = Array.from(text);
  return chars.length <= TASK_TITLE_MAX_CHARS ? text : `${chars.slice(0, TASK_TITLE_MAX_CHARS).join('')}…`;
}

/** 标题三态：`name` → `prompt` 首行 → `(untitled)`。 */
function titleOf(row) {
  const name = typeof row?.name === 'string' ? row.name.trim() : '';
  if (name !== '') return clipTitle(name);
  const prompt = typeof row?.prompt === 'string' ? row.prompt.trim() : '';
  if (prompt !== '') return clipTitle(prompt.split(/\r?\n/, 1)[0]);
  return UNTITLED;
}

/** 数据库行 → 契约行；`id` 非法 ⇒ null（没有 id 的任务行无法被引用）。 */
function mapRow(row) {
  const id = typeof row?.id === 'string' ? row.id.trim() : '';
  if (id === '') return null;
  return {
    id,
    title: titleOf(row),
    status: typeof row.status === 'string' && row.status !== '' ? row.status : null,
    scheduleType: typeof row.schedule_type === 'string' && row.schedule_type !== '' ? row.schedule_type : null,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
    lastRunAt: toMs(row.last_run_at),
    nextRunAt: toMs(row.next_run_at),
    validUntil: toMs(row.valid_until),
    // `deleted_at IS NULL` 才是活跃；0 是值不是 NULL ⇒ 判软删。
    active: row.deleted_at === null || row.deleted_at === undefined,
  };
}

/** `limit` 归一。 */
function normalizeLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) return TASK_LIST_DEFAULT_LIMIT;
  return Math.min(limit, TASK_LIST_MAX_LIMIT);
}

/** busy 等待归一。 */
function normalizeTimeout(timeout) {
  if (!Number.isSafeInteger(timeout) || timeout < 0) return TASK_LIST_BUSY_TIMEOUT_MS;
  return timeout;
}

/** 先探测列集——`SELECT` 缺列只会给一句 `no such column`，说不清是旧 schema。 */
function probeColumns(db) {
  const rows = db.prepare("PRAGMA table_info('automations')").all();
  const present = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.name === 'string' && row.name !== '') present.add(row.name);
  }
  if (present.size === 0) return { ok: false, reason: 'automations-table-missing' };
  const missing = EXPECTED_COLUMNS.filter((name) => !present.has(name));
  if (missing.length > 0) return { ok: false, reason: `schema-missing-columns: ${missing.join(', ')}` };
  return { ok: true };
}

/**
 * 读桌面端任务清单（**只读**；永不 throw）。
 *
 * @param {{
 *   db?: string | { prepare: Function, close?: Function } | null,
 *   limit?: number,
 *   includeDeleted?: boolean,
 *   timeout?: number,
 * }} [opts]
 *   - `db`：缺省 = `<WORKBUDDY_HOME 或 ~>/.workbuddy/workbuddy.db`（自开自关，`readOnly: true`）；
 *     也可传已打开的连接（本模块不 close）或库文件路径。
 *   - `includeDeleted`：默认 false（只列活行）；true 时把软删行也带上（`active:false` 标出）。
 * @returns {{ ok: true, tasks: object[], count: number, truncated: boolean, reason: null }
 *          | { ok: false, tasks: [], count: 0, truncated: false, reason: string }}
 */
export function readTaskList({ db = null, limit = TASK_LIST_DEFAULT_LIMIT, includeDeleted = false, timeout = TASK_LIST_BUSY_TIMEOUT_MS } = {}) {
  let handle = null;
  let ownsHandle = false;
  try {
    // ── 0. 取连接 ──
    /** @type {string|null} */
    let path = null;
    if (db !== null && db !== undefined) {
      if (typeof db === 'object') {
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
          return fail(`home-unresolved: ${evidenceOf(err)}`);
        }
      }
      if (typeof path !== 'string' || path === '') return fail('db-missing: <empty path>');
      if (!existsSync(path)) return fail(`db-missing: ${path}`);
      try {
        const DatabaseSync = loadSqlite();
        // ★★ 只读在此处钉死。
        handle = new DatabaseSync(path, { readOnly: true, timeout: normalizeTimeout(timeout) });
        ownsHandle = true;
      } catch (err) {
        return fail(`db-open-failed: ${evidenceOf(err)} (path=${path})`);
      }
    }

    // ── 1. schema 探测 ──
    let columns;
    try {
      columns = probeColumns(handle);
    } catch (err) {
      return fail(`schema-unreadable: ${evidenceOf(err)}`);
    }
    if (columns.ok !== true) return fail(columns.reason);

    // ── 2. 查询（多取 1 行判 truncated） ──
    const max = normalizeLimit(limit);
    const where = includeDeleted === true ? '' : 'WHERE deleted_at IS NULL ';
    let raw;
    try {
      raw = handle.prepare(
        'SELECT id, name, prompt, status, schedule_type, created_at, updated_at, '
        + 'last_run_at, next_run_at, valid_until, deleted_at '
        + 'FROM automations '
        + where
        + 'ORDER BY created_at DESC, id ASC LIMIT ?',
      ).all(max + 1);
    } catch (err) {
      return fail(`query-failed: ${evidenceOf(err)}`);
    }

    const rows = Array.isArray(raw) ? raw : [];
    const truncated = rows.length > max;
    const tasks = [];
    for (const row of rows.slice(0, max)) {
      const mapped = mapRow(row);
      if (mapped !== null) tasks.push(mapped);
    }
    return { ok: true, tasks, count: tasks.length, truncated, reason: null };
  } catch (err) {
    return fail(`unexpected: ${evidenceOf(err)}`);
  } finally {
    if (ownsHandle) {
      try { handle?.close(); } catch { /* 关闭失败不覆盖上面的结论 */ }
    }
  }
}
