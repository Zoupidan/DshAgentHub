/**
 * **宿主协议词汇表** —— 插件与 dsh 宿主之间约定死的字面值。
 *
 * <p>镜像 plugin-workbuddy 同款文件（该文件头注解释了"为什么单独一个文件""为什么不再抽公共包"）。
 * 这两个状态取值域既不是 opencode 的旋钮，也不是任何 agent 产品的属性 ——
 * 状态载荷、设置卡片、诊断端点全都按**字面值**判定它。运行时会往载荷里写这些字符串，
 * 冻结的理由：若运行期能改写取值域，已发出的载荷与后续判读就会对不上，且这种错**不会让任何测试变红**。
 *
 * @module host/config/host-protocol
 */

/** ① 服务/注册态。`SERVICE_MISSING` = 本机没有 opencode 服务（service.json 不在/pid 不活）。 */
export const REGISTRY_STATES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  SERVICE_MISSING: 'SERVICE_MISSING',
  UNREGISTERED: 'UNREGISTERED',
  REGISTERED: 'REGISTERED',
  DEGRADED: 'DEGRADED',
});

/** ② Job 执行态（与 ① 正交：两套状态互不推导）。 */
export const RUN_STATES = Object.freeze({
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});
