# Changelog — dsh-plugin-qoder

## 0.1.0 (2026-11-08)

首版：Qoder CN 第三 harness 接入（CDP + `window.qoderDesktop.applicationInvoke`）。

- **通道**：CDP `--remote-debugging-port=9333`；实机（Qoder CN 0.5.6）验证 `system.describe` / `models.getCatalog(fetchStrategy:'cache')` / `workspaces.list` / `chatSessions.submitRich` / `chatSessions.readHistory`（兼容 `listChatModels`/catalog）；新会话/续发/同会话复用/回执轮询；桥 `{ok,value}` 包络解包。零反代/零 CLI/零 GUI 自动化；不启动/关闭/重启 Qoder。
- **签到与积分（CN）**：粘贴 `pt-` PAT → jobToken/sash → 用量 v2 + 活动 v1 + 每日领取（幂等）。余额/领取状态/一键领取；凭据仅存 DSH vault，不回显。MIT 协议参考：dingminhua/dsh-connect-qoder + L0NE-6/Qoder-Daily。global 不支持/unknown。
- **启动项**：写入/撤销 Startup `.cmd`（`--remote-debugging-port=9333`）；注册表 Run 键仅报告、不修改。
- **UI**：harness-hub 子标签 `qoder`（order 30），A1 自动刷新，只读会话列表，模型/思考/上下文/签到/启动项状态。**无**计划任务列表/删除（`scheduled_tasks=0` 不变式）。
- **工具**：`qoder_run`、`qoder_status`（U4 硬闸 + 团队成员 scope 兼容）。
- **已知/unknown（不编造）**：`reasoningEffort` 的 `submitRich` 入参待验；审批接力（八步之 8）未验证；权限 5 值字面量未验证；SQLite 仅作只读复核（实时真源为 API）。
