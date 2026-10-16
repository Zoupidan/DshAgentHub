# dsh-plugin-opencode

把本机 **OpenCode 桌面端**（2.0.28 实测）暴露成 DH（DeepSeek Harness）的模型面工具：
把编码任务下发给桌面端里一条**可见的会话**、读它的状态、收割回执、审批、精准清理。

> 一句话用法：在 DSH 对话里直接说"用 OpenCode 做 X"。挂了智能团队的组合里，模型会
> `spawn_teammate` 建一个名为 `opencode` 的成员，由它调用 `opencode_run` 下发——**工具面归成员身份所有**
> （v0.5.0「身份上移」），主会话不再直呼工具；未挂团队的组合自动回退为直呼工具的旧形态。
> 任务从头到尾都在桌面端 UI 里看得见（新会话出现在会话列表里，人可以在那里接手/围观）。

## 通道（与 workbuddy 根本不同，改动前必读）

- **唯一通道**：桌面端**自己的本机 HTTP 服务**。地址与口令在
  `%USERPROFILE%\.local\state\opencode\service.json`（`{id, version, url, pid, password}`；
  桌面端重启会换端口与口令 ⇒ 每次下发**现读**，不缓存）。
- **鉴权**：HTTP Basic，用户名固定 `opencode`，密码 = `service.json.password`。
  password 只在解析当刻与 HTTP 客户端内存里流转：不进日志、不进证据、不进任何载荷
  （CI 红线 `check-no-credential-echo` 钉死）。
- **零 CLI**：任何路径不得拉起 `opencode` CLI / Shell / 控制台进程
  （CI 红线 `check-no-process-exec` / `check-no-exec-probe` 钉死；本包 `src` 里没有 `child_process`）。
- **零反代**：不监听端口、不转发流量、不改写请求、不重托管模型路由（CHARTER §3 全局铁律）。
  插件是服务的**直接使用者**，仅此而已。
- **不启动、不重启桌面端**：服务不在 ⇒ 如实报 `service_missing`（含"查了哪些路径"的证据清单），
  由人去开桌面端。插件绝不代劳。

## 八步契约 ↔ 实现对应（CHARTER §4）

| 步骤 | 实现 | 端点（[实测]，见 `00-recon/OPENCODE-LOCAL-RECON-20261015.md`） |
|---|---|---|
| ① 创建对话 | 新建可见会话（标题默认 `dsh: <prompt 摘录>`） | `POST /api/session`（带 `location.directory`） |
| ② 指定工作目录 | 建会话时的 `location.directory`；复用既有会话时**不改**它的目录 | 同上（`location`） |
| ③ 指定模型 | 会话级设置（可在设置/逐次参数两处给） | `POST /api/session/{id}/model`，`Model.Ref={providerID,id,variant?}` |
| ④ 思考强度 | 同一 `Model.Ref` 的 `variant`（值域 = 服务实况的 `variants[].id`） | 同上 |
| ⑤ 任务下发 | 200 = **受理**，不等于完成；完成看 ⑦ | `POST /api/session/{id}/prompt` |
| ⑥ 会话复用 | `session_key` 记性（`bound > 显式 > 记性 > 新建`）；复用命中即续用同一可见会话 | —（本地记性 + `GET /api/session/{id}` 校验） |
| ⑦ 收到回执 | `wait` 到 idle → 读 `Session.Info.outcome` + 本轮 assistant 正文（**不读正文猜成败**） | `POST …/experimental/session/{id}/wait`（204）、`GET …/message` |
| ⑧ 审批 | wait 收敛后仍有待批权限请求 ⇒ 报 `approval_pending` + 清单；回复决定 | `GET …/permission`、`POST …/permission/{requestID}/reply`（`once|always|reject`） |

## 工具（4 个）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `opencode_run` | 下发一条任务（后台作业；`job_output` 读进度，`job_kill` 撤等待） | `prompt`（必填，或 `wait_only:true`）、`session_key`、`session_id`、`resume`、`wait_only`、`title`、`model`、`variant`、`workspace`、`delivery`、`wait_timeout_ms` |
| `opencode_status` | 只读状态：探测证据 / 模型实况清单 / 会话记性 / 最近回执 / 待批计数 | `reprobe` |
| `opencode_approvals` | 审批面：列待批 / 回复决定（`wait_ms>0` 顺带等续跑回执） | `action`、`request_id`、`decision`、`wait_ms` |
| `opencode_purge` | 清记性（默认档，不碰桌面端）；`remote:true` = 服务端**硬删**会话 | `session_key`、`session_id`、`remote` |

