/**
 * ★ 唯一跨 host / client 的常量文件（本文件为 plugin-opencode 版）。
 *
 * 通道事实出处：`00-recon/OPENCODE-LOCAL-RECON-20261015.md`（含 2026-10-15 live 探针 §11）。
 * 约束：本文件属于 packages/*​/src —— CI ② 扫描范围内，不得出现裸进程出口字样。
 */

/**
 * cordis 行 id（短名）—— 与 `cordis.patch.yml` 的 `id:` 保持一致。
 * 实证（plugin-workbuddy 同款）：loader 只用 patch 行的 `name:` 作为 import specifier；
 * 行 `id` 是行标识，**必须等于 NS（= 包名）**，否则 `settings.update()` 抛 `No configurable plugin entry`。
 */
export const PLUGIN_ID = 'plugin-opencode';

/** npm 包名（= client 模块 id / slot id；行 `name:` 字段用它加载）。 */
export const PACKAGE_NAME = 'dsh-plugin-opencode';

/** settings namespace（须匹配 lowercase hyphenated identifier；用包名即合法）。 */
export const NS = PACKAGE_NAME;

/**
 * ★ 2026-10-15 hub 合并：设置导航栏父条目「Harness 接入」（dsh-plugin-harness-hub）的
 *   **子标签槽**与本条目的标签位。client bundle 手写同名字面量（bundle 不能 import 本文件），
 *   由 client.test.js 的"常量同步"用例钉住；hub 包的 client.test.js 另有跨包同步断言。
 */
export const HUB_TAB_SLOT = 'settings.harness-hub.tab';
export const HUB_TAB_ID = 'opencode';
export const HUB_TAB_ORDER = 20;

/** 模型可见工具名（注册/注销以这几个常量为准）。 */
export const TOOL_RUN = 'opencode_run';
export const TOOL_STATUS = 'opencode_status';
/** 精准清理会话（硬删语义 —— opencode 的 DELETE 是硬删，见 recon §11）。 */
export const TOOL_PURGE = 'opencode_purge';
/** 审批面（八步之 8）：列出待批请求 / 回复决定。 */
export const TOOL_APPROVALS = 'opencode_approvals';

/** 状态 bridge 路由前缀（host 注册 · client 消费）。 */
export const ROUTE_PREFIX = '/plugin-opencode';
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`;
export const ROUTE_DIAGNOSTICS = `${ROUTE_PREFIX}/diagnostics`;

/**
 * 会话 ID 形态判据 —— `ses_` + [A-Za-z0-9]+。
 * 实机样本（2026-10-15 live 探针）：`ses_ec039b26effeFSRxqFRSQfPfba`。
 */
export const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/;

/** 消息 ID 形态（prompt 受理回执 id / 消息表 id 共用）：`msg_` + [A-Za-z0-9]+。 */
export const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]+$/;
