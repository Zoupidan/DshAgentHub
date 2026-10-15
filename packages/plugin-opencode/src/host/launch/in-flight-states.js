/**
 * 在途 / 最近一轮的**四态投影** —— 只读纯函数（零 IO、零网络、零计时器）。
 *
 * 用户口径（2026-10-15 原话）：
 *   opencode 任务状态要四态如实呈现：**下发中 / 执行中 / 压缩中 / 已结束**；
 *   「压缩中」不得当「已结束」。
 *
 * 输入只用**既有真实字段**，不做任何补写：
 *   - 在途面：`RunRecord{ sessionKey, sessionId, startedAt, phase }`（types/index.js:44-49）。
 *     phase 由 dispatch 的 `onPhase` 实时刷新（dispatch.js:342），经 gateway-run.js:81-88 的 phaseHook
 *     写入作业句柄（run.js:169/186-188），再由 runtime.inFlight()（config/runtime.js:361-374）读出。
 *   - 终态面：`LastRunRecord{ waitStatus, outcome, reasonCode, … }`（types/index.js:59-79）。
 *
 * ★ 为什么不放 tools/status.js ★
 *   状态路由（routes/status/get.js 的载荷同样带 inFlight/lastRun）与工具面是**两个消费面**；
 *   投影是业务词汇（与 launch/reason-codes.js 同层），放 tools/ 会让 routes 侧被迫反向依赖 tools。
 *   做成纯函数还能脱离工具壳直测（见 test/tools.test.js 的投影用例）。
 *
 * ══ 四态 ↔ phase 的映射依据（行号 = 2026-10-15 的源码；改动任何一处前先读这张表）══
 *
 *   下发中（dispatching）：任务还没交到 OpenCode 手里 —— 建/复用会话 → 设模型 → 投递 prompt 全过程。
 *      实际发出值（dispatch.js 的 onPhase 调用点）：
 *        ''                   —— 句柄初始值 / 首个 phase 未到（run.js:169）
 *        'connecting'         —— dispatch.js:361
 *        'resolving-session'  —— dispatch.js:368
 *        'creating-session'   —— dispatch.js:391
 *        'setting-model'      —— dispatch.js:436
 *        'prompting'          —— dispatch.js:455
 *   执行中（running）：prompt 已受理，任务在 OpenCode 侧跑着 —— 我们在等 idle / 取回执。
 *        'waiting'            —— dispatch.js:238（waitAndReceipt 起手）
 *        'receipt'            —— dispatch.js:272（wait 收敛后取会话/消息/回执；**实际发出值**）
 *        'fetching-receipt'   —— types/index.js:48 文档里的名字，**代码从未发出**；
 *                                此处兼容作为别名（两拼写同判）。该不一致已在任务报告登记。
 *   压缩中（compacting）：★ 当前**没有可观察信号** —— 投影不产出该态（见下方调查结论）。
 *   已结束（finished）：在途表里**不可能**出现 —— run.js:229-230 收敛即 finish+forget（同一同步回合），
 *       终态面只存在于 lastRun（见 projectLastRun）。
 *   未知（unknown）：不认识的非空 phase。**绝不硬塞**成四态里的任一态（尤其不许塞成压缩中/已结束）；
 *       逃生口与仓库既有的底线纪律同款（types/index.js:104 的 isFree 三态即此类）。
 *
 * ══ 「压缩中」信号调查结论（2026-10-15；[实测] openapi.json 只读核对 + 读取链走查）══
 *
 *   OpenCode 服务面**有**压缩事实（不代表插件看得见）：
 *     - `POST /api/session/{id}/compact`（body 可空）→ 200 `Session.Inbox.Compaction`（受理语义，类似 prompt）；
 *     - 消息表可含 `type:'compaction'` 的消息，`status ∈ running|completed|failed`、`reason ∈ auto|manual`
 *       （Session.Message.Compaction.Running/Completed/Failed；出现于 Session.Message.Info 的 anyOf 联合）；
 *     - 事件面上 recon §2（OPENCODE-LOCAL-RECON-20261015.md:45）的二进制串里见 `session.compacted`。
 *   但**本插件当前的读取链看不到它**，三处断点：
 *     ① wait 只有 204（dispatch.js:257）—— "会话转 idle"不带原因；压缩与普通执行对 wait 同形；
 *     ② 运行中（phase='waiting'）插件**不读**消息表 —— 唯一读取点在 waitAndReceipt 的 wait 之后（dispatch.js:282）；
 *     ③ 即便 wait 之后读到了消息，receipt.js 只认 assistant 正文（receipt.js:16-18 的 messageType 与 :65-99 的
 *        buildReceipt）—— compaction / idle 消息被忽略；RunRecord 里也没有承载它的字段（types/index.js:44-49）。
 *   ⇒ 结论：**压缩中当前观察不到** —— 如实留空，绝不把"等待中"猜成"压缩中"（也不许落成"已结束"）。
 *   补信号的最小路径（建议，未接线）：在 'waiting' 期间读消息表（找 status='running' 的 compaction 消息）
 *   或订阅 SSE `session.compacted`，由 dispatch 发出一个 phase='compacting'；届时**唯一接线点** = 本文件
 *   projectRunRecord 的映射分支（加一行判等即可），工具/路由/测试都不用再动。
 *
 * @module host/launch/in-flight-states
 */

