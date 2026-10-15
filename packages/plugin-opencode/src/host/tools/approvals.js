/**
 * `opencode_approvals` —— 审批面（八步契约之 ⑧：本轮相对 workbuddy 的**净增量能力**）。
 *
 * 两件事：
 *   - `action:'list'`（缺省）：列出目标会话的**待批**权限请求（服务端
 *     `GET /api/session/{id}/permission`，实况读，不留缓存）。
 *   - `action:'reply'`：对一条请求回复 `once` / `always` / `reject`（服务端
 *     `POST …/permission/{requestID}/reply`）；`wait_ms>0` 时回复后**继续等** idle 并把
 *     续跑回执带回来（人回完审批，最关心的就是"它接下来干了什么"）。
 *
 * 与状态卡片同步：list/reply 之后把结果写回 `lastRun.permissionRequests`
 * （仅当目标是 lastRun 那条会话）——卡片上的"待批 N 条"因此不会永远停在旧读数。
 *
 * 边界（v0.1 诚实登记）：SSE 推送面未接（recon §10 的 `permission.asked` 事件）；
 *   本工具是**拉式**消费 —— 下发轮 wait 收敛时已把当时待批的请求记进 lastRun。
 *
 * @module host/tools/approvals
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TOOL_APPROVALS } from '../../shared/constants.js';

const DECISIONS = ['once', 'always', 'reject'];

/** 把答复结果写回 lastRun 的 permissionRequests（只动目标会话那一条记录）。 */
function patchLastRun(runtime, sessionId, mutate) {
  const last = runtime.lastRun();
  if (last === null || typeof last !== 'object') return;
  if ((last.sessionId ?? '') !== sessionId) return;
  if (!Array.isArray(last.permissionRequests)) return;
  runtime.noteRun({ ...last, permissionRequests: mutate(last.permissionRequests) });
}

/**
 * @param {object} runtime
 * @param {object} sessions session/map.js api
 * @param {() => any} read 生效配置读取器
 * @param {{listApprovals: Function, replyApproval: Function}} dispatch
 */
export const makeApprovalsTool = (runtime, sessions, read, dispatch) => defineTool({
  name: TOOL_APPROVALS,
  description:
    'Approval channel for the local OpenCode plugin (step 8). action:"list" (default) shows the pending permission '
    + 'requests of a session; action:"reply" answers one request with decision once|always|reject. '
    + 'After a reply, pass wait_ms>0 to keep waiting for the session to go idle and get the continued receipt. '
    + 'The target session comes from session_id or is resolved from session_key / the plugin binding.',
  parameters: {
    action: { type: 'string', description: "'list' (default) or 'reply'." },
    session_key: { type: 'string', description: 'Plugin memory key (resolves the target session when session_id is omitted).' },
    session_id: { type: 'string', description: 'Explicit target session id (ses_…).' },
    request_id: { type: 'string', description: 'Permission request id (reply only; take it from action:list).' },
    decision: { type: 'string', description: "reply only: 'once' | 'always' | 'reject'." },
    message: { type: 'string', description: 'reply only: optional message attached to the decision.' },
    wait_ms: { type: 'number', description: 'reply only: after replying, wait up to this many ms for idle, then return the receipt (clamped 5000..3600000).' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        session_id: { type: 'string', required: true },
        text: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args) {
    const c = read();
    if (c?.enabled !== true) {
      throw new Error('opencode is switched OFF in the plugin settings; enable it first (the approval face is part of the plugin).');
    }
    const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'list';
    const sessionKey = typeof args.session_key === 'string' ? args.session_key : '';
    const sessionId = typeof args.session_id === 'string' ? args.session_id : '';

    if (action === 'list') {
      const res = await dispatch.listApprovals({ sessionKey, sessionId });
      if (res.ok !== true) {
        return { ok: false, session_id: res.sessionId ?? '', text: `failed: ${res.reason} · ${res.reasonEvidence}` };
      }
      patchLastRun(runtime, res.sessionId, () => res.items.map((i) => ({
        requestID: i.requestID,
        action: i.action,
        source: `${i.sourceType}${i.sourceID !== '' ? `:${i.sourceID}` : ''}`,
        state: 'pending',
        decision: '',
      })));
      if (res.items.length === 0) {
        return { ok: true, session_id: res.sessionId, text: `no pending approval requests for ${res.sessionId}.` };
      }
      const lines = [`${res.items.length} pending approval request(s) for ${res.sessionId}:`];
      for (const i of res.items) {
        lines.push(`  · ${i.requestID} · action=${i.action || '?'} · source=${i.sourceType || '?'}${i.sourceID !== '' ? `:${i.sourceID}` : ''}${i.save === true ? ' · save=true' : ''}`);
      }
      lines.push('reply with opencode_approvals {action:"reply", request_id:…, decision:"once"|"always"|"reject"}');
      return { ok: true, session_id: res.sessionId, text: lines.join('\n') };
    }

    if (action === 'reply') {
      const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
      const decision = typeof args.decision === 'string' ? args.decision.trim() : '';
      if (requestId === '') throw new Error('request_id is required for action:"reply" (take it from action:"list")');
      if (!DECISIONS.includes(decision)) throw new Error(`decision must be one of ${DECISIONS.join('|')}`);
      const res = await dispatch.replyApproval({
        sessionKey,
        sessionId,
        requestId,
        decision,
        message: typeof args.message === 'string' ? args.message : '',
        waitMs: typeof args.wait_ms === 'number' ? args.wait_ms : 0,
      });
      if (res.ok !== true) {
        return { ok: false, session_id: res.sessionId ?? '', text: `reply failed: ${res.reason} · ${res.reasonEvidence}` };
      }
      patchLastRun(runtime, res.sessionId, (list) => list.map((p) => (p.requestID === requestId ? { ...p, state: 'replied', decision } : p)));
      const lines = [`replied ${decision} to ${requestId} on ${res.sessionId}.`];
      if (res.itemsAfter.length > 0) {
        lines.push(`still pending: ${res.itemsAfter.length} request(s) — ${res.itemsAfter.map((i) => i.requestID).join(', ')}`);
      }
      if (res.receipt !== null && res.receipt !== undefined) {
        const r = res.receipt;
        lines.push(`continued: wait=${res.waitStatus} outcome=${r.outcome ?? '?'}${typeof r.cost === 'number' ? ` cost=${r.cost}` : ''}`);
        if (typeof r.reply === 'string' && r.reply !== '') lines.push(r.reply);
        if (res.reason !== undefined && res.reason !== 'ok' && res.reasonText !== '') lines.push(`note: ${res.reasonText}`);
      } else if (res.waitStatus === 'n/a') {
        lines.push('(no wait requested — pass wait_ms>0 next time to get the continued receipt here; or re-attach with opencode_run {wait_only:true}.');
      }
      return { ok: true, session_id: res.sessionId, text: lines.join('\n') };
    }

    throw new Error(`unknown action "${action}" (use 'list' or 'reply')`);
  },
});
