/**
 * 工具面收敛器（U4 心脏）—— plugin-qoder。enabled=false ⇒ 0 工具。
 * @module host/tools/index
 */
import { REGISTRY_STATES } from '../config/constants.js';
import { makeRunTool } from './run.js';
import { makeStatusTool } from './status.js';
import { PLUGIN_ID, MEMBER_NAME } from '../../shared/constants.js';
import { createHarnessMemberScope } from '../team/member-scope.js';
import { installMemberTools } from '../team/member-tools.js';

export function reconcileTools(ctx, { runtime, sessions, config, Config, NS, detect, dispatch }) {
  const read = () => runtime.currentConfig?.() ?? runtime.current?.() ?? config ?? {};
  const cfg = read();
  const enabled = cfg.enabled === true;
  const memberKey = `__${PLUGIN_ID}:memberScopeDisposer`;
  const globalKey = `__${PLUGIN_ID}:globalDisposers`;

  function clearGlobal() { try { (ctx[globalKey] ?? []).forEach((d) => { try { d(); } catch {} }); } catch {} ctx[globalKey] = []; }
  function clearMember() { try { ctx[memberKey]?.(); } catch {} ctx[memberKey] = null; }

  if (!enabled) {
    clearMember();
    clearGlobal();
    runtime.setRegistry(REGISTRY_STATES.UNREGISTERED);
    runtime.setRegistrationError(null);
    return { registered: [], registry: runtime.registry() };
  }

  runtime.setRegistry(REGISTRY_STATES.REGISTERED);

  // Team-aware: if agentTeams present, install into "qoder" member scope; else global.
  const teamScope = createHarnessMemberScope(ctx, {
    memberName: MEMBER_NAME,
    isEnabled: () => (runtime.currentConfig?.() ?? {}).enabled === true,
    makeTools: (agent) => [
      makeRunTool(runtime, sessions, read, agent.ctx ?? ctx, dispatch),
      makeStatusTool(runtime, sessions, read, dispatch),
    ],
    makePrompt: () => ({ name: `${PLUGIN_ID}:member-duty`, order: 521, text: 'You are the Qoder member of this Agent Team; use qoder_run/qoder_status for Qoder desktop work and relay receipts. scheduled_tasks unsupported (0); approval relay unknown/unverified.' }),
  });

  if (teamScope) {
    clearGlobal();
    clearMember();
    ctx[memberKey] = teamScope;
    return { registered: ['member-scope'], registry: runtime.registry(), mode: 'member-scope' };
  }

  clearMember();
  clearGlobal();
  const disposers = [];
  try {
    disposers.push(ctx.tools.register(makeRunTool(runtime, sessions, read, ctx, dispatch)));
    disposers.push(ctx.tools.register(makeStatusTool(runtime, sessions, read, dispatch)));
  } catch (e) {
    for (const d of disposers.reverse()) { try { d(); } catch {} }
    runtime.setRegistry(REGISTRY_STATES.DEGRADED);
    runtime.setRegistrationError(String(e?.message ?? e));
    return { registered: [], registry: runtime.registry(), error: String(e?.message ?? e) };
  }
  ctx[globalKey] = disposers;
  return { registered: ['qoder_run', 'qoder_status'], registry: runtime.registry(), mode: 'global' };
}
