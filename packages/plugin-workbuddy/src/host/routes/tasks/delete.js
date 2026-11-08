/**
 * POST <prefix>/tasks/delete —— 删除（软删）桌面端**单个**计划任务。
 *
 * <p>★ 为什么需要它（2026-11-08，用户要求）★
 * 设置卡片此前只能"看"任务（`/status` 的 `taskList`），删一条必须回桌面端 GUI 手动操作。
 * 本路由把"删这一条"变成一次本机 HTTP 调用；同一次改动里**移除了启动自动清扫**
 * （`apply.js` 不再调 `sweepStartupAutomationRows`）——「删什么」由用户/LLM 显式决定，
 * 不再由进程启动时替用户拍板。
 *
 * <p>★ 契约（已与客户端约定死，不得改形）★
 *   - 请求：`POST /plugin-workbuddy/tasks/delete`，JSON body `{ "id": "<automation id>" }`（≤ 200 字节）
 *   - 成功 200：`{ ok: true, id, retired: true }`
 *   - 行不存在 / 已软删 404：`{ ok: false, error: 'NOT_FOUND', id }`
 *   - body 非法（非 JSON / 缺 id / id 非非空字符串 / 超长）400：`{ ok: false, error: 'BAD_REQUEST' }`
 *   - 非 loopback（或 Host 不可信）403：`{ ok: false, error: 'FORBIDDEN' }`
 *   - 内部错误 500：`{ ok: false, error: 'INTERNAL' }`
 *
 * <p>★ 作用域红线：**只软删 body 里那一条** ★
 *  - 复用 `automation.js` 已导出的 `retireRow()`：
 *    `UPDATE automations SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL`。
 *    `changes !== 1` ⇒ 行不存在或已删 ⇒ 404。**绝不批量、绝不 INSERT、绝不碰其它行。**
 *  - 软删（不是物理删）与桌面端自己的删除语义同列：可审计、可一键还原，`automation_runs` 台账保留。
 *
 * <p>★ 与状态路由同款安全栅栏 ★
 * 本路由能**改**本机库，所以「只许 loopback」比只读状态路由更硬：`isLoopback` ∧ `isLoopbackHost`
 * 两道合取（后者挡 DNS-rebinding —— 外部域名解析到 127.0.0.1 时，同源页照样能发 POST）。
 * 栅栏放在读 body **之前**：不可信请求连一行都不读。
 *
 * <p>★ 库文件不存在时**不得**为一次删除创建空库 ★
 * `new DatabaseSync(path)` 会创建文件。没装 WorkBuddy 的机器上凭空造出 `workbuddy.db`
 * 与"删成功"一样是假事实（而且下一次 `automation` 路会把空库当真库用）。
 * 所以先 `existsSync`，缺库直接 404 NOT_FOUND。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 *
 * @module host/routes/tasks/delete
 */
import { existsSync } from 'node:fs';

import { isLoopback, isLoopbackHost } from '../loopback.js';
import { ROUTE_PREFIX } from '../../../shared/constants.js';
import { loadSqlite, retireRow, workbuddyDbPath } from '../../gateway/automation.js';

/**
 * 路由路径。
 *
 * ★ 为什么常量落在本文件而不是 `shared/constants.js`：本次施工范围只允许改
 *   `routes/`、`tools/purge.js`、`apply.js` 与测试（`shared/constants.js` 不在其列）。
 *   客户端（lib/client.js）与测试都直接吃这个字面量；契约已冻结，路径不会再变。
 */
export const ROUTE_TASKS_DELETE = `${ROUTE_PREFIX}/tasks/delete`;

/** body 上限（字节）：一个 automation id 不到 64 字节，200 足够宽又挡得住滥用。 */
export const TASK_DELETE_BODY_LIMIT_BYTES = 200;

/** 打开库的 busy 等待上限（与删除动作的量级相称：一次短事务）。 */
const DB_TIMEOUT_MS = 3_000;

/** 统一的 JSON 响应写出（与 status 路由同款：不缓存、显式 charset）。 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * 读 JSON body；任何"不合法"都收敛为 `null`（调用方统一回 400，不区分细节）。
 *
 * @param {any} req Node 的 IncomingMessage（测试里是 `Readable`）
 * @param {number} limit 字节上限
 * @returns {Promise<object|null>}
 */
async function readJsonBody(req, limit) {
  if (req === null || typeof req !== 'object') return null;
  if (typeof req[Symbol.asyncIterator] !== 'function') return null;
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      total += buf.length;
      // ★ 超限直接判非法（契约把"太长"归到 400，不引入第三个错误码）。
      if (total > limit) return null;
      chunks.push(buf);
    }
  } catch {
    return null; // 中断 / 读流失败 = 请求不完整
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // 只要普通对象：`null` / 数组 / 标量都没有 `id` 可言。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * 构造删除路由描述符（`{ kind, path, handler }` —— `ctx.webServer.register` 的入参形态）。
 *
 * @returns {{ kind: string, path: string, handler: (req: any, res: any) => Promise<void> }}
 */
export function makeTasksDeleteRoute() {
  return {
    kind: 'exact',
    path: ROUTE_TASKS_DELETE,
    handler: async (req, res) => {
      // ① 安全栅栏（fail-closed）：不可信请求连 body 都不读。
      if (!isLoopback(req) || !isLoopbackHost(req)) {
        sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
        return;
      }
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return;
      }

      // ② body 校验：非空字符串 id 是唯一合法形态。
      const body = await readJsonBody(req, TASK_DELETE_BODY_LIMIT_BYTES);
      if (body === null || typeof body.id !== 'string' || body.id.trim() === '') {
        sendJson(res, 400, { ok: false, error: 'BAD_REQUEST' });
        return;
      }
      const id = body.id.trim();

      // ③ 取库落点；测试进程里 `WORKBUDDY_HOME` 未设会抛 ⇒ 按内部错误处理（不猜真库）。
      let dbPath;
      try {
        dbPath = workbuddyDbPath();
      } catch {
        sendJson(res, 500, { ok: false, error: 'INTERNAL' });
        return;
      }
      // ④ 缺库 = 没有这条任务；**不得**在这里创建空库（见文件头）。
      if (!existsSync(dbPath)) {
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND', id });
        return;
      }

      // ⑤ 精准软删一行。`retireRow` 自带 `AND deleted_at IS NULL` ⇒ 只有 live 行才返回 true。
      let db = null;
      try {
        const DatabaseSync = loadSqlite();
        db = new DatabaseSync(dbPath, { timeout: DB_TIMEOUT_MS });
        const retired = retireRow(db, id);
        if (!retired) {
          sendJson(res, 404, { ok: false, error: 'NOT_FOUND', id });
          return;
        }
        sendJson(res, 200, { ok: true, id, retired: true });
      } catch {
        sendJson(res, 500, { ok: false, error: 'INTERNAL' });
      } finally {
        try { db?.close(); } catch { /* 已关 */ }
      }
    },
  };
}
