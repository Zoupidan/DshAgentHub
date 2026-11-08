/**
 * `qoder_run` —— 把任务下发给本机 Qoder CN（CDP+applicationInvoke，八步契约入口）。
 * @module host/tools/run
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TOOL_RUN } from '../../shared/constants.js';
import { REASON_CODES, REASON_TEXT, oneLine, redact } from '../launch/reason-codes.js';

export const makeRunTool = (runtime, sessions, read, ctx, dispatch) => defineTool({
  name: TOOL_RUN,
  description:
    'Dispatch a task to the local Qoder CN desktop app via CDP (window.qoderDesktop.applicationInvoke). '
    + 'Creates or reuses a visible Qoder session (session_key affinity, resume, or boundSessionId). '
    + 'Returns a job receipt with session id, wait status, and reply excerpt. '
    + 'Never starts/kills/restarts Qoder; never uses CLI/GUI automation/reverse proxy. '
    + 'scheduled_tasks/plan automation is unsupported (unknown) — do not claim it. '
    + 'Approval relay is unverified (unknown) — report as unknown, do not fabricate. '
    + 'Credentials are never echoed.',
  parameters: {
    prompt: { type: 'string', description: 'Task text to send. Omit only with wait_only=true.' },
    session_key: { type: 'string', description: 'Affinity key for reuse (same key reuses the mapped session when resumable).' },
    resume: { type: 'string', description: 'Explicit Qoder session UUID to continue.' },
    workspace: { type: 'string', description: 'Workspace path (new sessions need a resolvable workspace; do not guess).' },
    wait_only: { type: 'boolean', description: 'If true, attach to the target session and wait for receipt without sending a new prompt.' },
    wait_timeout_ms: { type: 'number', description: 'Override wait timeout (ms). Timeout does not stop the task in Qoder.' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.text ?? JSON.stringify(value, null, 2) }],
  },
  async execute(args, toolCtx) {
    const cfg = read?.() ?? runtime.currentConfig?.() ?? {};
    if (cfg.enabled !== true) {
      return { text: `qoder_run: disabled (enabled=false). reason=${REASON_CODES.CDP_UNAVAILABLE}`, ok: false, reasonCode: REASON_CODES.CDP_UNAVAILABLE };
    }
    if (!dispatch || typeof dispatch.run !== 'function') {
      return { text: 'qoder_run: dispatcher not wired.', ok: false, reasonCode: REASON_CODES.INTERNAL };
    }
    const res = await dispatch.run(args, { signal: toolCtx?.signal });
    const lines = [];
    lines.push(`qoder_run: ${res.ok ? 'ok' : 'not-ok'} · reason=${res.reasonCode}${res.reasonText ? ` (${res.reasonText})` : ''}`);
    if (res.sessionId) lines.push(`session: ${res.sessionId}${res.resumed ? ' (resumed)' : ' (new)'}`);
    if (res.sessionKey) lines.push(`session_key: ${res.sessionKey}`);
    if (res.waitStatus) lines.push(`wait: ${res.waitStatus}`);
    if (res.reasonEvidence) lines.push(`evidence: ${res.reasonEvidence}`);
    if (typeof res.reply === 'string' && res.reply.trim()) lines.push(`reply: ${oneLine(redact(res.reply)).slice(0, 1200)}`);
    else if (res.reasonCode === REASON_CODES.WAIT_TIMEOUT) lines.push('reply: (wait timed out; task may still be running in Qoder — reuse session_key/resume to attach later)');
    if (res.model?.reasoningEffort?.includes('unknown-submit-param')) lines.push('note: reasoningEffort submitRich input param is unverified (unknown) — not sent; reported as-is.');
    return { text: lines.join('\n'), ...res };
  },
});
