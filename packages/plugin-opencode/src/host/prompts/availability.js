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

/** 并发预算句（就绪支与 Lead 支共用；逐字唯一事实：单 harness ≤3 在途、合计 ≤4）。 */
const CONCURRENCY_LINE = 'Concurrency budget: at most 3 tasks in flight for this harness, and at most 4 across '
  + 'all harnesses (the dsh brain coordinates the total) — do not exceed it.';

/**
 * ★ ① 身份上移（2026-10-17）Lead 口径：OpenCode 由名为 "opencode" 的团队成员执行。
 * 触发条件 = 本 agent 的可见面**没有** opencode_run（团队在场时的 Lead；工具面归成员身份）。
 */
const LEAD_MEMBER_ROUTE_TEXT = 'OpenCode is reachable through its team member: spawn_teammate with name '
  + '"opencode" (lower-kebab-case; description must START with "OpenCode · " — e.g. "OpenCode · your work '
  + 'runs by calling opencode_run; you do not implement it yourself") creates the real member that operates '
  + 'the local OpenCode desktop app. Message it the task with send_message (a queued message is already '
  + 'stored — never resend it) and wait with wait_agent for its receipt before answering the user. The '
  + 'opencode_* tools are NOT on your own tool surface by design — they belong to that member\'s identity; '
  + 'do not attempt to call them.';

/**
 * 不可用支的文案 —— **按探测 reason 如实区分**（2026-11-08 T7 起）。
 *
 * 为什么不再一句 "was NOT found (<reason>)" 打天下：探测现在回答的是"可不可用"，
 *   三种不可用的真相完全不同，处置也不同（重启桌面端 / 看端点错误 / 服务在但模型表空）。
 *   把它们压成同一句，等于让模型对着 `models-unreadable` 去"重新打开桌面端"。
 *
 * 纪律：
 *   - 'service-missing' 与其它未知 reason **保留原句**（routes.test.js / apply.test.js 逐字钉死，
 *     那是"文件不在"这一支的既有契约，不为新分支改旧契约）；
 *   - 每句都只讲读得出来的话（探测证据里的端点/错误码），不猜原因、不编权限；
 *   - hasTools 两支的差别只在"你现在能做什么"（有工具 / 只能派团队成员）。
 *
 * @param {string} reason ProbeResult.reason
 * @param {boolean} hasTools 本 agent 的可见面上是否有 opencode_*
 * @returns {string} 一句（或两句）英文本节文本
 */
function unavailableText(reason, hasTools) {
  const nextStep = hasTools ? ' Do not call opencode_run until it is available.' : ' Do not delegate until it is available.';
  switch (reason) {
    case 'stale-service':
      return 'OpenCode delegation is enabled but the registered OpenCode service is stale (stale-service): '
        + 'service.json is still on disk but the process it names has exited (pid dead) — the desktop app is not running. '
        + 'Ask the user to start the OpenCode desktop app; opencode_status shows the pid it checked.'
        + nextStep;
    case 'service-unreachable':
      return 'OpenCode delegation is enabled but the local OpenCode service did not answer (service-unreachable): '
        + 'service.json exists but GET /api/info failed (refused / timed out / non-2xx within 1s). '
        + 'opencode_status lists the endpoint and the exact error; the service may still be starting or wedged.'
        + nextStep;
    case 'models-unreadable':
      return 'OpenCode delegation is enabled but the local OpenCode service cannot serve models (models-unreadable): '
        + 'it answers /api/info but GET /api/model returned no readable model table (non-2xx, empty, or unparseable). '
        + 'This is the "shows running yet no models" state — opencode_status shows the /api/model evidence.'
        + nextStep;
    default:
      // 既有契约原文（service-missing / error / 未知）：一字不动。
      return hasTools
        ? `OpenCode delegation is enabled but the local OpenCode service was NOT found (${reason}). `
          + 'opencode_status lists which service.json paths were checked.'
        : `OpenCode delegation is enabled but the local OpenCode service was NOT found (${reason}). `
          + 'Do not delegate until it is available.';
  }
}

/**
 * @param {object} runtime config/runtime.js 实例
 * @returns {string} 本节文本（'' = 不加节 —— 不会发生：三态各有一句）
 */
export function availabilityText(runtime, opts = {}) {
  // ★ ① 身份上移（2026-10-17）：调用方（apply 的 section thunk）按"该 agent 的可见面"传入；
  //   缺省 = 老口径（有工具）—— 老调用方与老测试逐字不动。
  const hasTools = opts?.hasTools !== false;
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
    lines.push(hasTools
      ? `OpenCode delegation is enabled and its availability check is still running (${ps.pendingReason || ps.status}) — `
        + 'opencode_run may refuse until the check lands; opencode_status shows the evidence.'
      : `OpenCode delegation is enabled and its availability check is still running (${ps.pendingReason || ps.status}). `
        + 'Spawn the team member "opencode" to delegate in the meantime (description must START with "OpenCode · ").');
  } else if (ps.result?.installed !== true) {
    lines.push(unavailableText(typeof ps.result?.reason === 'string' && ps.result.reason !== '' ? ps.result.reason : 'unknown', hasTools));
  } else if (!hasTools) {
    // ★ ① 身份上移（2026-10-17）：本 agent 的可见面上没有 opencode_*（团队在场时 = Lead）——
    //   指引走团队成员身份（名为 "opencode" 的 teammate）；成员职责由成员 scope 的职责段承担。
    lines.push(LEAD_MEMBER_ROUTE_TEXT);
    lines.push(CONCURRENCY_LINE);
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
    lines.push(CONCURRENCY_LINE);
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
  const last = hasTools ? runtime.lastRun() : null;
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
