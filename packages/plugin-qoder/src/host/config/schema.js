/**
 * settings schema（★ 唯一真源：本文件 ↔ `cordis.patch.yml` ↔ 设置卡片三处同步；
 * 由 `tools/ci/check-consumed-knobs.mjs` 强制校验）。
 *
 * 通道事实出处：`04-docs/qoder/14/15`（CDP 9333 + applicationInvoke）。
 * volatile 纪律：会被 settings.update 落盘的字段必须 volatile（sessions/signin 状态面由宿主/运行时写入）。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  // ★★ 授权总闸：`enabled !== true` ⇒ 工具面与轮询面**一处都不注册**。
  enabled: z.boolean().default(false).volatile(),
  // Qoder CDP 端口（默认 9333；9222 为 WorkBuddy 保留）。
  cdpPort: z.number().default(9333).volatile(),
  // 默认模型 key（'' = 不指定，沿用会话/服务端默认；值来自 listChatModels.modelKey）。
  model: z.string().default('').volatile(),
  // 思考强度（'' = 不指定；仅在目标模型 efforts 含该档时下发；submitRich 入参待验 → unknown 时不伪造）。
  reasoningEffort: z.string().default('').volatile(),
  // 上下文窗口（0 = 不指定；仅在模型 availableContextWindows 含该档时下发）。
  contextWindow: z.number().default(0).volatile(),
  // 默认工作目录（'' = 不指定；新会话需要 workspace）。
  workspace: z.string().default('').volatile(),
  // 绑定的 Qoder workspaceId（'' = 运行时按 workspace/cwd 推断；推断失败如实报错）。
  workspaceId: z.string().default('').volatile(),
  // 用户显式绑定的会话 id（UUID；'' = 没绑）。绑定后优先下发。
  boundSessionId: z.string().default('').volatile(),
  // Qoder endpointId 缓存（'' = 运行时从 system.describe 读取）。
  endpointId: z.string().default('').volatile(),
  // 单轮等待上限（毫秒）。超时不解除任务，只如实回传在途态。
  waitTimeoutMs: z.number().default(900_000).volatile(),
  // ★ 会话映射落盘位（插件自行写入）。z.dict(z.any()) 防手改坏记录炸掉整份 namespace。
  sessions: z.dict(z.any()).default({}).volatile(),
  // 签到/积分运行态元数据（不存凭据；真实 PAT 在 DSH_HOME vault）。
  signin: z.dict(z.any()).default({}).volatile(),
  // ★ 档位/能力数据表（**不是旗标**；真实消费者 = 状态路由导出的 capability(config)）。
  launch: z.object({
    effortValues: z.object({}).default({}),
    contextWindowValues: z.object({}).default({}),
  }).default({}),
});
