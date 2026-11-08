/**
 * ★ 唯一跨 host / client 的常量文件（plugin-qoder 版）。
 *
 * 通道事实出处：`04-docs/qoder/14-对齐总评估与技术方案.md`、
 * `04-docs/qoder/15-真机点火实验记录-20261031.md`（CDP 9333 + applicationInvoke，
 * submitRich/readHistory/listChatModels/catalog.list；回执读 WAL 副本）。
 *
 * 约束：本文件属于 packages/plugin-qoder/src —— CI ② 扫描范围内，不得出现裸进程出口字样。
 */

export const PLUGIN_ID = 'plugin-qoder';
export const PACKAGE_NAME = 'dsh-plugin-qoder';
export const NS = PACKAGE_NAME;

/** 探测目标标识（runtime / probeState 的 target 字段）。 */
export const PROBE_TARGET = 'qoder';

/** harness-hub 子标签槽（client bundle 手写同名字面量；由 client.test.js 钉住）。 */
export const HUB_TAB_SLOT = 'settings.harness-hub.tab';
export const HUB_TAB_ID = 'qoder';
export const HUB_TAB_ORDER = 30;

export const TOOL_RUN = 'qoder_run';
export const TOOL_STATUS = 'qoder_status';
export const MEMBER_NAME = 'qoder';

export const ROUTE_PREFIX = '/plugin-qoder';
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`;
export const ROUTE_DIAGNOSTICS = `${ROUTE_PREFIX}/diagnostics`;
export const ROUTE_SIGNIN = `${ROUTE_PREFIX}/signin`;
export const ROUTE_SIGNOUT = `${ROUTE_PREFIX}/signin/logout`;
export const ROUTE_USAGE = `${ROUTE_PREFIX}/credits`;
export const ROUTE_CLAIM = `${ROUTE_PREFIX}/claim`;
export const ROUTE_STARTUP = `${ROUTE_PREFIX}/startup`;
export const ROUTE_TASK_DELETE = `${ROUTE_PREFIX}/tasks/delete`; // 兼容探测面；Qoder 无计划任务，永远返回 not_applicable

/** Qoder CN CDP 调试端口（默认；WorkBuddy 用 9222）。 */
export const DEFAULT_CDP_PORT = 9333;

/** Qoder 会话 ID 形态（UUID）。 */
export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Qoder 主库（只读复核；实时真源是宿主 API）。必须连同 -wal/-shm 拷贝到临时副本再读。 */
export const QODER_DB_DIR = 'com.qodercn.app.stable';
export const QODER_DB_NAME = 'main.sqlite';

/** PAT 形态（CN 先行）。 */
export const PAT_PREFIX = 'pt-';
export const PAT_PATTERN = /^pt-[A-Za-z0-9_-]{8,}$/;

/** 签到/积分协议来源（MIT，必须在 README/代码头保留致谢）。 */
export const SIGNIN_ATTRIBUTION = '协议参考 dingminhua/dsh-connect-qoder (MIT) + L0NE-6/Qoder-Daily';
