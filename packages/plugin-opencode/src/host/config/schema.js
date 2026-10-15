/**
 * settings schema（★ 唯一真源：本文件 ↔ `cordis.patch.yml` ↔ 设置卡片三处同步；
 * 由 `tools/ci/check-consumed-knobs.mjs` 强制校验）。
 *
 * 通道事实出处：`00-recon/OPENCODE-LOCAL-RECON-20261015.md`（§1 鉴权 / §11 live 探针）。
 *
 * ★ volatile 纪律（承接 plugin-workbuddy 的真机教训）：凡是用 `settings.update` 落盘的字段
 *   必须是 volatile —— 宿主 `dsh-settings` 会拒绝非 volatile 的写入，且该拒绝走 rejected
 *   Promise ⇒ 配上 `void` 就是 unhandled rejection ⇒ **宿主退出**。本文件里 `sessions` 是
 *   插件自己写的（会话映射落盘位），必须 volatile；`launch.*` 是**数据表**（不经 settings 写），
 *   保持普通字段。volatile ≠ 露在设置页 —— 渲染哪几行由 `lib/client.js` 决定。
 *
 * ★ H-NO-FABRICATED-DEFAULT：未指定 = 空串，不发明默认值。`''` 的语义逐字段写在注释里。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  // ★★ 授权总闸：`enabled !== true` ⇒ 工具面与轮询面**一处都不注册**。
  //   默认 `false` 是**对外契约**：`cordis.patch.yml` 的字面量必须与本默认值一致（test:host 断言）。
  enabled: z.boolean().default(false).volatile(),
  // 默认模型引用，'providerID/id' 形态（如 'opencode/deepseek-v4.1-flash-free'）。
  // '' = 未指定 ⇒ 建会话时不带 model，用服务默认。
  model: z.string().default('').volatile(),
  // 推理档位（opencode 的 `Model.Ref.variant`）。值域是**服务实况**：`/api/model` 的
  // `variants[].id`（对象数组 {id, settings}；如 deepseek-v4.1-flash-free 的 low/high/max
  // —— settings.reasoningEffort 映射）。'' = 未指定 ⇒ 用模型默认档。
  variant: z.string().default('').volatile(),
  // 新建会话的默认工作目录（会话复用时不生效 —— 既有会话保持它自己的目录）。
  // '' = 不上报 location，用服务端默认。
  workspace: z.string().default('').volatile(),
  // 用户显式绑定的会话 id（ses_…；'' = 没绑）。绑定后**只**把任务下发给这一条；
  // 优先级高于会话记性（key 亲和）—— 人指定的压过自动的。
  boundSessionId: z.string().default('').volatile(),
  // 服务发现目录覆盖（'' = 自动发现：~/.local/state/opencode → ~/.config/opencode）。
  // service.json 就在其中（{url, pid, version, password}）。
  serviceDir: z.string().default('').volatile(),
  // 服务基址覆盖（'' = 用 service.json 的 url）。鉴权始终来自 service.json —— 本插件
  // **不设**凭据输入框（不把口令引进 settings 树）。
  baseUrl: z.string().default('').volatile(),
  // 单轮等待上限（毫秒）。等待 = `POST /api/experimental/session/{id}/wait`（会话转 idle 时
  // 204）+ 本插件的 AbortController 超时。默认 15 分钟（900_000ms）：与 workbuddy 的
  // 自动化超时同口径 —— 慢盘/冷启动/长任务下 15 分钟是"用户愿意盯作业"的量级；
  // 超时不解除任务，只是把在途态如实回传（回执给 waitStatus:'timeout' 与当轮现状）。
  waitTimeoutMs: z.number().default(900_000).volatile(),
  // ★ 会话映射落盘位（key → {sessionId, cwd, lastUsedAt, own, …}），由本插件自己写入。
  //   `z.dict(z.any())`：任意键 + 任意值 —— 用户手改坏记录不会让**整份 namespace 校验失败**
  //   （而类型净化在写入前做：session/map.js `sanitizeRecord`）。
  sessions: z.dict(z.any()).default({}).volatile(),
  // ★ 档位数据表（**不是旗标**，与 plugin-workbuddy 的 launch.effortValues 同构）：
  //   模型 → 档位域覆盖/补充。基线 `{}` = 完全用服务实况。
  //   真实消费者 = 状态路由导出的 `variantCapability(config)`（红线行为探针按包指名，
  //   见 tools/ci/check-consumed-knobs.mjs 的 PROBE_TARGETS）；卡片用服务实况渲染档位下拉，
  //   本表仅作覆盖/离线兜底 ⇒ 表里没有的模型不受影响。
  launch: z.object({
    variantValues: z.object({}).default({}),
  }).default({}),
});
