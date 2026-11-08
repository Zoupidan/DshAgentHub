/**
 * workbuddy_purge —— 精准删除**一个**东西（对话或计划任务）。
 *
 * <p>管理面此前只有"看"（workbuddy_status）与"发"（workbuddy_run），没有"删"：
 * 委派产生的对话/计划任务只能去桌面端 GUI 里一条条手动删。本工具补上**精准**删除面：
 *
 * <p>★ 三种**互斥**目标（必须恰好给一个）★
 *  - `automation_id`（★ 2026-11-08 新增）：软删 `automations` 表里**这一条活行** ⇒
 *    桌面端调度器再也不会把它捡起来开工。行不存在/已软删 ⇒ `{ ok:false, error:'NOT_FOUND' }`。
 *    与"对话"无关：不碰任何 `sessions` 行、不清任何会话记性。
 *  - `session_key`：从会话记性（`session/map.js`）读出该 key 记住的 `cliSessionId`，
 *    软删那条对话 + 清掉该 key 的记性（`sessions.purge`）；
 *  - `idLike`：按会话 id 子串匹配 `sessions` 表 —— **恰好命中一条**才执行；
 *    命中 0 条或 ≥2 条一律拒绝（≥2 时列出候选让调用方收窄），绝不触碰其他对话。
 *  - 给多个目标 ⇒ 参数错误（不猜"哪个优先"：猜错就是删错东西）。
 *
 * <p>★ 作用域红线：**只动目标那一条，绝不批量** ★
 *  - 对话软删 = `UPDATE sessions SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL`
 *    （与桌面端自己的删除语义同列，可恢复、不真删文件）；
 *  - 任务软删复用 `automation.js` 的 `retireRow()`（同样带 `AND deleted_at IS NULL`）；
 *  - 绝不 INSERT、绝不批量 UPDATE、绝不动目标之外的任何行。
 *
 * <p>★ 2026-11-08：`apply.js` 已**移除启动自动清扫**（不再调 `sweepStartupAutomationRows`）。
 *   "删哪些任务"改为用户（设置卡片 → `POST /plugin-workbuddy/tasks/delete`）或模型（本工具的
 *   `automation_id`）显式决定 —— 本工具就是模型那一侧的入口。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 *
 * @module host/tools/purge
 */

import { existsSync } from 'node:fs';

import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadSqlite, retireRow, workbuddyDbPath } from '../gateway/automation.js';
import { TOOL_PURGE } from '../../shared/constants.js';

/**
 * 打开 WorkBuddy 库（测试可注入 `db`，不碰真库）。
 * @param {object|null} [injectedDb]
 * @returns {{ db: object, close: () => void, owned: boolean }}
 */
function openDb(injectedDb) {
  if (injectedDb !== null && injectedDb !== undefined) {
    return { db: injectedDb, close: () => {}, owned: false };
  }
  const DatabaseSync = loadSqlite();
  const db = new DatabaseSync(workbuddyDbPath(), { timeout: 3000 });
  return { db, close: () => { try { db.close(); } catch { /* 已关 */ } }, owned: true };
}

/**
 * 按 id 子串查候选（只查活行；软删过的不再二次处理）。
 * @param {object} db
 * @param {string} like
 * @returns {Array<{id: string, title: string|null}>}
 */
function candidatesByIdLike(db, like) {
  return db.prepare(
    'SELECT id, title FROM sessions WHERE deleted_at IS NULL AND id LIKE ? ORDER BY created_at DESC LIMIT 25',
  ).all(`%${like}%`).map((r) => ({ id: String(r.id), title: typeof r.title === 'string' ? r.title : null }));
}

/** 结构化拒绝（形状与成功分支同键，调用方不必分支判字段是否在场）。 */
function refused(detail, extra = {}) {
  return { ok: false, purged: [], mapKeysCleared: [], detail, ...extra };
}

/**
 * 删除**一个**计划任务行（`automations` 表；软删，只动这一条）。
 *
 * @param {object|null} injectedDb 已打开的库（测试注入；缺省按 WORKBUDDY_HOME 现开）
 * @param {string} automationId 目标 automation id
 * @returns {{ ok: boolean, id: string, retired?: boolean, error?: string, purged: object[], mapKeysCleared: string[], detail: string }}
 */
