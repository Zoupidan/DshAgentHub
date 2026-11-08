/**
 * 成员身份面 —— 把 harness 工具面装进名为 <memberName> 的团队成员自己的 scope。
 * 与 plugin-opencode 同构；团队缺席返回 null（回退全局注册）。
 * @module host/team/member-scope
 */
export function createHarnessMemberScope(ctx, { memberName, isEnabled, makeTools, makePrompt }) {
  const teams = ctx?.agentTeams;
  const agents = ctx?.agents;
  if (!teams || typeof teams.tryMembership !== 'function' || !agents || typeof agents.list !== 'function') return null;

  const disposersByAgent = new Map();

  function teardown(agentId) {
    const dispose = disposersByAgent.get(agentId);
    if (!dispose) return;
    disposersByAgent.delete(agentId);
    try { dispose(); } catch {}
  }

  function tryInstall(agent) {
    if (!agent?.id || !agent?.ctx) return;
    if (isEnabled?.() !== true) { teardown(agent.id); return; }
    let membership;
    try { membership = teams.tryMembership(agent); } catch { membership = undefined; }
    if (!membership || membership.role !== 'teammate' || membership.name !== memberName) {
      teardown(agent.id);
      return;
    }
    if (disposersByAgent.has(agent.id)) return;
    const ds = [];
    try {
      for (const tool of (makeTools?.(agent) ?? [])) {
        if (tool) ds.push(agent.ctx.tools.register(tool));
      }
      if (typeof makePrompt === 'function') {
        const sec = makePrompt(agent);
        if (sec) ds.push(agent.ctx.systemPrompt.section(sec));
      }
      disposersByAgent.set(agent.id, () => { for (const d of ds.reverse()) { try { d(); } catch {} } });
    } catch (e) {
      for (const d of ds.reverse()) { try { d(); } catch {} }
      throw e;
    }
  }

  function reconcile() {
    for (const agent of agents.list()) try { tryInstall(agent); } catch {}
  }

  reconcile();
  const offs = [];
  try { if (typeof ctx.on === 'function') {
    offs.push(ctx.on('agent/created', (agent) => { try { tryInstall(agent); } catch {} }));
    offs.push(ctx.on('agent/disposed', (agent) => { try { teardown(agent?.id); } catch {} }));
  } } catch {}

  return () => {
    for (const off of offs) { try { off(); } catch {} }
    for (const [id] of [...disposersByAgent.entries()]) teardown(id);
  };
}
