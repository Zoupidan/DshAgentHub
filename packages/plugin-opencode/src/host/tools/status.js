/**
 * `opencode_status` —— 只读状态面（模型、人、卡片三处共用的那面镜子）。
 *
 * 内容与状态路由**同源**（同一批 runtime/dispatch 读数），但**面向模型**：
 *   - 探测证据逐条列出（"查了哪些路径" —— 用户可复核）；
 *   - 模型清单从服务实况取（30s TTL），免费与否三态；
 *   - 会话记性（最多 5 条摘要）+ 最近一轮回执（含正文摘录）；
 *   - 待批审批计数（来自最近一轮观察；回复入口 = opencode_approvals）。
 *
 * 本工具**永不触发下发**；`reprobe:true` 只重跑只读探测（fs 读，H-NO-EXEC-PROBE）。
 *
 * @module host/tools/status
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TOOL_STATUS } from '../../shared/constants.js';
import { oneLine } from '../launch/reason-codes.js';

const REPLY_EXCERPT_CHARS = 160;

function probeLine(ps) {
  if (ps.status === 'idle') return 'service: (no probe yet — enable the plugin or call opencode_status {reprobe:true})';
  if (ps.status === 'pending') return `service: probing… (${ps.pendingReason})`;
  const r = ps.result ?? {};
  if (r.installed === true) {
    return `service: OK · version=${r.version || 'unknown'} · url=${r.baseUrl || 'unknown'} · pid=${r.pid ?? 'unknown'}`;
  }
  return `service: NOT FOUND (${r.reason || 'unknown'})`;
}

/**
 * @param {object} runtime
 * @param {object} sessions session/map.js api
 * @param {() => any} read 生效配置读取器
 * @param {{models: Function}} dispatch
 */
export const makeStatusTool = (runtime, sessions, read, dispatch) => defineTool({
  name: TOOL_STATUS,
  description:
    'Read-only status of the OpenCode plugin: availability probe evidence (which service.json paths were checked), '
    + 'the live model catalog from the local service, the session memory (reusable sessions), the last run receipt, '
    + 'and how many approvals are pending. Never dispatches anything; reprobe:true only re-runs the read-only detection.',
  parameters: {
    reprobe: { type: 'boolean', description: 'Re-run the read-only availability detection before answering.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', required: true, description: 'Human-readable multi-line status.' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args) {
    const c = read() ?? {};
    if (args.reprobe === true) await runtime.reprobe();
    const lines = [];
    const ps = runtime.probeState();
    lines.push(`opencode plugin · enabled=${c.enabled === true} · registry=${runtime.registry()}`);
    lines.push(probeLine(ps));
    const evidence = Array.isArray(ps.result?.evidence) ? ps.result.evidence.slice(-4) : [];
    for (const e of evidence) lines.push(`  · ${e.target}: ${e.detail}`);
    const registrationError = runtime.registrationError();
    if (typeof registrationError === 'string' && registrationError !== '') {
      lines.push(`registration error: ${registrationError}`);
    }

    let cat;
    try {
      cat = await dispatch.models();
    } catch (err) {
      cat = { ok: false, reason: 'internal', models: [] };
      lines.push(`models: unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
    if (cat.ok === true) {
      const free = cat.models.filter((m) => m.isFree === true).length;
      lines.push(`models: ${cat.models.length} (free: ${free}) · source=${cat.source}`);
      for (const m of cat.models.slice(0, 12)) {
        const flags = [m.isFree === true ? 'free' : (m.isFree === false ? 'paid' : 'cost?'), m.enabled === false ? 'disabled' : null]
          .filter((x) => x !== null).join(',');
        lines.push(`  · ${m.providerID}/${m.id}${flags !== '' ? ` [${flags}]` : ''}${m.variants.length > 0 ? ` · variants: ${m.variants.join('/')}` : ''}`);
      }
      if (cat.models.length > 12) lines.push(`  … ${cat.models.length - 12} more`);
    } else if (cat.ok === false) {
      lines.push(`models: unavailable (${cat.reason})`);
    }

    const rows = sessions.summary(5);
    lines.push(`session memory: ${rows.length === 0 ? '(empty)' : `${rows.length} shown (max 5)`}`);
    for (const r of rows) lines.push(`  · ${r.sessionKey} → ${r.sessionId || '(none)'} [${r.state}]${r.own ? ' own' : ''}`);

    const last = runtime.lastRun();
    if (last === null || typeof last !== 'object') {
      lines.push('last run: (none)');
    } else {
      const reply = typeof last.reply === 'string' && last.reply !== ''
        ? oneLine(last.reply).slice(0, REPLY_EXCERPT_CHARS)
        : '(no text)';
      lines.push(`last run: session=${last.sessionId || '-'} key=${last.sessionKey || '-'} resumed=${last.resumed === true}`
        + ` outcome=${last.outcome ?? '-'} wait=${last.waitStatus ?? '-'} reason=${last.reasonCode}`
        + `${last.reasonText !== '' && last.reasonText !== undefined ? ` (${last.reasonText})` : ''}`
        + ` cost=${last.cost ?? '-'}${last.model !== null && last.model !== undefined ? ` model=${last.model.providerID}/${last.model.id}${last.model.variant !== '' ? `@${last.model.variant}` : ''}` : ''}`);
      lines.push(`  reply: ${reply}`);
      if (last.reasonEvidence !== undefined && last.reasonEvidence !== '') lines.push(`  evidence: ${last.reasonEvidence}`);
      const pending = Array.isArray(last.permissionRequests)
        ? last.permissionRequests.filter((p) => p.state === 'pending')
        : [];
      if (pending.length > 0) {
        lines.push(`approvals: ${pending.length} pending (as of the last run) — list/reply with opencode_approvals`);
      }
    }
    return { text: lines.join('\n') };
  },
});
