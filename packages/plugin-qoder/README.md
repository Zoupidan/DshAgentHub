# dsh-plugin-qoder (v0.1.2)

把本机 **Qoder CN** 桌面端纳入 DshAgentHub / dsh 控制平面的第三个 harness 插件（WorkBuddy ✓ / OpenCode ✓ / **Qoder**），注册在「Harness 接入」父设置页的 `Qoder` 标签下。

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

## 签到与积分（CN）

### 如何获取个人令牌（PAT）
1. 在 Qoder 账号/个人设置中创建或复制**个人令牌**（格式以 `pt-` 开头）。
2. 在 DSH「设置 → Harness 接入 → Qoder → 签到与积分」中粘贴并点击「保存」。
3. PAT **仅需一次**：保存后仅存本机 `DSH_HOME/qoder-cn-signin.json`（尽力 0600），不回显、不进日志/回执/设置快照。

> 说明：本机 Qoder 加密登录态（`auth.v1.dat`，Chromium os_crypt v10+DPAPI）经实测**不包含** `pt-` PAT（包含其他 token），因此不能自动拉取该 PAT。仓库提供只读/脱敏的辅助脚本 `tools/dev/extract-qoder-cn-credential.mjs`（tools/ 下，不在插件运行时执行），用于诊断/提取尝试；当前场景下仍需用户提供 `pt-` PAT。

- 保存 PAT 后：查询 `sash/api/v2/me/usage` 余额与 `sash/api/v1/me/campaigns`，支持一键领取每日签到（幂等）。卡片显示余额、今日领取状态（可领取/已领取/当前无活动/未配置/错误）。
- CN 首版；global 不支持/unknown。协议参考（MIT，保留致谢）：[dingminhua/dsh-connect-qoder](https://github.com/dingminhua/dsh-connect-qoder) + L0NE-6/Qoder-Daily。

## 启动项（自动）

- **启用 Qoder 接入**时自动写入 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Qoder CN (dsh).cmd`（`--remote-debugging-port=9333`）。
- **关闭启用**时自动清理启动项。
- 写入/清理后需**手动重启 Qoder** 生效；插件不启动/关闭/重启 Qoder。
- 注册表 Run 键自启冲突：仅报告风险方向、不自动修改。

## 工具

- `qoder_run`：下发/复用会话（`session_key`/`resume`/绑定会话），回执含 wait 状态与回复摘录。
- `qoder_status`：只读状态（CDP 探测、模型目录来源、会话映射、在途、最近一轮、签到/启动项摘要、`scheduled_tasks=0`、审批 `unknown`）。

## 验收与红线

提交前需通过：`npm run ci:redlines`（4/4）、`npm run test:host`、`npm run test:client`。真机验收需在 Qoder CN 以 CDP 9333 运行的环境下验证新建会话/续发/回执/模型/工作区，且全程 `scheduled_tasks=0`。