/** 四态投影的机器可读枚举（中文标签见 IN_FLIGHT_STATE_LABELS；unknown = 逃生口，不是第五态）。 */
export const IN_FLIGHT_STATES = Object.freeze({
  DISPATCHING: 'dispatching',
  RUNNING: 'running',
  COMPACTING: 'compacting',
  FINISHED: 'finished',
  UNKNOWN: 'unknown',
});

/** 机器枚举 → 四态标签（用户口径原词，逐字）。 */
export const IN_FLIGHT_STATE_LABELS = Object.freeze({
  [IN_FLIGHT_STATES.DISPATCHING]: '下发中',
  [IN_FLIGHT_STATES.RUNNING]: '执行中',
  [IN_FLIGHT_STATES.COMPACTING]: '压缩中',
  [IN_FLIGHT_STATES.FINISHED]: '已结束',
  [IN_FLIGHT_STATES.UNKNOWN]: '未知',
});

/** 下发中：见文件头「映射依据」表的第一组（'' 与 'connecting' 属"作业已起、还没交给服务"）。 */
const DISPATCH_PHASES = new Set([
  '',
  'connecting',
  'resolving-session',
  'creating-session',
  'setting-model',
  'prompting',
]);

/** 执行中：见文件头「映射依据」表的第二组（'fetching-receipt' 是文档别名，一并接受）。 */
const RUNNING_PHASES = new Set(['waiting', 'receipt', 'fetching-receipt']);

/**
 * 单条 RunRecord → 四态投影行。
 *
 * @param {{sessionKey?: string, sessionId?: string, startedAt?: number, phase?: string}} [record]
 * @param {number} [now] 判定时刻（ms；测试可注入）
 * @returns {{state: string, label: string, phase: string, sessionKey: string, sessionId: string,
 *   startedAt: number|null, waitedMs: number|null}}
 *   - `state` 机器枚举；`label` 四态中文标签（未知 ⇒ '未知'）；
 *   - `phase` 原样回传（未知值不吞原文 —— 复核用）；
 *   - `waitedMs`：now - startedAt（时钟回拨夹 0；startedAt 不是有限数 ⇒ null —— 不猜）。
 */
export function projectRunRecord(record = {}, now = Date.now()) {
  const phase = typeof record?.phase === 'string' ? record.phase : '';
  let state;
  if (RUNNING_PHASES.has(phase)) state = IN_FLIGHT_STATES.RUNNING;
  else if (DISPATCH_PHASES.has(phase)) state = IN_FLIGHT_STATES.DISPATCHING;
  // ★ 未知 phase 不硬塞四态：宁可说'未知'，也不许塞成压缩中（无信号）或已结束（在途表里必为未结束）。
  else state = IN_FLIGHT_STATES.UNKNOWN;

  const startedAt = typeof record?.startedAt === 'number' && Number.isFinite(record.startedAt)
    ? record.startedAt
    : null;
  const waitedMs = startedAt === null ? null : Math.max(0, now - startedAt);

  return {
    state,
    label: IN_FLIGHT_STATE_LABELS[state],
    phase,
    sessionKey: typeof record?.sessionKey === 'string' ? record.sessionKey : '',
    sessionId: typeof record?.sessionId === 'string' ? record.sessionId : '',
    startedAt,
    waitedMs,
  };
}

