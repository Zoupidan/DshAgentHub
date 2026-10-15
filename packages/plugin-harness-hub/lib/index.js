/**
 * host 入口（官方物理契约：`main = lib/index.js`）。
 *
 * 本壳**没有任何宿主侧能力**：零工具、零路由、零定时器、零设置 namespace ——
 * 只有一个空 `apply` 让它在 cordis 行里可见；浏览器半（设置导航条目「Harness 接入」
 * + 子标签槽壳）由 package.json 的 `dsh.client` 声明被发现。
 * 依据：官方同款壳 `@deepseek-ai/dsh-client-ui-settings-plugins/lib/index.js`（节点半即空 apply）。
 *
 * 约束：本文件属于 packages/*​/lib（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
export function apply() {}
