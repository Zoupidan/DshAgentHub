/**
 * host 端常量 —— ★ **只放本插件自己的旋钮** ★
 *
 * ★ 与宿主协议词汇表的分工 ★
 *   本文件：探测目标、输出上限、服务发现路径……**按 agent 产品不同而不同**的东西。
 *   `./host-protocol.js`：状态载荷用的那几个**协议字面值** —— 改了会直接和宿主对不上。
 *
 * Implements: 00-recon/OPENCODE-LOCAL-RECON-20261015.md §1（service.json 注册文件）/
 *             §11（live 探针的形状事实）
 * 约束：本文件在 src 下（CI ② 进程出口审计扫描范围）——
 *       全文件不得出现裸进程出口字样（本插件**没有**进程出口：只读 fs + HTTP）。
 */
import { join } from 'node:path';

import { REGISTRY_STATES, RUN_STATES } from './host-protocol.js';

// 再导出：引用面（tools/status/prompts 与测试的 `mods.constants.REGISTRY_STATES`）一字不动。
export { REGISTRY_STATES, RUN_STATES };

/** 探测目标标识（ProbeResult 形态用；本包固定 'opencode'）。 */
export const PROBE_TARGET = 'opencode';

/**
 * 家目录环境变量名（测试用；**优先于** HOME/USERPROFILE）。
 * 为什么单开一个变量：测试（`tools/dev/test-home-guard.mjs`）只设它的假家目录，
 * 若探测直接读真实 `~/.local/state/opencode/` 就会**读用户数据** —— 与"写用户数据"同级的事故。
 */
export const OPENCODE_HOME_ENV = 'DSH_OPENCODE_HOME';

/** 服务注册文件的候选相对路径段（相对家目录；第一命中即胜出）。 */
export const SERVICE_STATE_SEGMENTS = ['.local', 'state', 'opencode', 'service.json'];
export const SERVICE_CONFIG_SEGMENTS = ['.config', 'opencode', 'service.json'];

/** 候选路径（config.serviceDir 覆盖优先，其余按家目录展开）。 */
export function serviceJsonCandidates(home, serviceDir = '') {
  const out = [];
  if (typeof serviceDir === 'string' && serviceDir !== '') out.push(join(serviceDir, 'service.json'));
  out.push(join(home, ...SERVICE_STATE_SEGMENTS));
  out.push(join(home, ...SERVICE_CONFIG_SEGMENTS));
  return out;
}

/** 作业输出上限（ctx.jobs.start 的 outputLimitBytes；与 workbuddy 同口径 64 KiB）。 */
export const OUTPUT_LIMIT_BYTES = 64 * 1024;

/** 回执正文（assistant content[].text 拼接）在记录里的保留上限 —— 超出截断并如实标注。 */
export const REPLY_LIMIT_CHARS = 8 * 1024;

/** prompt 摘录（单行化后）上限 —— 状态载荷/回执里的 `promptExcerpt`。 */
export const PROMPT_EXCERPT_LIMIT = 200;

/** 原因证据片段上限（归一判据所用证据，脱敏后截断）。 */
export const REASON_EVIDENCE_LIMIT = 200;

/** 工作区并发上限（同 sessionKey 串行、全局并行上限；与 workbuddy 同口径 3）。 */
export const MAX_CONCURRENT_RUNS = 3;

/** 会话映射摘要行上限（状态载荷 / 工具面）。 */
export const SESSION_SUMMARY_LIMIT = 20;

/** 审批列表在状态载荷里最多带几条明细。 */
export const APPROVAL_ITEMS_LIMIT = 10;
