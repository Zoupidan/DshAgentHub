/**
 * host 入口（官方物理契约：`main = lib/index.js`）。
 * 约束：本文件属于 packages/plugin-qoder/lib（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
export { name, inject, apply, Config } from '../src/host/apply.js';