function purgeAutomationRow(injectedDb, automationId) {
  let handle = null;
  try {
    if (injectedDb === null || injectedDb === undefined) {
      // ★ 缺库 = 没有这条任务。**不得**为一次删除创建空库（`new DatabaseSync(path)` 会创建文件）。
      if (!existsSync(workbuddyDbPath())) {
        return refused(`no scheduled task with id "${automationId}" (workbuddy.db not found)`, {
          id: automationId, error: 'NOT_FOUND',
        });
      }
    }
    handle = openDb(injectedDb);
    const live = handle.db
      .prepare('SELECT id FROM automations WHERE id = ? AND deleted_at IS NULL')
      .get(automationId) ?? null;
    if (live === null) {
      return refused(`no live scheduled task with id "${automationId}"`, { id: automationId, error: 'NOT_FOUND' });
    }
    const retired = retireRow(handle.db, automationId);
    if (!retired) {
      // 并发：查询后、UPDATE 前被别的进程删了 ⇒ 与"不存在"同语义。
      return refused(`scheduled task "${automationId}" could not be retired (already removed)`, {
        id: automationId, error: 'NOT_FOUND',
      });
    }
    return {
      ok: true,
      id: automationId,
      retired: true,
      purged: [],
      mapKeysCleared: [],
      detail: `scheduled task ${automationId} soft-deleted (deleted_at set); it can no longer fire and no conversation was touched`,
    };
  } catch (err) {
    return refused(`purge failed: ${err instanceof Error ? err.message : String(err)}`, {
      id: automationId, error: 'INTERNAL',
    });
  } finally {
    try { handle?.close(); } catch { /* 已关 */ }
  }
}

/**
 * 创建 workbuddy_purge 工具实例。
 *
 * @param {object} [runtime] 宿主运行时（未直接消费；保留接线一致性）
 * @param {Function} [readConfig] 读最新配置（未直接消费；保留接线一致性）
 * @param {object} [ctx] 宿主 ctx（logger）
 * @param {object|null} [sessions] 会话记性（`loadSessionMap` 返回面；`lookup`/`purge`/`list`）
 * @param {object|null} [db] 可选注入已打开的 sqlite 数据库（测试专用；缺省按 WORKBUDDY_HOME 现开）
 */
