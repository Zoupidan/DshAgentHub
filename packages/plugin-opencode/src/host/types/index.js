/**
 * host 端类型（JSDoc typedef）—— 纯文档，无运行时代码。
 *
 * 本仓库为 JS（非 TS）；类型以 JSDoc 表达。**形状即契约**：
 * `lib/client.js`（设置卡片）与状态路由按这里的字段名渲染/装载，改字段名 = 改契约。
 *
 * 证据分级：字段的必要性来自 `00-recon/OPENCODE-LOCAL-RECON-20261015.md`（含 §11 live 探针）
 * 与 CHARTER §4 八步契约；`[实测]` 样本见 recon。
 */

/**
 * 只读探测的证据条目（"查了哪些地方"逐条留痕）。
 * @typedef {Object} ProbeEvidence
 * @property {number} at 记录时刻（ms）
 * @property {string} method 'read-only'（本插件探测只用 fs 只读：statSync/readFileSync）
 * @property {string} target 被查路径（service.json 候选等）
 * @property {string} detail 该处的结论（存在/不存在/内容要点；**不得**含凭据）
 */

/**
 * 只读探测结果（U6 / H-NO-EXEC-PROBE：不启动任何程序，只读 service.json 与 pid 活性）。
 * @typedef {Object} ProbeResult
 * @property {boolean} installed 本机是否存在可用的 opencode 服务
 * @property {string} reason 结论码（'ok' | 'service-missing' | 'pid-dead' | 'unreachable' …）
 * @property {string} servicePath 命中的 service.json 路径（'' = 没找到）
 * @property {string} baseUrl 服务基址（如 http://127.0.0.1:49374；'' = 未知）
 * @property {string} version 服务版本（如 '2.0.28'；'' = 未知）
 * @property {number|null} pid 服务进程（null = 未知）
 * @property {ProbeEvidence[]} evidence 探测留痕（逐处）
 * @property {number} at 结论时刻（ms）
 * @property {string} method 'read-only'
 */

/**
 * 探测在途态（三态协议的一半：`pending:<reason>` 时 in-flight 不算 unavailable）。
 * @typedef {Object} ProbeState
 * @property {'idle'|'pending'|'done'} status
 * @property {ProbeResult|null} result
 * @property {string} pendingReason （status==='pending' 时）'detection-in-flight' | 'detection-not-started'
 */

/**
 * 在途作业记账（in-flight run map）。
 *
 * 四态投影（下发中/执行中/压缩中/已结束）见 `launch/in-flight-states.js` —— 判定只认下面列的真实值，
 * 未知值不许硬塞成任一态（尤其不许塞成"压缩中/已结束"）。
 * @typedef {Object} RunRecord
 * @property {string} sessionKey 亲和键
 * @property {string} sessionId opencode 会话 id（'' = 还没建出来）
 * @property {number} startedAt 开始时刻（ms）
 * @property {string} phase 阶段。**实际发出值**（dispatch.js 的 onPhase）：
 *   ''（首个 phase 未到；run.js:169）| 'connecting' | 'resolving-session' | 'creating-session'
 *   | 'setting-model' | 'prompting' | 'waiting' | 'receipt'。
 *   注：本文档曾写 'fetching-receipt'，但代码从未发出该拼写（实际为 'receipt'）——
 *   投影两个拼写都接受；该不一致已登记在任务报告，未改发出值（改它会改 job_output 的行文）。
 */

