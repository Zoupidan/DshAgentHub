/**
 * 成员 scope 的工具装配（① 身份上移，2026-10-17）——同一套工具工厂、同一组依赖，**只换注册面**：
 * 注册进成员自己的 `agent.ctx`（官方 tool-agent-team 的 scoped install 范式），而不是全局面。
 *
 * 由 `tools/index.js` 的 reconcile 在 `agentTeams` 在场时调用；团队缺席时不经过本模块（回退全局注册）。
 * 卸载语义：返回的 disposer 逐条退还本成员 scope 的全部注册（失败尽最大努力、不阻断其余）。
 *
 * @module host/team/member-tools
 */
import { PLUGIN_ID } from '../../shared/constants.js';
import { makeRunTool } from '../tools/run.js';
import { makeStatusTool } from '../tools/status.js';
import { makePurgeTool } from '../tools/purge.js';
import { makeHarvestTool } from '../tools/harvest.js';

/**
 * 成员职责段（装进成员自己的 scope，order 521，与可用性段 520 相邻）。
 * 只讲成员要做的事：用工具下发、回原始回执、按同一 session_key 应辩、不自己实现任务。
 * （"你是谁"的身份前缀由 spawn_teammate 的首条 user message 注入，本段只补操作职责。）
 */
export const MEMBER_DUTY_TEXT = 'You are the WorkBuddy member of this Agent Team: the team\'s WorkBuddy work '
  + 'runs through you. Dispatch into the local WorkBuddy desktop with workbuddy_run — it opens a real '
  + 'conversation there (own cwd, model, permission mode); read receipts before replying and relay results '
  + 'to the Lead verbatim with send_message. When the Lead messages an objection to a result you delivered, '
  + 'argue back on the next run under the same session_key and stop once the point is settled. Never implement '
  + 'the delegated task yourself.';

/**
 * @param {object} scoped 成员自己的 agent.ctx（tools / systemPrompt 服务在其上可见）
 * @param {{runtime: object, sessions: object, read: Function, ctx: object,
 *   credits?: object|null, dispatch?: object|null, checkin?: object|null}} deps
 * @returns {() => void} 该成员 scope 的全部注销器
 */
export function installMemberTools(scoped, deps) {
  const disposers = [];
  try {
    disposers.push(scoped.tools.register(
      makeRunTool(deps.runtime, deps.sessions, deps.read, deps.ctx, deps.credits ?? null, deps.dispatch ?? null),
    ));
    disposers.push(scoped.tools.register(
      makeStatusTool(deps.runtime, deps.read, deps.ctx, deps.sessions, deps.dispatch ?? null,
        deps.checkin ?? null, deps.credits ?? null),
    ));
    disposers.push(scoped.tools.register(
      makePurgeTool(deps.runtime, deps.read, deps.ctx, deps.sessions, null),
    ));
    disposers.push(scoped.tools.register(
      makeHarvestTool(deps.runtime, deps.read, deps.ctx),
    ));
    disposers.push(scoped.systemPrompt.section({
      name: `${PLUGIN_ID}:member-duty`,
      order: 521,
      text: MEMBER_DUTY_TEXT,
    }));
  } catch (err) {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* 回滚尽最大努力 */ } }
    throw err;
  }
  return () => {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* 卸载尽最大努力 */ } }
  };
}
