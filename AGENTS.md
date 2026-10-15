# AGENTS.md — 在本仓库干活的 agent 必读

> 最高准则：`CHARTER.md`。本文件是操作手册；与 CHARTER 冲突时以 CHARTER 为准，并报告。

## 1. 先读什么

1. `CHARTER.md` — 项目定义与两条铁律（2026-10-15 起）
2. `README.md` — 产品面与当前能力
3. `04-docs/` — 最近一次交接 / 检查 / 任务板（按日期找最新的）

## 2. 仓库结构

- `packages/plugin-<harness>/` — 一 harness 一包（现有：`plugin-workbuddy`、`plugin-opencode`；设置合并外壳：`plugin-harness-hub`）
- `00-recon` → `01-prd` → `02-design` → `03-adr` → `04-docs` → `05-construction` — 文档流水线（见 `.gitignore`）
- `tools/` — CI 红线、lint、dev 脚本
- 入库原则：用户定义、红线、交付文档、源码、测试入 git；侦察证据、设计草稿、施工日志通常本地保存

## 3. 提交前门槛（必须全绿）

```powershell
npm run ci:redlines     # 4 条红线
npm run test:host       # 宿主侧全量
npm run test:client     # UI 侧
```

红线实现以 `tools/` 下脚本为准；修改任何红线属于重要决定——先论证、写报告，再动。

## 4. 环境禁区（硬）

- 不执行 `npm install`；依赖用 `npm run link:dsh-deps`（junction 到本机 DSH 安装体，幂等）
- 测试必须经 `tools/dev/test-home-guard.mjs`（仓库脚本已内置）；一律用临时 `WORKBUDDY_HOME` / `DSH_HOME`，
  禁止写用户真实数据（`~/.workbuddy`、`~/.dsh`、`~/.config/opencode` 等只读，除非是该 harness 的正常部署动作且已获准）
- WorkBuddy 包：任何路径不得拉起 CLI/Shell/控制台进程（C2），不得绕过桌面端，不得反代——负向测试已钉死
- 零反代是全局铁律（CHARTER §3）：不监听转发端口、不做中间人、不重托管模型路由

## 5. 文档与留痕

- 证据分级：实测 / 推论 / 待验——三档如实标注
- 重要决定 → `04-docs/` 按日期留档；用户原话 → 原文引用（禁止改写）
- 提交信息：conventional commits（中文 message），一次提交一件事

## 6. 与其他 harness 的关系

- 每个 harness 都不同：新接入必须从各自的 recon 开始，禁止假设通道通用
- 共享面只有三样：dsh 工具命名习惯、八步流程契约（CHARTER §4）、证据与红线要求
- 一 harness 一包：`packages/plugin-<harness>/`，互不共享状态、互不伪造能力
