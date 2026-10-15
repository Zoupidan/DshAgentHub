/**
 * `opencode_run` —— 把任务下发给本机 OpenCode 桌面端（八步契约的 ①–⑦ 入口）。
 *
 * 形态：注册为一个 **作业**（`ctx.jobs.start`）——调用立刻返回 job_id，
 * 进度与终态用 `job_output` 读（作业输出里逐行可复核）；取消用 `job_kill`
 * （★ 取消只撤**等待**：任务在桌面端继续跑，会话是用户可见的，不是后台进程）。
 *
 * 与 workbuddy 版的关键差异（有意为之）：
 *   - 没有 argv / 没有 flag 注入面 —— 下发是 HTTP body，不做 `-` 开头的额外拒收；
 *   - "新对话"不是危险动作（opencode 建会话 ≠ 切走用户正在看的会话；[待验] 登记在 README），
 *     所以**没有** new_conversation 开关：复用/新建由 session_key 记性 + resume 决定；
 *   - 空 prompt 仅在 `wait_only:true` 时合法（复用为"只等回执"）。
 *
 * @module host/tools/run
 */
import { randomUUID } from 'node:crypto';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { TOOL_RUN } from '../../shared/constants.js';
import { OUTPUT_LIMIT_BYTES } from '../config/constants.js';
import { REASON_CODES, REASON_TEXT } from '../launch/reason-codes.js';
import { deriveSessionKey, promptExcerpt } from '../gateway/dispatch.js';
import { gatewayHeader, startGatewayRun } from './gateway-run.js';

const SESSION_KEY_DESCRIPTION =
  'Affinity key for conversation reuse. With the same key (and resume not false) the run reuses the session '
  + 'remembered for this key by a previous run — that session stays visible in the OpenCode desktop UI. '
  + 'Omit it to derive a stable key from the workspace ("dir:<path>"); when neither is set every run creates a NEW '
  + 'visible session.';

const MODEL_ARG_DESCRIPTION =
  'Model for THIS run, written as "providerID/modelID" (e.g. "opencode/deepseek-v4.1-flash-free"). '
  + 'The valid ids are the ones the local OpenCode service reports — call opencode_status for the live list. '
  + 'Omit to use the plugin setting; when that is also empty the session keeps whatever model it already has.';

const VARIANT_ARG_DESCRIPTION =
  'Reasoning strength (variant) for THIS run — the service-side variant id of the chosen model '
  + '(deepseek-v4.1-flash-free supports low/high/max). Omit to use the plugin setting; '
  + 'when empty everywhere the model keeps its default. Set opencode_status to see the live values per model.';

/**
 * @param {object} runtime config/runtime.js 的实例
 * @param {object} sessions session/map.js 的 api
 * @param {() => any} cfg 生效配置读取（currentConfig 包装）
 * @param {object} ctx 宿主 ctx（jobs 用）
 * @param {{run: Function}} dispatch gateway/dispatch.js 的实例
 */
