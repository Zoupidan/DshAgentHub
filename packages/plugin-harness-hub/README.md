# dsh-plugin-harness-hub

设置页里的**父条目**「Harness 接入」：把本机各 harness 的配置卡片收拢成**子标签页**
（WorkBuddy / OpenCode / 后续接入），设置导航栏从"每个 harness 占一条"变成"一条进全部"。

> 一句话：本壳**零能力、零状态、零数据** —— 只做三件事：注册父条目、声明子槽、画标签行。
> 各 harness 的能力 / 配置 / 状态**一概不经过本壳**（一 harness 一包、互不共享状态的落点）。

## 结构（一壳两半）

| 文件 | 角色 |
|---|---|
| `lib/index.js` | host 半：空 `apply`（只为进 cordis 行；**不加任何工具/服务**） |
| `lib/client.js` | client 半（手写 bundle）：父条目注册 + 子槽声明 + 标签行/面板渲染 |
| `src/shared/constants.js` | 共享常量（`SECTION_ID` / `SECTION_ORDER` / `TAB_SLOT`）；bundle 手写同名字面量，测试钉同步 |
| `cordis.patch.yml` | 只 insert 自己这一行（id=`plugin-harness-hub`） |
| `test/client.test.js` | 伪宿主浅渲染验收（含**跨包三处同步**断言） |

壳组件结构逐行对齐官方同款壳（`@deepseek-ai/dsh-client-ui-settings-plugins` 的
PluginsSettingsSection，本机 0.2.0-rc.2 安装体只读实测）：标签行只在 **≥2 个标签**时出现；
1 个标签直接当整页；0 个显示空态；键盘导航（←/→/Home/End）；访问过的标签保持挂载。

## 子槽契约（各 harness 的挂入点）

槽名 `settings.harness-hub.tab`（`kind: list` / `scope: root`，由本壳注册项的 `children` 表声明）：

```js
ctx.slots.inject(TAB_SLOT, () =>
  ctx.slots.register(
    { name: TAB_SLOT, id: 'workbuddy', order: 10, label: () => t('nav'), locale: NS },
    ConfigCard,
  ),
);
```

- 子侧注册项**不收 `inject`**：壳以 `renderSlot(TAB_SLOT, {}, { only: 标签id })` 渲染，只递空 props；
  配置面（scope）在装配期**闭包**进组件（与 0.1.7 `settings.section` 时代同口径）。
- 当前标签位：workbuddy=10、opencode=20 ⇒ 标签行顺序 WorkBuddy → OpenCode。
- 子槽必须**先由父的 `children` 表声明**才能注册（未声明即注册会抛 SlotCore 的 "not declared"）；
  父条目不在场 ⇒ 子侧 `inject` 不触发 = 子条目不出现（**父是唯一入口**）。

## 部署（本机 junction 形态，无热载）

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-plugin-harness-hub" -Target "<仓库>\packages\plugin-harness-hub"
# profile 的 package.json：deps 加 "dsh-plugin-harness-hub": "link:..."，bundles 数组加本包
```

**重启 DSH** 后设置页出现「Harness 接入」。

## 验证边界（诚实登记）

- 可证（`test/client.test.js`，伪宿主浅渲染）：注册形态 / 壳描述符（id·order·locale·label·inject·children）/
  hooks.tabs 数据面（排序·thunk 求值·兜底·缓存引用·双订阅解绑）/ 标签行与切页 / 单标签/零标签退化 /
  CSS 去重 / 常量同步 / 跨包三处同步。
- 不可证（留真机目验）：真机 React 渲染、slot dispatch、与兄弟包卡片同屏显示 —— 重启 DSH 后人工确认。

## 纪律

- `lib/` 与 `src/` 属 CI ② 扫描范围：不得出现任何进程出口字样（零 CLI / 零反代，CHARTER §3）。
- 本壳不得读任何 harness 的数据或状态。
