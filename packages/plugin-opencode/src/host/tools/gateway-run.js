/**
 * 把下发编排翻译成 dsh 的作业接口（★ `ctx.jobs.start()` 要求的那套 `{cancel, done, readOutput}`）。
 *
 * ★ 与 workbuddy 版的根本差异：这一路**没有进程、没有退出码、没有 argv** ——
 *   它是与该桌面端本机服务之间的一段 HTTP 对话（创建/复用会话 → 设模型 → prompt → wait → 回执）。
 *   所以：
 *   - 终态词表照旧用作业层的三档：`completed` / `still_running` / `failed`；
 *   - `still_running` 的两个来源都如实映射：等待超时 / 等待被取消（任务仍在桌面端跑），
 *     以及**停在审批上**（APPROVAL_PENDING —— 人没回，任务就不会前进）；
 *   - 取消（cancel）只撤**等待**：会话在桌面端继续可见地跑 —— 这在输出里必须写清楚，
 *     否则读者会以为"取消了 = 任务没了"。
 *
 * @module host/tools/gateway-run
 */
import { REASON_CODES } from '../launch/reason-codes.js';

/** 作业输出首行（自描述：通道/键/模型 —— 给人复核"这轮到底发到哪儿了"）。 */
export function gatewayHeader({ sessionKey, model }) {
  return `transport=local-http · session_key=${sessionKey || '(none)'} · model=${model || '(session default)'}`;
}

const ORIGIN_LABEL = {
  new: 'new session',
  resumed: 'reused session',
  bound: 'bound session',
  explicit: 'explicit session',
};

/**
 * 跑一轮 opencode 下发/等待。
 *
 * @param {{prompt?: string, sessionKey?: string, sessionId?: string, resume?: boolean|null,
 *   waitOnly?: boolean, title?: string, model?: string, variant?: string, workspace?: string,
 *   delivery?: 'queue'|'steer', waitTimeoutMs?: number|null, signal?: AbortSignal,
 *   dispatch: {run: Function}}} req
 * @returns {{cancel: () => void, done: Promise<{status: string, detail: string, exitCode: number, gateway: object}>,
 *   readOutput: () => string}}
 */
