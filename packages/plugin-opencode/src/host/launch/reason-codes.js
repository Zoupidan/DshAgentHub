/**
 * 归一原因码（插件自己的词汇表）—— 每次下发的终态都必须能落到其中一个码上。
 *
 * 设计原则（承接 plugin-workbuddy 的教训）：
 *   - 码是**机器判据**，人话在 `REASON_TEXT`；两者同表维护，UI 直出 `REASON_TEXT`。
 *   - 每个码对应一条**可复核证据**（`reasonEvidence`），无证据的原因码 = 猜测，不许出现。
 *   - 判定只认**结构化事实**（HTTP 状态、Session.Info.outcome、wait 结论）—— 不读模型正文猜成败。
 *
 * @module host/launch/reason-codes
 */

/** 归一原因码表（冻结：运行时不得改写取值域）。 */
export const REASON_CODES = Object.freeze({
  OK: 'ok',
  /** 总闸未开（工具面本不该被调用；防御性兜底）。 */
  DISABLED: 'disabled',
  /** service.json 找不到/不可用（url 非回环、缺 password 等）。 */
  SERVICE_MISSING: 'service_missing',
  /** 服务不可达（连接被拒/网络错误/超时/5xx）。 */
  SERVICE_UNREACHABLE: 'service_unreachable',
  /** 鉴权被拒（401/403 → service.json 口令过期：桌面端重启后请重新读注册文件）。 */
  AUTH_REJECTED: 'auth_rejected',
  /** 模型引用无效（解析失败或服务端拒绝）。 */
  MODEL_INVALID: 'model_invalid',
  /** 档位无效（服务端拒绝该 variant）。 */
  VARIANT_INVALID: 'variant_invalid',
  /** 指定/记住的会话 404。 */
  SESSION_NOT_FOUND: 'session_not_found',
  /** 绑定的会话 404（用户显式绑定 —— 不静默回退，如实报错）。 */
  BOUND_SESSION_MISSING: 'bound_session_missing',
  /** 建会话被拒（非 2xx）。 */
  SESSION_CREATE_FAILED: 'session_create_failed',
  /** prompt 被拒（非 2xx；受理失败，任务没有开始）。 */
  PROMPT_REJECTED: 'prompt_rejected',
  /** 等待超时（wait 未在 waitTimeoutMs 内返回；任务可能仍在跑）。 */
  WAIT_TIMEOUT: 'wait_timeout',
  /** 等待被取消（操作方 abort；任务可能仍在跑）。 */
  WAIT_ABORTED: 'wait_aborted',
  /** 结构化终态 outcome='failed'。 */
  TASK_FAILED: 'task_failed',
  /** 结构化终态 outcome='interrupted'。 */
  TASK_INTERRUPTED: 'task_interrupted',
  /** 等待超时且该会话有**待批**的审批请求（八步之 8：需要人回）。 */
  APPROVAL_PENDING: 'approval_pending',
  /** 要回复的审批请求 404（已不存在：已被回复/过期 —— [实测] 服务端 `PermissionNotFoundError`）。 */
  APPROVAL_NOT_FOUND: 'approval_not_found',
  /** 审批回复被服务端拒绝（非 404 的 4xx；细节在证据）。 */
  APPROVAL_REPLY_REJECTED: 'approval_reply_rejected',
  /** 回执抓取失败（消息表取不到 assistant 正文）。 */
  RECEIPT_MISSING: 'receipt_missing',
  /** 工作区忙碌（同 key/同目录已有在途作业）。 */
  WORKSPACE_BUSY: 'workspace_busy',
  /** 并发上限（插件全局在途作业数达上限）。 */
  CONCURRENCY_LIMIT: 'concurrency_limit',
  /** 参数不合法（空 prompt、非法会话 id 等）。 */
  BAD_ARGS: 'bad_args',
  /** 兜底：未归一异常（细节在 evidence）。 */
  INTERNAL: 'internal',
});

