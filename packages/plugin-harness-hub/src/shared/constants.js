/**
 * ★ harness-hub 的共享常量（host 半与测试读它；client bundle 手写、不能 import，
 *   由 test/client.test.js 的"常量同步"断言钉住手写侧）。
 *
 * 约束：本文件属于 packages/*​/src —— CI ② 扫描范围内，不得出现裸进程出口字样。
 */

/** cordis 行 id（短名）—— 与 `cordis.patch.yml` 的 `id:` 保持一致。 */
export const PLUGIN_ID = 'plugin-harness-hub';

/** npm 包名（= client 模块 id；行 `name:` 字段用它加载）。 */
export const PACKAGE_NAME = 'dsh-plugin-harness-hub';

/** settings namespace（本壳无自己的配置面；保留与兄弟包同形，供 locale 字典命名）。 */
export const NS = PACKAGE_NAME;

/**
 * 设置导航栏**父条目** id（`settings.section` 的 list id）。
 * 该条目 = 本壳的全部对外身份；各 harness 不再各自占一条导航位。
 */
export const SECTION_ID = 'harness-hub';

/**
 * 父条目排序位次（2026-10-15 落位依据，只读实测本机各 section 的 order）：
 *   账号与余额=-10 · 通用设置=0 · 模型=10 · 内置插件=15 · 技能=17 · 【本条目=18】 ·
 *   Agent 预设=20 · 插件市场=40。
 * 取 18 的理由：正好坐在原 OpenCode/WorkBuddy 两个独立条目所在的位置（技能之后、
 * Agent 预设之前），且**不与该位置上的 Agent 预设=20 撞号**（同号排序不可预期）。
 */
export const SECTION_ORDER = 18;

/**
 * 子**标签槽**名（list 槽；kind/scope 由壳注册时的 children 表声明）。
 * 各 harness 的 client bundle 以 `{ name: TAB_SLOT, id: '<harness>', order, label }`
 * 注册进它（样例：@deepseek-ai/dsh-client-ui-settings-plugin-inventory 注册进
 * `settings.plugins.tab`）。**改名即三处同步**：本文件、各 harness 常量文件、各 client bundle。
 */
export const TAB_SLOT = 'settings.harness-hub.tab';