export function startGatewayRun({
  prompt = '', sessionKey = '', sessionId = '', resume = null, waitOnly = false,
  title = '', model = '', variant = '', workspace = '', delivery = 'queue',
  waitTimeoutMs = null, signal, phaseHook, dispatch,
}) {
  const controller = new AbortController();
  // 调用方的取消要能真的撤掉等待，否则"取消"只是不再读输出，任务在桌面端白跑。
  const onUpstreamAbort = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener?.('abort', onUpstreamAbort, { once: true });
  }

  /** 增量输出缓冲（readOutput 靠游标消费，offset 语义与 spawn 路径一致）。 */
  let buffer = '';
  let cursor = 0;
  let headerPending = true;
  let lastPhase = '';
  const push = (line) => {
    buffer += `${line}\n`;
  };

  const done = (async () => {
    // ★ 这一层永不 reject：done 是作业收敛的唯一出口，让异常逃出去 = 作业永远转圈（比报错更坏）。
    let out;
    try {
      out = await dispatch.run({
        ...(prompt !== '' ? { prompt } : {}),
        sessionKey,
        sessionId,
        ...(resume !== null && resume !== undefined ? { resume } : {}),
        waitOnly,
        title,
        model,
        variant,
        workspace,
        delivery,
        ...(typeof waitTimeoutMs === 'number' ? { waitTimeoutMs } : {}),
        signal: controller.signal,
      }, {
        // ★ 钩子是 run 的**第二参**（args 里塞 onPhase 会让 dispatch 收不到 —— 真机教训：
        //   症状是作业直接 failed: internal: Cannot read properties of undefined (reading 'onPhase')）。
        onPhase: (p) => {
          if (p === lastPhase) return;
          lastPhase = p;
          push(`… ${p}`);
          try {
            phaseHook?.(p);
          } catch { /* 阶段钩子只是记账；不影响作业本身 */ }
        },
      });
    } catch (err) {
      signal?.removeEventListener?.('abort', onUpstreamAbort);
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        detail: `${REASON_CODES.INTERNAL}: ${message}`,
        exitCode: 1,
        gateway: { reason: REASON_CODES.INTERNAL, sessionId: null, sessionKey: sessionKey === '' ? null : sessionKey, reply: null },
      };
    }

    if (!waitOnly && typeof out.text === 'string' && out.text !== '') push(out.text.trimEnd());

    const stillRunning = !out.ok
      && (out.reason === REASON_CODES.WAIT_TIMEOUT
        || out.reason === REASON_CODES.WAIT_ABORTED
        || out.reason === REASON_CODES.APPROVAL_PENDING);
    const who = out.sessionId === '' ? '' : ` · session ${out.sessionId} (${ORIGIN_LABEL[out.sessionOrigin] ?? (out.sessionOrigin || '?')})`;
    if (out.ok) {
      push(`[ok]${who} outcome=${out.outcome ?? '?'} cost=${out.cost ?? '?'}`
        + (out.model !== null ? ` model=${out.model.providerID}/${out.model.id}${out.model.variant !== '' ? `@${out.model.variant}` : ''}` : ''));
    } else if (stillRunning) {
      const hint = out.reason === REASON_CODES.APPROVAL_PENDING
        ? ` · ${out.permissionRequests.length} 条待批 —— 用 opencode_approvals 处理后再等`
        : ' · 任务可能仍在桌面端运行 —— 同一会话再等可拿回执';
      push(`[still_running]${who} ${out.reason}${hint}`);
    } else {
      push(`[failed]${who} ${out.reason} · ${out.reasonEvidence || out.reasonText || 'unknown'}`);
    }
    if (out.fallbackReason !== null) push(`[note] ${out.fallbackReason}`);

    signal?.removeEventListener?.('abort', onUpstreamAbort);

    const reason = out.ok ? null : out.reason;
    const reply = typeof out.text === 'string' ? out.text.trim() : '';
    const detail = out.ok
      ? (reply === '' ? '(completed with no text output)' : reply)
      : `${reason}: ${out.reasonEvidence || out.reasonText || 'unknown'}`;
    return {
      status: out.ok ? 'completed' : (stillRunning ? 'still_running' : 'failed'),
      detail,
      exitCode: out.ok || stillRunning ? 0 : 1,
      /** 附加信息（不进通知文案）：上层记账与状态路由消费 —— ★ 白名单：少一个键就跨层无声消失。 */
      gateway: {
        reason,
        reasonText: out.reasonText,
        reasonEvidence: out.reasonEvidence,
        sessionId: out.sessionId === '' ? null : out.sessionId,
        sessionKey: out.sessionKey === '' ? null : out.sessionKey,
        sessionOrigin: out.sessionOrigin === '' ? null : out.sessionOrigin,
        resumed: out.resumed === true,
        fallbackReason: out.fallbackReason,
        outcome: out.outcome,
        waitStatus: out.waitStatus,
        reply: reply === '' ? null : reply,
        replyTruncated: out.replyTruncated === true,
        cost: out.cost,
        tokens: out.tokens,
        model: out.model,
        permissionRequests: out.permissionRequests,
        permissionsError: out.permissionsError,
        promptExcerpt: out.promptExcerpt,
        delivery: out.delivery,
        acceptedAt: out.acceptedAt,
        idleAt: out.idleAt,
        version: out.version,
        at: out.at,
      },
    };
  })();

  return {
    cancel: () => controller.abort(),
    done,
    readOutput: () => {
      const header = headerPending ? `${gatewayHeader({ sessionKey, model })}\n` : '';
      headerPending = false;
      const fresh = buffer.slice(cursor);
      cursor = buffer.length;
      return header + fresh;
    },
  };
}