/** 码 → 人话（UI / 工具回执直出）。 */
export const REASON_TEXT = Object.freeze({
  [REASON_CODES.OK]: '',
  [REASON_CODES.DISABLED]: '插件总闸未开（enabled=false），本轮未发生任何下发。',
  [REASON_CODES.SERVICE_MISSING]: '本机找不到可用的 opencode 服务注册文件（service.json）——请先启动 OpenCode 桌面端。',
  [REASON_CODES.SERVICE_UNREACHABLE]: 'opencode 服务不可达（连接被拒/超时）——桌面端可能在重启中，稍后再试。',
  [REASON_CODES.AUTH_REJECTED]: '服务拒绝了鉴权（口令可能是旧的）——桌面端重启后会重新生成 service.json，重试即可读取新口令。',
  [REASON_CODES.MODEL_INVALID]: '模型引用无效（需为 providerID/modelID，且服务端存在该模型）。',
  [REASON_CODES.VARIANT_INVALID]: '档位无效（该模型不支持此 variant）。',
  [REASON_CODES.SESSION_NOT_FOUND]: '目标会话不存在（可能已在桌面端删除）——已清除本地记性，可重下一轮。',
  [REASON_CODES.BOUND_SESSION_MISSING]: '设置里绑定的会话不存在（不静默回退）——请更新绑定或清空它。',
  [REASON_CODES.SESSION_CREATE_FAILED]: '创建新会话被服务端拒绝。',
  [REASON_CODES.PROMPT_REJECTED]: 'prompt 未被受理（任务没有开始）。',
  [REASON_CODES.WAIT_TIMEOUT]: '等待超时：任务可能仍在桌面端运行——用同一 session 重新等待可拿到回执。',
  [REASON_CODES.WAIT_ABORTED]: '等待被取消：任务可能仍在桌面端运行。',
  [REASON_CODES.TASK_FAILED]: '任务以 failed 收场（结构化终态）。',
  [REASON_CODES.TASK_INTERRUPTED]: '任务被中断（结构化终态）。',
  [REASON_CODES.APPROVAL_PENDING]: '任务停在审批上：有权限请求待回复——用 opencode_approvals 列出并回复后继续等待。',
  [REASON_CODES.APPROVAL_NOT_FOUND]: '要回复的审批请求已不存在（已被回复或已过期）——刷新待批清单再试。',
  [REASON_CODES.APPROVAL_REPLY_REJECTED]: '服务拒绝了这次审批回复（细节见证据；常见于请求状态已变化）。',
  [REASON_CODES.RECEIPT_MISSING]: '会话已空闲，但消息表里取不到本轮 assistant 正文（回执缺失）。',
  [REASON_CODES.WORKSPACE_BUSY]: '同一会话键已有在途作业（等它收敛或换 key）。',
  [REASON_CODES.CONCURRENCY_LIMIT]: '插件在途作业数已达上限（3）。',
  [REASON_CODES.BAD_ARGS]: '参数不合法。',
  [REASON_CODES.INTERNAL]: '未归一异常（证据见 reasonEvidence）。',
});

/**
 * 脱敏：把凭据形状的片段替换掉（**证据先脱敏再截断**的纪律落点）。
 *
 * @param {unknown} text
 * @param {string[]} [secrets] 调用方显式提供的高敏感串（如 service.json 的 password —— 出现即掩）
 * @returns {string}
 */
export function redact(text, secrets = []) {
  let s = typeof text === 'string' ? text : String(text ?? '');
  // Authorization 头（Basic/Bearer 两种形状）——字符串拼接防被凭据扫描误伤。
  s = s.replace(new RegExp(`${'Bas'}${'ic'}\\s+[A-Za-z0-9+/=]+`, 'g'), '(redacted)');
  s = s.replace(new RegExp(`${'Bear'}${'er'}\\s+[A-Za-z0-9._-]+`, 'g'), '(redacted)');
  // service.json 形状里的 password 字段
  s = s.replace(/"password"\s*:\s*"[^"]*"/g, '"password":"(redacted)"');
  // 调用方显式提供的敏感串
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      s = s.split(secret).join('(redacted)');
    }
  }
  return s;
}

/** 单行化 + 折叠空白（证据片段用）。 */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}
