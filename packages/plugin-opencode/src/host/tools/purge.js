/**
 * `opencode_purge` —— 精准清理面（记性清理 / 服务端会话硬删）。
 *
 * 两档语义（有意分开，默认档**不可**删掉任何桌面端会话）：
 *   - 默认（remote 缺省/false）：只清本插件的会话记性（session_key → 会话映射）。
 *     用户的下一条任务会重新新建一条可见会话；桌面端里那条旧会话**原样保留**。
 *   - `remote:true`：对目标会话执行 `DELETE /api/session/{id}` —— 这是**硬删**（[实测]
 *     204 → 再查 404；消息随之消失，桌面端列表里也没了）。destructive，工具描述里写明。
 *
 * @module host/tools/purge
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TOOL_PURGE } from '../../shared/constants.js';

/**
 * @param {object} runtime
 * @param {() => any} read 生效配置读取器
 * @param {{purge: Function}} dispatch
 */
export const makePurgeTool = (runtime, read, dispatch) => defineTool({
  name: TOOL_PURGE,
  description:
    'Clean up the OpenCode plugin state. Default (remote omitted): forget the plugin session memory for a '
    + 'session_key — the session itself is untouched and stays in the desktop app. remote:true: HARD-DELETE the '
    + 'target session on the service (destructive: the session and its messages disappear from the desktop app; '
    + 'verified live: DELETE returns 204 and the session is then 404). The target comes from session_id, or is '
    + 'resolved from session_key through the plugin memory.',
  parameters: {
    session_key: { type: 'string', description: 'Plugin memory key to forget (also used to resolve the session when session_id is omitted).' },
    session_id: { type: 'string', description: 'Target session id (ses_…). Required for remote:true when nothing is remembered for session_key.' },
    remote: { type: 'boolean', description: 'true = also DELETE the session on the service (destructive, irreversible).' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        session_id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, description: 'true = the service session was hard-deleted.' },
        forgot: { type: 'boolean', required: true, description: 'true = a plugin memory entry was removed.' },
        text: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args) {
    const c = read();
    if (c?.enabled !== true) {
      throw new Error('opencode is switched OFF in the plugin settings; enable it first (the cleanup face is part of the plugin).');
    }
    const res = await dispatch.purge({
      sessionKey: typeof args.session_key === 'string' ? args.session_key : '',
      sessionId: typeof args.session_id === 'string' ? args.session_id : '',
      remote: args.remote === true,
    });
    const parts = [];
    if (res.ok === true) {
      if (res.forgot === true) parts.push('plugin memory cleared');
      if (res.deleted === true) parts.push(`session ${res.sessionId} DELETED on the service (hard delete)`);
      else if (res.sessionId !== '') parts.push(`session ${res.sessionId} left untouched (remote not requested)`);
      if (parts.length === 0) parts.push('nothing to do (no memory entry matched)');
    } else {
      parts.push(`failed: ${res.reason} · ${res.reasonEvidence}`);
    }
    return {
      ok: res.ok === true,
      session_id: res.sessionId ?? '',
      deleted: res.deleted === true,
      forgot: res.forgot === true,
      text: parts.join(' · '),
    };
  },
});