/**
 * 最近一轮下发的完整证据面（状态载荷 / `opencode_status.lastRun` 共用）。
 *
 * ★ 纪律（承接 plugin-workbuddy 的教训）：
 *   - 成功也带正文（`reply`）—— "成功了但没有回执正文"是不可接受的形态；
 *   - `outcome` 只认服务端结构化字段（Session.Info.outcome）+ wait 结论，**不读模型正文猜成败**；
 *   - 证据**先脱敏再截断**（password 不得出现在任何字段里）。
 *
 * @typedef {Object} LastRunRecord
 * @property {string} sessionId 目标会话（'' = 未建出）
 * @property {string} sessionKey 亲和键
 * @property {boolean} resumed 本轮是复用（true）还是新建（false）
 * @property {string} promptExcerpt 下发文本摘录（脱敏截断后的单行）
 * @property {string} delivery prompt 投递方式（'steer'|'queue'；'' = 未指定）
 * @property {number|null} acceptedAt prompt 受理时刻（ms；null = 没到这一步）
 * @property {number|null} idleAt wait 返回时刻（ms；null = 没等到 idle）
 * @property {string|null} waitStatus wait 的结论（'idle-204'|'timeout'|'aborted'|'error'|null）
 * @property {'succeeded'|'failed'|'interrupted'|null} outcome 服务端结构化终态
 * @property {string} reply assistant 正文（content[].type==='text' 拼接；截断）
 * @property {Array<{requestID: string, action: string, source: string, state: 'pending'|'replied', decision: string}>} permissionRequests
 *   本轮遇到的审批请求（八步之 8 的证据面；state/decision 由 approvals 工具或 SSE 更新）
 * @property {{id: string, providerID: string, variant: string}|null} model 实际生效的模型引用
 * @property {number|null} cost 会话累计成本（USD；服务端 session.cost）
 * @property {{input: number, output: number, reasoning: number}|null} tokens 本轮 token 用量（服务端 assistant 消息）
 * @property {string} reasonCode 'ok' | REASON_CODES 之一
 * @property {string} reasonText 人可读原因（UI 直出；'' = 无）
 * @property {string} reasonEvidence 归一判据所用证据片段（脱敏后）
 * @property {number} at 记录时刻（ms）
 */

/**
 * 设置卡片配置视图（**已脱敏**：password 永不出现在载荷里）。
 * @typedef {Object} StatusConfigView
 * @property {boolean} enabled
 * @property {string} model 'providerID/id' 形态（'' = 服务默认）
 * @property {string} variant 档位（'' = 模型默认）
 * @property {string} workspace 新建会话默认目录（'' = 不上报，用服务端默认）
 * @property {string} boundSessionId 用户绑定的会话（'' = 没绑）
 * @property {string} serviceDir 服务发现目录覆盖（'' = 自动发现）
 * @property {string} baseUrl 服务基址覆盖（'' = service.json 的 url）
 * @property {number} waitTimeoutMs 单轮等待上限（ms）
 */

/**
 * 状态 bridge 载荷（GET /plugin-opencode/status；设置卡片与诊断消费）。
 * @typedef {Object} StatusPayload
 * @property {string} pluginId 'plugin-opencode'
 * @property {'UNKNOWN'|'SERVICE_MISSING'|'UNREGISTERED'|'REGISTERED'|'DEGRADED'} registry
 * @property {ProbeResult|null} probe
 * @property {StatusConfigView} config
 * @property {{model: string, values: string[], source: string}} variant
 *   当前默认模型可用的档位域（values 来自服务实况；source = 'service' | 'config' | 'unavailable:<reason>' | 'pending:<reason>' 三态）
 * @property {Array<{id: string, providerID: string, label: string, variants: string[], isFree: boolean|null, status: string, enabled: boolean}>} models
 *   isFree 三态：true（free 后缀/0 成本）｜false（付费）｜null（未知 —— 不得折成 false/true）
 * @property {string} modelsSource 三态：'service' | 'unavailable:<reason>' | 'pending:<reason>'
 * @property {Array<RunRecord>} inFlight 在途作业明细
 * @property {LastRunRecord|null} lastRun
 * @property {{pendingCount: number, items: Array<{sessionID: string, requestID: string, action: string, at: number}>}} approvals
 * @property {number} at 载荷时刻（ms）
 */

/** 会话摘要行（状态载荷 / 工具面共用；最多 20 条）。 */
/**
 * @typedef {Object} SessionSummaryRow
 * @property {string} sessionKey
 * @property {string} sessionId
 * @property {number} lastUsedAt
 * @property {boolean} own 插件自建（可回收）标记
 * @property {string} state 'resumable' | 'superseded' | 'unconfirmed' | 'untracked'
 */

export {};