export const makeRunTool = (runtime, sessions, cfg, ctx, dispatch) => defineTool({
  name: TOOL_RUN,
  description:
    'Delegate a coding task to the local OpenCode desktop app (visible GUI session on this machine, no CLI, no proxy). '
    + 'Runs as a background job: read progress with job_output, cancel with job_kill '
    + '(cancel stops WATCHING — the task keeps running in the visible desktop session). '
    + 'The run: creates or reuses a visible session, optionally sets workspace/model/reasoning variant, '
    + 'sends the prompt, waits for the session to go idle (bounded by wait_timeout_ms), then returns the receipt '
    + '(outcome / reply / cost / tokens) plus any pending permission requests. '
    + 'If it stops on an approval, answer with opencode_approvals and then re-attach with wait_only:true.',
  parameters: {
    prompt: { type: 'string', required: true, description: 'The task text to send to the OpenCode session. Required unless wait_only is true.' },
    session_key: { type: 'string', description: SESSION_KEY_DESCRIPTION },
    session_id: { type: 'string', description: 'Explicit target session id (ses_…). Verify-only: if it does not exist the run errors instead of falling back.' },
    resume: {
      type: 'boolean',
      description:
        'false = force a NEW session even when this session_key has a recorded one. '
        + 'true/omitted = prefer the recorded session; if it is gone the run clears the memory, creates a new '
        + 'session and reports fallbackReason.',
    },
    wait_only: {
      type: 'boolean',
      description:
        'true = send NO prompt — just (re)attach to a session (session_id / session_key / binding) and wait for it '
        + 'to go idle, then return the receipt. Use it after replying to an approval, or to fetch the result of a '
        + 'task that outlived the previous wait.',
    },
    title: { type: 'string', description: 'Title for a NEW session (default: "dsh: <prompt excerpt>"). Ignored when reusing a session.' },
    model: { type: 'string', description: MODEL_ARG_DESCRIPTION },
    variant: { type: 'string', description: VARIANT_ARG_DESCRIPTION },
    workspace: { type: 'string', description: 'Working directory for a NEW session (location.directory). Ignored when reusing — the plugin never relocates an existing session. Omit to use the plugin setting.' },
    delivery: { type: 'string', description: "Prompt delivery: 'queue' (default) or 'steer' (steer the in-flight turn)." },
    wait_timeout_ms: { type: 'number', description: 'Max milliseconds to wait for the session to go idle (default from plugin setting; clamped to 5000..3600000). Timing out never kills the task.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: { type: 'string', required: true },
        session_key: { type: 'string', required: true },
        session_id: { type: 'string', required: true, description: "Explicit target session id given for this run ('' = resolve by key/binding)." },
        transport: { type: 'string', required: true, description: 'Human-checkable line: which channel/key/model this run uses.' },
        wait_only: { type: 'boolean', required: true },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: `started job ${value.job_id} (session_key ${value.session_key || '(none)'}`
        + `${value.session_id !== '' ? `, target ${value.session_id}` : ''}`
        + `${value.wait_only === true ? ', wait-only' : ''})\n`
        + `${value.transport}\n`
        + 'read progress with job_output; the session (if created) appears in the OpenCode desktop app.',
    }],
  },
  async execute(args, exec = {}) {
    // ── 最短路的两个闸（即便工具被误注册，也再判一次）──
    const c = cfg();
    if (c?.enabled !== true) {
      throw new Error(
        'opencode is switched OFF in the plugin settings: nothing is dispatched (U4 gate — '
        + 'ask the user to enable the plugin, do not retry)',
      );
    }
    let probe = runtime.detected();
    if (probe === null) probe = await runtime.awaitDetection();
    if (probe?.installed !== true) {
      const why = probe === null
        ? 'no availability detection has completed yet'
        : `the local OpenCode service was not found (reason: ${typeof probe.reason === 'string' && probe.reason !== '' ? probe.reason : 'unknown'})`;
      throw new Error(
        `opencode cannot run now: ${why}. Call opencode_status for the evidence list (which paths were checked).`,
      );
    }

    const waitOnly = args.wait_only === true;
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (!waitOnly && prompt.trim() === '') {
      throw new Error('prompt must be a non-empty string (or pass wait_only:true to re-attach to a session)');
    }
    if (args.delivery !== undefined && args.delivery !== 'queue' && args.delivery !== 'steer') {
      throw new Error("delivery must be 'queue' or 'steer'");
    }
    const delivery = args.delivery === 'steer' ? 'steer' : 'queue';
    const resume = typeof args.resume === 'boolean' ? args.resume : null;
    const workspace = typeof args.workspace === 'string' && args.workspace.trim() !== ''
      ? args.workspace.trim()
      : (typeof c.workspace === 'string' ? c.workspace.trim() : '');
    const sessionKey = deriveSessionKey({ sessionKey: args.session_key, workspace });
    const explicitSessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
    if (waitOnly && explicitSessionId === '' && sessionKey === ''
      && (typeof c.boundSessionId !== 'string' || c.boundSessionId.trim() === '')) {
      throw new Error('wait_only needs a target: pass session_id or session_key, or set a binding in the plugin settings');
    }

    // ── 互斥：同工作区/同键串行；插件全局上限 3（runtime 的锁即两份判据）──
    const lockKey = workspace !== '' ? workspace : (sessionKey !== '' ? sessionKey : '__default__');
    const lockJobId = `oc-${randomUUID()}`;
    const acquired = typeof runtime?.acquireWorkspaceLock === 'function'
      ? runtime.acquireWorkspaceLock(lockKey, lockJobId)
      : true;
    if (!acquired) {
      const busyErr = new Error(
        `opencode workspace is busy: another job is in flight for "${lockKey}" (or the plugin-wide cap of 3 is reached).`,
      );
      busyErr.code = 'ERR_WORKSPACE_BUSY';
      busyErr.reasonCode = 'ERR_WORKSPACE_BUSY';
      throw busyErr;
    }
    const releaseLock = () => {
      try {
        if (typeof runtime?.releaseWorkspaceLock === 'function') runtime.releaseWorkspaceLock(lockKey, lockJobId);
      } catch { /* 释放失败 = 下次可能误报忙，不是本轮的错误 */ }
    };

    const waitTimeoutMs = typeof args.wait_timeout_ms === 'number' && Number.isFinite(args.wait_timeout_ms)
      ? args.wait_timeout_ms
      : null;
    // 作业句柄：phase 由 dispatch 的 onPhase 实时刷新（状态卡片读"现在到哪一步了"）。
    const handle = { terminate: null, sessionKey, sessionId: explicitSessionId, phase: '' };

    let dispatched = false;
    try {
      const req = startGatewayRun({
        prompt: prompt.trim(),
        sessionKey,
        sessionId: explicitSessionId,
        resume,
        waitOnly,
        title: typeof args.title === 'string' ? args.title : '',
        model: typeof args.model === 'string' ? args.model : '',
        variant: typeof args.variant === 'string' ? args.variant : '',
        workspace,
        delivery,
        waitTimeoutMs,
        signal: exec?.signal,
        phaseHook: (p) => {
          handle.phase = p;
        },
        dispatch,
      });

      const aJobId = ctx.jobs.start({
        kind: 'opencode',
        label: waitOnly ? `wait ${sessionKey || explicitSessionId || '(bound)'}`.slice(0, 60) : prompt.trim().slice(0, 60),
        ...(exec.agent ? { owner: exec.agent.id } : {}),
        outputLimitBytes: OUTPUT_LIMIT_BYTES,
        run: () => ({
          cancel: req.cancel,
          done: req.done.then((out) => {
            const g = out.gateway ?? {};
            const isCompleted = out.status === 'completed';
            const isStillRunning = out.status === 'still_running';
            runtime.noteRun({
              sessionId: typeof g.sessionId === 'string' ? g.sessionId : '',
              sessionKey,
              resumed: g.resumed === true,
              promptExcerpt: promptExcerpt(prompt),
              delivery: typeof g.delivery === 'string' ? g.delivery : delivery,
              acceptedAt: typeof g.acceptedAt === 'number' ? g.acceptedAt : null,
              idleAt: typeof g.idleAt === 'number' ? g.idleAt : null,
              waitStatus: typeof g.waitStatus === 'string' && g.waitStatus !== 'n/a' ? g.waitStatus : null,
              outcome: typeof g.outcome === 'string' ? g.outcome : null,
              reply: typeof g.reply === 'string' ? g.reply : '',
              permissionRequests: (Array.isArray(g.permissionRequests) ? g.permissionRequests : []).map((p) => ({
                requestID: typeof p.requestID === 'string' ? p.requestID : '',
                action: typeof p.action === 'string' ? p.action : '',
                source: `${p.sourceType ?? ''}${p.sourceID !== '' && p.sourceID !== undefined ? `:${p.sourceID}` : ''}`,
                state: 'pending',
                decision: '',
              })),
              model: g.model ?? null,
              cost: typeof g.cost === 'number' ? g.cost : null,
              tokens: g.tokens ?? null,
              reasonCode: g.reason ?? (isCompleted ? REASON_CODES.OK : REASON_CODES.INTERNAL),
              reasonText: REASON_TEXT[g.reason ?? REASON_CODES.OK] ?? '',
              reasonEvidence: typeof g.reasonEvidence === 'string' ? g.reasonEvidence : '',
              at: typeof g.at === 'number' ? g.at : Date.now(),
            });
            runtime.finish(aJobId, isCompleted || isStillRunning ? 0 : -1);
            runtime.forget(aJobId);
            releaseLock();
            return {
              status: out.status,
              detail: out.detail,
              reply: typeof g.reply === 'string' ? g.reply : null,
              session_id: typeof g.sessionId === 'string' ? g.sessionId : '',
            };
          }, (err) => {
            // done 理论上永不 reject（gateway-run 兜了）；这里只做作业面的兜底。
            runtime.finish(aJobId, -1);
            runtime.forget(aJobId);
            releaseLock();
            return {
              status: 'failed',
              detail: err instanceof Error ? err.message : String(err),
              reply: null,
              session_id: '',
            };
          }),
          readOutput: req.readOutput,
        }),
      });
      handle.terminate = req.cancel;
      runtime.start(aJobId, handle);
      dispatched = true;
      return {
        job_id: aJobId,
        session_key: sessionKey,
        session_id: explicitSessionId,
        transport: gatewayHeader({ sessionKey, model: typeof args.model === 'string' && args.model !== '' ? args.model : (typeof c.model === 'string' ? c.model : '') }),
        wait_only: waitOnly,
      };
    } finally {
      if (!dispatched) releaseLock();
    }
  },
});