export function makePurgeTool(runtime = null, readConfig = null, ctx = null, sessions = null, db = null) {
  void runtime;
  void readConfig;
  return defineTool({
    name: TOOL_PURGE,
    description:
      'Precisely delete ONE WorkBuddy item. Provide exactly ONE of three mutually exclusive targets: ' +
      '(a) automation_id — soft-delete ONE live scheduled task (a row in the desktop\'s task list, ids come from ' +
      'workbuddy_status.taskList) so the desktop scheduler can never fire it again; ' +
      '(b) session_key — soft-delete the conversation remembered for that key in the session map and clear the ' +
      'entry; (c) idLike — a substring of a conversation id, must match exactly one live conversation. ' +
      'It NEVER batch-deletes, never inserts, and never touches any other task or conversation.',
    parameters: {
      automation_id: {
        type: 'string',
        description:
          'The id of ONE live scheduled task to delete (from workbuddy_status.taskList). Soft-deletes only that '
          + 'automations row. Mutually exclusive with session_key / idLike.',
      },
      session_key: {
        type: 'string',
        description: 'The session_key whose remembered conversation should be purged (from workbuddy_status).',
      },
      idLike: {
        type: 'string',
        description: 'A substring of the conversation id to purge. Must match exactly one live conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          // ★ 2026-11-08：`automation_id` 分支的目标 id（对话分支不填；形状与 refused() 一致）。
          id: { type: 'string', description: 'The scheduled-task id targeted by the automation_id branch.' },
          retired: {
            type: 'boolean',
            description: 'True when the scheduled-task row was soft-deleted by the automation_id branch.',
          },
          error: {
            type: 'string',
            description: 'Machine-readable failure code (e.g. NOT_FOUND / INTERNAL) when ok is false.',
          },
          purged: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                softDeleted: { type: 'boolean', required: true },
              },
            },
            description: 'The conversations that were soft-deleted (exactly one on success).',
          },
          mapKeysCleared: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Session-map keys whose records were cleared.',
          },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.retired === true && typeof value.id === 'string'
            ? `Deleted scheduled task ${value.id} (soft-deleted; it can no longer fire; no conversation touched)`
            : `Purged ${value.purged.length} conversation(s): ${value.purged.map((p) => p.id).join(', ')}`
              + ` · session-map keys cleared: ${value.mapKeysCleared.length === 0 ? '(none)' : value.mapKeysCleared.join(', ')}`)
          : `Purge refused: ${value.detail ?? 'unknown error'}`,
      }],
    },
    presentCall: (a) => ({
      card: 'generic',
      title: `Delete WorkBuddy ${a?.automation_id
        ? `task (id: ${a.automation_id})`
        : `conversation${a?.session_key ? ` (key: ${a.session_key})` : (a?.idLike ? ` (idLike: ${a.idLike})` : '')}`}`,
      kind: 'execute',
    }),
    async execute(args) {
      const sessionKey = typeof args?.session_key === 'string' ? args.session_key.trim() : '';
      const idLike = typeof args?.idLike === 'string' ? args.idLike.trim() : '';
      const automationId = typeof args?.automation_id === 'string' ? args.automation_id.trim() : '';

      if (sessionKey === '' && idLike === '' && automationId === '') {
        return refused('provide exactly one target: automation_id, session_key or idLike');
      }
      // ★ 互斥：不猜"哪个优先"——猜错就是删错东西（任务 vs 对话是两码事）。
      if (automationId !== '') {
        if (sessionKey !== '' || idLike !== '') {
          return refused('automation_id is mutually exclusive with session_key / idLike — provide exactly one target');
        }
        return purgeAutomationRow(db, automationId);
      }

      // ① 解析目标会话 id（session_key 优先；两参同给时校验一致，防静默错位）。
      let targetId = null;
      const mapKeysToClear = [];
      if (sessionKey !== '') {
        let record = null;
        try {
          record = typeof sessions?.lookup === 'function' ? sessions.lookup(sessionKey) : null;
        } catch (err) {
          return { ok: false, purged: [], mapKeysCleared: [], detail: `session map lookup failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (record === null || typeof record.cliSessionId !== 'string' || record.cliSessionId === '') {
          return { ok: false, purged: [], mapKeysCleared: [], detail: `no recorded conversation for session_key "${sessionKey}"` };
        }
        targetId = record.cliSessionId;
        mapKeysToClear.push(sessionKey);
      }

      let handle = null;
      try {
        handle = openDb(db);
        const { db: conn } = handle;

        if (idLike !== '') {
          const matched = candidatesByIdLike(conn, idLike);
          if (targetId !== null) {
            // 两参同给：idLike 必须命中记性里那条，否则拒绝（不许"顺手"删别的）。
            if (!matched.some((c) => c.id === targetId)) {
              return {
                ok: false,
                purged: [],
                mapKeysCleared: [],
                detail: `idLike "${idLike}" does not match the conversation (${targetId}) recorded for session_key "${sessionKey}" — refusing to touch anything`,
              };
            }
          } else if (matched.length === 0) {
            return { ok: false, purged: [], mapKeysCleared: [], detail: `no live conversation matches idLike "${idLike}"` };
          } else if (matched.length > 1) {
            return {
              ok: false,
              purged: [],
              mapKeysCleared: [],
              detail: `idLike "${idLike}" matches ${matched.length} conversations — refine it to match exactly one. Candidates: `
                + matched.map((c) => `${c.id}${c.title ? ` (${c.title.slice(0, 60)})` : ''}`).join(' | '),
            };
          } else {
            targetId = matched[0].id;
          }
        }

        if (targetId === null) {
          return { ok: false, purged: [], mapKeysCleared: [], detail: 'could not resolve a conversation id (unreachable)' };
        }

        // ② 只读拿标题（回执可读），然后精准软删这一条。
        const row = conn.prepare('SELECT id, title FROM sessions WHERE id = ?').get(targetId) ?? null;
        if (row === null) {
          return { ok: false, purged: [], mapKeysCleared: [], detail: `conversation ${targetId} not found in the sessions table` };
        }
        const now = Date.now();
        const upd = conn.prepare(
          'UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        ).run(now, now, targetId);
        const softDeleted = Number(upd?.changes ?? 0) === 1;
        const purged = [{ id: String(row.id), title: typeof row.title === 'string' ? row.title : null, softDeleted }];

        // ③ 清会话记性：显式给的 key 一定清；其它记性键若也记着这条 id，一并清（同一对话的唯一映射）。
        const cleared = [];
        const tryPurge = (k) => {
          try {
            const r = typeof sessions?.purge === 'function' ? sessions.purge(k) : null;
            if (r !== null && typeof r === 'object' && r.ok === true) cleared.push(k);
          } catch { /* 单个 key 清理失败不拦整体（对话本身已软删） */ }
        };
        for (const k of mapKeysToClear) tryPurge(k);
        if (typeof sessions?.list === 'function' && softDeleted) {
          let rows = [];
          try { rows = sessions.list(); } catch { /* 记性读失败不影响软删结果 */ }
          for (const r of (Array.isArray(rows) ? rows : [])) {
            if (r?.cliSessionId === targetId && !cleared.includes(r?.key)) tryPurge(r.key);
          }
        }

        return {
          ok: true,
          purged,
          mapKeysCleared: cleared,
          detail: softDeleted
            ? `conversation ${targetId} soft-deleted (deleted_at set); other conversations untouched`
            : `conversation ${targetId} was already soft-deleted; nothing changed`,
        };
      } catch (err) {
        return {
          ok: false,
          purged: [],
          mapKeysCleared: [],
          detail: `purge failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        try { handle?.close(); } catch { /* 已关 */ }
      }
    },
  });
}
