# Changelog — dsh-plugin-qoder

## 0.1.3 (2026-11-09)

- 修复凭据/签到状态不一致：vault 未配置时不再显示运行时残留的“已签到/已领取”，统一显示未配置；status 路由在未配置时返回 `claimState: unconfigured`。

## 0.1.2 (2026-11-09)

- 保存/刷新凭据时更明确地展示上游错误（toast + 状态行），便于定位 PAT/网络/API 问题。
- 调整按钮样式：保存为普通按钮，「领取今日签到」仅在可领取时高亮，减少突兀感。

## 0.1.1 (2026-11-08)

修复发版事故与 UX 问题（不改 0.1.0 事实，补丁发布）：
- 修复 host 加载阻断：`routes/{signin,startup,task-delete}` 的 `loopback` 导入路径修正，避免插件无法加载/Qoder 标签不出现。
- 修复 client 状态拉取与设置写入：`fetchStatus`→`fetchJson`；`configForms.set` 改为 `(field,value)`（opencode/workbuddy 同款），修复“启用闪一下即回退”。
- UX：卡片默认展开；**启用自动写入启动项+刷新（已配置凭据时自动刷新积分），关闭自动清理启动项**，移除手动启动项按钮；精简文案，明确「如何获取 pt- PAT」；`writable!==false` 放宽避免开关误禁用。
- 凭据：新增 `tools/dev/extract-qoder-cn-credential.mjs`（os_crypt v10+DPAPI，只读解密、脱敏输出、tools/ 非插件运行时）。实测 `auth.v1.dat` 不含 `pt-` PAT，故 CN 积分 PAT 仍需用户一次性提供。
- 通过 `ci:redlines` 4/4、qoder host+client 15/15。

## 0.1.0 (2026-11-08)

首版：Qoder CN 第三 harness 接入（CDP + `window.qoderDesktop.applicationInvoke`）。

- **通道**：CDP `--remote-debugging-port=9333`；实机（Qoder CN 0.5.6）验证 `system.describe` / `models.getCatalog(fetchStrategy:'cache')` / `workspaces.list` / `chatSessions.submitRich` / `chatSessions.readHistory`（兼容 `listChatModels`/catalog）；新会话/续发/同会话复用/回执轮询；桥 `{ok,value}` 包络解包。零反代/零 CLI/零 GUI 自动化；不启动/关闭/重启 Qoder。
- **签到与积分（CN）**：粘贴 `pt-` PAT → jobToken/sash → 用量 v2 + 活动 v1 + 每日领取（幂等）。余额/领取状态/一键领取；凭据仅存 DSH vault，不回显。MIT 协议参考：dingminhua/dsh-connect-qoder + L0NE-6/Qoder-Daily。global 不支持/unknown。
- **启动项**：写入/撤销 Startup `.cmd`（`--remote-debugging-port=9333`）；注册表 Run 键仅报告、不修改。
- **UI**：harness-hub 子标签 `qoder`（order 30），A1 自动刷新，只读会话列表，模型/思考/上下文/签到/启动项状态。**无**计划任务列表/删除（`scheduled_tasks=0` 不变式）。
- **工具**：`qoder_run`、`qoder_status`（U4 硬闸 + 团队成员 scope 兼容）。
- **已知/unknown（不编造）**：`reasoningEffort` 的 `submitRich` 入参待验；审批接力（八步之 8）未验证；权限 5 值字面量未验证；SQLite 仅作只读复核（实时真源为 API）。
