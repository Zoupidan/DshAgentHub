/**
 * 成员身份面（① 身份上移，2026-10-17）——把 harness 工具面装进"名为 <memberName> 的团队成员"**自己的 scope**。
 * （plugin-opencode 版；结构与注释与 plugin-workbuddy 同款文件逐条同构，机制与厂商无关。）
 *
 * 范式逐条对齐官方 `@deepseek-ai/dsh-experimental-tool-agent-team` 的 scoped install（其 README 原话：
 * "Scoped, not global. Every registration lives on the member Agent's own ctx"）：
 *   - `ctx.agentTeams.tryMembership(agent)` 判定：teammate ⇒ `{role:'teammate', name}`；lead ⇒ `{role:'lead'}`；
 *     非团队成员子代理 ⇒ `undefined`；
 *   - `agent.ctx.tools.register(...)` / `agent.ctx.systemPrompt.section(...)` 注册进成员自己的 scope；
 *   - `ctx.agents.list()` 初始扫描 + `ctx.on('agent/created')` / `ctx.on('agent/disposed')` 订阅；
 *   - 每个成员独立 disposer，`agent/disposed` 时退还；随本插件 fiber 卸载全清。
 *
 * 契约：
 *   - 团队服务不在（组合没挂 Teams）⇒ 返回 **null**，调用方回退全局注册（老部署 / 老测试桩不动）。
 *   - `setEnabled(false)`（U4 闸 OFF / 未服务）⇒ 一个成员 scope 都不装，已装的退场。
 *   - 只认 `role==='teammate' && name===memberName`：Lead / 其它名字的成员 / 一次性子代理一律不装。
 *
 * @module host/team/member-scope
 */

/**
 * @param {object} ctx 宿主 ctx（tools 已就绪；agentTeams/agents 通过 ctx.get 软取——缺席即回退）
 * @param {{pluginId: string, memberName: string,
 *   install: (scopedCtx: object, agent: object) => () => void}} deps
 * @returns {{setEnabled: (v: boolean) => void, installedCount: () => number, dispose: () => void} | null}
 */
export function createHarnessMemberScope(ctx, { pluginId, memberName, install, agentTeams: providedTeams, agents: providedAgents }) {
  // 团队服务优先取显式传入（deferred inject 解析到的实例）；缺省回退 ctx.get（测试桩 / 兼容）。
  const agentTeams = providedTeams ?? (() => {
    try { return ctx.get('agentTeams') ?? null; } catch { return null; }
  })();
  if (agentTeams === null || typeof agentTeams.tryMembership !== 'function') return null;
  const agents = providedAgents ?? (() => {
    try { return ctx.get('agents') ?? null; } catch { return null; }
  })();

  /** @type {Map<object, () => void>} agent → 该成员 scope 的全部注销器 */
  const installed = new Map();
  let enabled = false;

  const maybeInstall = (agent) => {
    if (!enabled || agent === undefined || agent === null || installed.has(agent)) return;
    let membership;
    try { membership = agentTeams.tryMembership(agent); } catch { membership = undefined; }
    if (membership === undefined || membership.role !== 'teammate' || membership.name !== memberName) return;
    try {
      installed.set(agent, install(agent.ctx, agent));
    } catch (err) {
      installed.delete(agent);
      ctx.logger?.warn?.(
        `[${pluginId}] member scope install failed for "${memberName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const maybeUninstall = (agent) => {
    const dispose = installed.get(agent);
    if (dispose === undefined) return;
    installed.delete(agent);
    try { dispose(); } catch { /* 卸载尽最大努力：单个 scope 的清理失败不阻断其余 */ }
  };

  const scan = () => {
    if (!enabled || agents === null) return;
    let list = [];
    try { list = agents.list() ?? []; } catch { list = []; }
    for (const agent of list) maybeInstall(agent);
  };

  // 订阅（跟随本插件 fiber；另在 dispose() 里防御性退订）
  const onCreated = (payload) => { try { maybeInstall(payload?.agent); } catch { /* 事件面绝不外抛 */ } };
  const onDisposed = (payload) => { try { maybeUninstall(payload?.agent); } catch { /* 同上 */ } };
  const offCreated = ctx.on('agent/created', onCreated);
  const offDisposed = ctx.on('agent/disposed', onDisposed);

  // 随本插件 fiber 卸载全清（与 setEnabled(false) 幂等）
  ctx.effect(() => () => {
    for (const agent of [...installed.keys()]) maybeUninstall(agent);
    installed.clear();
  }, `${pluginId}: member scope`);

  return {
    /** U4 闸镜像：ON 扫描在场 agent；OFF 全部退场。 */
    setEnabled(next) {
      enabled = next === true;
      if (enabled) scan();
      else for (const agent of [...installed.keys()]) maybeUninstall(agent);
    },
    /** 诊断 / 测试：当前已装的成员数。 */
    installedCount: () => installed.size,
    /** 显式卸载（退订 + 全清）。 */
    dispose() {
      if (typeof offCreated === 'function') offCreated();
      if (typeof offDisposed === 'function') offDisposed();
      for (const agent of [...installed.keys()]) maybeUninstall(agent);
      installed.clear();
    },
  };
}
