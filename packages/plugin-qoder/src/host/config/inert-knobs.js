/**
 * 惰性旗标登记册（WB-7 的显式表态面；由 `tools/ci/check-consumed-knobs.mjs` 强制校验）。
 *
 * 本包的 launch 键是 `launch.effortValues` / `launch.contextWindowValues`（**数据表，不是旗标**：
 * 模型/能力覆盖兜底）。真实消费者 = 状态路由导出的 `modelCapability(config)`（红线行为探针按包指名，
 * 见 check-consumed-knobs.mjs 的 PROBE_TARGETS）⇒ 不需要惰性登记。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
export default {};