/**
 * lastRun 的判定枚举（回答的唯一问题：**这一轮有没有最终回执？**）。
 * 与四态的关系：`finished` 即四态之「已结束」；`running`/`unresolved` 都**不是**已结束。
 */
export const LAST_RUN_STATES = Object.freeze({
  FINISHED: 'finished',
  /** 等待没拿到终态，任务可能仍在 OpenCode 侧跑（含停在审批）。 */
  RUNNING: 'running',
  /** 会话已 idle，但本轮没有终态回执（如 receipt_missing）—— 不认结束，也无法断言在跑。 */
  UNRESOLVED: 'unresolved',
  /** 任务根本没被受理（下发面失败）—— 不存在"未结束的任务"。 */
  NOT_STARTED: 'not-started',
  /** 还没有任何一轮。 */
  NONE: 'none',
});

/** 服务端结构化终态三值（Session.Info.outcome；recon §11）。 */
const TERMINAL_OUTCOMES = new Set(['succeeded', 'failed', 'interrupted']);

/**
 * lastRun → 是否已有「终态回执/结论」（★ 硬红线：无最终回执的在途任务绝不能被当成已结束）。
 *
 * 判据与 dispatch 的判定链同源：
 *   - judge()（dispatch.js:301-314）：timeout/aborted/error **不判成败**（不许拿旧回执冒充本轮）；
 *     idle-204 且无终态 outcome ⇒ RECEIPT_MISSING（dispatch.js:313）；
 *   - receiptView()（dispatch.js:321-330）：非 idle-204 时刻读到的 outcome/reply 一律置 null（新鲜度闸）；
 *   - 这里再对 outcome 的存在**重验 idle-204**（双保险）—— 就算记录里混进"旧 succeeded"，也不认已结束。
 *
 * 返回 {state, finished, note}：
 *   - finished=true 仅当 waitStatus==='idle-204' 且 outcome ∈ {succeeded,failed,interrupted}；
 *   - note 是人读的一句（工具面直出）；'' = 无需补充说明（已结束 / 没跑起来 / 还没有记录）。
 *
 * @param {object|null|undefined} last LastRunRecord（types/index.js:59-79）
 * @returns {{state: string, finished: boolean, note: string}}
 */
export function projectLastRun(last) {
  if (last === null || last === undefined || typeof last !== 'object') {
    return { state: LAST_RUN_STATES.NONE, finished: false, note: '' };
  }
  const outcome = typeof last.outcome === 'string' ? last.outcome : null;
  const waitStatus = typeof last.waitStatus === 'string' ? last.waitStatus : null;
  const reason = typeof last.reasonCode === 'string' ? last.reasonCode : '';

  // ① 终态回执：有就是有（outcome 由 receiptView 的新鲜度闸背书，这里再验 idle-204）。
  if (waitStatus === 'idle-204' && outcome !== null && TERMINAL_OUTCOMES.has(outcome)) {
    return { state: LAST_RUN_STATES.FINISHED, finished: true, note: '' };
  }
  // ② 停在审批：judge 把它放在最前（最可行动）；任务没结束。
  if (reason === 'approval_pending') {
    return {
      state: LAST_RUN_STATES.RUNNING,
      finished: false,
      note: 'it is stopped at an approval request — not finished (no receipt ≠ finished); '
        + 'answer it with opencode_approvals, then re-attach with wait_only:true.',
    };
  }
  // ③ 等待没收敛：任务可能仍在 OpenCode 侧跑 —— 这一轮没有回执，更谈不上结束。
  if (waitStatus === 'timeout' || waitStatus === 'aborted') {
    return {
      state: LAST_RUN_STATES.RUNNING,
      finished: false,
      note: 'the task may still be running on the OpenCode side — not finished (no receipt ≠ finished); '
        + 're-attach with wait_only:true to wait for the outcome.',
    };
  }
  // ④ 会话 idle 但无终态回执（receipt_missing 等）：不许把"空转"折成"结束"。
  if (waitStatus === 'idle-204') {
    return {
      state: LAST_RUN_STATES.UNRESOLVED,
      finished: false,
      note: 'the session went idle but this round produced no terminal receipt (receipt_missing) — '
        + 'not finished (no receipt ≠ finished).',
    };
  }
  // ⑤ 其余（下发面失败：prompt_rejected / service_missing / bad_args…）：任务没被受理，无"未结束"可言。
  return { state: LAST_RUN_STATES.NOT_STARTED, finished: false, note: '' };
}
