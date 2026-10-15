/**
 * systemPrompt.section 的可用性文案（⑥；order = 520）。
 *
 * 目的：让对话模型知道"能不能用 opencode 工具"，且**不撒谎**（三态：未探测完 / 服务缺失 / 就绪；
 * 被用户关闭同样明说）。每回合求值 ⇒ 本文件为 v0.1 精简版（workbuddy 同款文件的历史包袱不搬）。
 *
 * 纪律：
 *   - 只讲读得出来的话（探测证据、配置现值、lastRun 的归一原因码）；
 *   - 未结论 ≠ 未安装（`probeState().status !== 'done'` 时不给"没有"的结论）；
 *   - 失败证据摘录先截断（每回合都进系统提示，token 是预算）。
 *
 * @module host/prompts/availability
 */
import { REASON_CODES } from '../launch/reason-codes.js';

/** 失败提示里证据摘录的字符上限（本节每回合都进系统提示 ⇒ 必须截断）。 */
const FAILURE_EVIDENCE_CHARS = 200;

/**
 * @param {object} runtime config/runtime.js 实例
 * @returns {string} 本节文本（'' = 不加节 —— 不会发生：三态各有一句）
 */
export function availabilityText(runtime) {
  const cfg = runtime.currentConfig?.() ?? {};
  const lines = [];
  if (cfg.enabled !== true) {
    lines.push(
      'OpenCode delegation is present but switched OFF by the user in the plugin settings (dsh-plugin-opencode). '
      + 'Do not call opencode_run; if the user needs it, ask them to enable the plugin first.',
    );
    return lines.join('\n');
  }
  const ps = runtime.probeState();
  if (ps.status !== 'done') {
    lines.push(
      `OpenCode delegation is enabled and its availability check is still running (${ps.pendingReason || ps.status}) — `
      + 'opencode_run may refuse until the check lands; opencode_status shows the evidence.',
    );
  } else if (ps.result?.installed !== true) {
    lines.push(
      `OpenCode delegation is enabled but the local OpenCode service was NOT found (${ps.result?.reason || 'unknown'}). `
      + 'opencode_status lists which service.json paths were checked.',
    );
  } else {
    lines.push(
      'OpenCode delegation is available: opencode_run sends a task to the local OpenCode desktop app. '
      + 'The conversation it uses is a real session visible in the desktop UI (no CLI, no proxy, no hidden channel). '
      + 'Read progress with job_output; cancel with job_kill — cancelling only stops watching, the task keeps '
      + 'running in the visible session.',
    );
    // ★ 2026-10-15 并发预算（模型可见文本）：dsh 是协调方 —— 单 harness 至多 3 个在途任务，全部 harness
    //   合计至多 4 个。只写在**就绪**这一支：关闭 / 未探测完 / 服务缺失三支里没有可下发的对象，
    //   写预算就是每回合白付的 token（本节纪律：只讲读得出来的话，本节每回合都进系统提示）。
    lines.push(
      'Concurrency budget: at most 3 tasks in flight for this harness, and at most 4 across all harnesses '
      + '(the dsh brain coordinates the total) — do not exceed it.',
    );
    const model = typeof cfg.model === 'string' ? cfg.model : '';
    const variant = typeof cfg.variant === 'string' ? cfg.variant : '';
    lines.push(
      `Defaults in force now: model ${model === '' ? 'not set — choosing one is your call (opencode_status lists live ids)' : `"${model}"`}; `
      + `reasoning variant ${variant === '' ? 'not set (the model default applies)' : `"${variant}"`}. Both can be overridden per run.`,
    );
    lines.push(
      'Session reuse: pass a session_key (otherwise a stable key is derived from the workspace) — rounds with the same '
      + 'key share one visible conversation; wait_only:true re-attaches to fetch a receipt; approvals are answered with '
      + 'opencode_approvals; opencode_purge clears memory or hard-deletes a session.',
    );
  }
  const last = runtime.lastRun();
  if (last !== null && typeof last === 'object' && last.reasonCode !== REASON_CODES.OK && last.reasonCode !== undefined) {
    const evidence = typeof last.reasonEvidence === 'string' ? last.reasonEvidence.slice(0, FAILURE_EVIDENCE_CHARS) : '';
    lines.push(
      `Last opencode run ended with ${last.reasonCode}`
      + `${typeof last.reasonText === 'string' && last.reasonText !== '' ? ` (${last.reasonText})` : ''}`
      + `${evidence !== '' ? ` · evidence: ${evidence}` : ''}.`,
    );
  }
  return lines.join('\n');
}
