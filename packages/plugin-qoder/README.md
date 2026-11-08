# dsh-plugin-qoder (v0.1.0)

把本机 **Qoder CN** 桌面端纳入 DshAgentHub / dsh 控制平面的第三个 harness 插件（WorkBuddy ✓ / OpenCode ✓ / **Qoder 进行中 → 本包首版**），注册在「Harness 接入」父设置页的 `Qoder` 标签下。

## 通道（事实边界）

- **CDP**：`--remote-debugging-port=9333`（默认；9222 为 WorkBuddy 保留）。
- **页面 JS 桥**：`window.qoderDesktop.applicationInvoke({connectionId,requestId,method,input})`。
- **已用方法**（实机 0.5.6 验证/按运行时可用性降级）：`system.describe`、`models.getCatalog`（`fetchStrategy:'cache'`，模型/思考/上下文目录）/ 兼容 `listChatModels`、`workspaces.list`（工作区解析）、`chatSessions.submitRich`、`chatSessions.readHistory`、`chatSessions.catalog.list`。桥返回 `{ok,value|error}` 包络，调用携带 `authorityEndpointId`/`endpointId`。
- **下发**：`chatSessions.submitRich`（`newSession` true/false；新会话需 client UUID + 可解析 `workspace{endpointId,workspaceId}`；续发复用既有 `sessionId`）。
- **回执**：实时真源为宿主 API / `readHistory` 轮询；SQLite `main.sqlite`（含 `-wal/-shm`，拷贝临时副本只读）仅作可选复核，不作为无 API 时的主真源。

事实出处：`04-docs/qoder/14-对齐总评估与技术方案.md`、`04-docs/qoder/15-真机点火实验记录-20261031.md`。

## 硬约束

- 零反代、零 CLI、零 GUI 自动化；插件**不**启动/关闭/重启 Qoder。
- 凭据（PAT/令牌）**不回显**、不进日志/回执/设置快照；真实 PAT 存本机 DSH vault（`$DSH_HOME/qoder-cn-signin.json`，尽力 0600）。
- **`scheduled_tasks` 不支持**：Qoder 无计划任务列表/删除能力；本包保持 `scheduled_tasks` 计数 **0** 不变式，不提供任务列表/删除 UI。
- 未验证能力如实报告为 **`unknown`**，不编造：`reasoningEffort` 的 `submitRich` 入参形态（仅在模型目录能力命中时记录/观测，不伪造成功）、审批接力（八步之 8）、权限 5 值字面量。

## 签到与积分（CN 首版）

- 用户粘贴一次 `pt-` PAT → 交换 jobToken/sash 令牌 → 查询 `sash/api/v2/me/usage` 余额与 `sash/api/v1/me/campaigns` → 一键领取每日签到（100 Credits，幂等处理）。
- 卡片显示余额、今日领取状态（可领取/已领取/当前无活动/未配置/错误）与一键领取。
- **不读** `auth.v1.dat`，不做 DPAPI，不拉起任何进程。CN `requiresDeviceRisk:false`（首版不做 UMID 设备风控）；global 明确不支持/unknown。
- 协议参考（MIT，保留致谢）：[dingminhua/dsh-connect-qoder](https://github.com/dingminhua/dsh-connect-qoder)（`cosy/upstream/credentials` 思路与端点契约）+ L0NE-6/Qoder-Daily。实现位于 `src/host/signin/*`，含来源注释。

## 启动项

- 默认写入 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Qoder CN (dsh).cmd`，参数 `--remote-debugging-port=9333`。
- 设置卡提供位置/参数展示与一键撤销。
- 若存在注册表 Run 键自启冲突：**仅报告、不修改**（插件不检查/不修改注册表，避免进程执行）。

## 工具

- `qoder_run`：下发/复用会话（`session_key`/`resume`/绑定会话），回执含 wait 状态与回复摘录。
- `qoder_status`：只读状态（CDP 探测、模型目录来源、会话映射、在途、最近一轮、签到/启动项摘要、`scheduled_tasks=0`、审批 `unknown`）。

## 验收与红线

提交前需通过：`npm run ci:redlines`（4/4）、`npm run test:host`、`npm run test:client`。真机验收需在 Qoder CN 以 CDP 9333 运行的环境下验证新建会话/续发/回执/模型/工作区，且全程 `scheduled_tasks=0`。
