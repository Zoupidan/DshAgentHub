/**
 * 惰性旗标登记册（WB-7 的显式表态面；由 `tools/ci/check-consumed-knobs.mjs` 强制校验）。
 *
 * 契约（与 plugin-workbuddy 同款）：每个 `launch.*` 键要么被**真实下发**（行为探针可验证），
 * 要么在本文件登记惰性并写明**为什么不下发**；未登记 / 理由为空 / 登记了不存在的键（orphan）/
 * 已经不惰性却仍登记（stale）⇒ 一律 FAIL。
 *

 * 本包唯一的 launch 键是 `launch.variantValues`（**数据表，不是旗标**：模型 → 档位域覆盖/补充；
 * 空表 = 完全用服务实况）。它的真实消费者 = 状态路由导出的 `variantCapability(config)`
 * （红线行为探针按包指名，见 check-consumed-knobs.mjs 的 PROBE_TARGETS）⇒ 不需要惰性登记
 * —— "活着"的键留在登记册里会触发 stale-register。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
export default {};