工具是否在场由两把闸决定：插件总开关 `enabled`（设置里可见）+ 服务探测结论。
关着时说"不可用"是真话（系统提示会明说），不假装在场。

> ★ 2026-10-17（v0.5.0）**身份上移**：组合挂载了智能体团队时，这 4 个工具**只对名为 `opencode`
> 的团队成员可见**（注册在成员自己的作用域），主会话（Lead）的面上不出现——委派必须经团队面；
> 团队服务缺席时回退为全局注册（与 0.1.x 相同）。

## 智能团队（Agent Teams）用法

组合挂载了智能团队时（v0.5.0 起为唯一形态）：4 件工具只对名为 `opencode` 的团队成员可见。

1. Lead 创建成员：`spawn_teammate(name="opencode", description="OpenCode · 你的工作通过调用 opencode_run 下发；不要自己实现任务")`
   （名字必须 lower-kebab-case；description 以产品名打头）；
2. `send_message` 派活；成员调用 `opencode_run` 把任务送进桌面端**可见会话**（八步契约同前）；
3. 成员把回执原文回传 Lead；对同一成员 `send_message` 可提异议（同一 `session_key` 应辩，成员职责提示已内建）。

**取消语义（写死在作业输出里）**：`job_kill` 只撤**等待** —— 会话在桌面端继续跑（它是用户可见的
会话，不是后台进程）。想拿回执：同 `session_key` 再发 `wait_only:true`。

## 设置键（schema 即契约）

| 键 | 缺省 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关（硬闸：OFF ⇒ 工具全部不在场，且不探测） |
| `model` | `''` | `providerID/id`（如 `opencode/deepseek-v4.1-flash-free`）；空 = 会话自身默认 |
| `variant` | `''` | 思考强度档位（如 `low/high/max`）；空 = 模型默认 |
| `workspace` | `''` | 新会话的 `location.directory`；空 = 服务默认目录 |
| `boundSessionId` | `''` | 绑定一条会话（最高优先；404 ⇒ 如实报错，**不静默回退**） |
| `serviceDir` | `''` | service.json 所在目录（缺省 `~/.local/state/opencode`） |
| `baseUrl` | `''` | 只改**地址**不改凭据来源；非回环地址一律拒绝（fail-closed） |
| `waitTimeoutMs` | `900000` | 等待 idle 的上限（工具侧再夹到 5s..1h；超时不杀任务） |
| `sessions` | `{}` | 会话记性（运行时写；volatile） |
| `launch.variantValues` | `{}` | 模型 → 档位域**数据表**（服务不可用时的离线兜底；空表 = 完全用服务实况） |

## 诚实登记（v0.1 能力边界）

- **已实测**：创建会话/设模型/prompt 受理/wait 204/回执精确匹配/`DELETE` 硬删（204→404）；
  审批面的**失败通道** —— 对已不存在的请求回复 ⇒ 服务端 404 `PermissionNotFoundError`，
  插件如实归因 `approval_not_found`（不许说成"服务不可达"）。
- **待验**（升级到桌面端 2.0.29 后复核；当前 2.0.29 更新已暂存但**不**重启服务）：
  - `permission.asked → reply` 的**完整闭环**（真实 tool-call 触发问询 → 回复 → 任务续跑）。
    程序化制造"待批请求"不可行：`POST /api/session/{id}/permission` 是**作答/授权**端点
    （返回 `{id, effect}`），不会产生待批清单条目 [实测 2026-10-15]；
  - 长任务 wait 超时后"同会话再等可拿回执"的边界行为；
  - **API 新建会话是否会把桌面端活动会话切走**（若是，属于桌面端自身行为，插件不改）。
- **v0.2 计划**：SSE（`GET /api/event`）实时审批面；subagent provider 面（把"派给 opencode"
  做成 dsh 的子智能体形态）；回执游标增量拉取。

## 维护者注记

- **安装方式**：profile 的 `node_modules/dsh-plugin-opencode` 是指向本目录的 Junction；
  改这里即对 profile 生效；运行中的 DSH 需重启才重读 patch。
- **`cordis.patch.yml`**：行 `id` 必须 = 包名（`dsh-plugin-opencode`），否则
  `settings.update()` 抛 `No configurable plugin entry`（workbuddy 同款教训）。
- **红线**：改动任何一条红线脚本（含 `check-consumed-knobs.mjs` 的 PROBE_TARGETS 覆盖表）
  之前先写论证报告（本包 2026-10-15 已登记：探针覆盖表新增本包一行）。
- **本机事实文件**：`00-recon/OPENCODE-LOCAL-RECON-20261015.md`（本地资料，gitignore）。
