/**
 * systemPrompt.section 可用性文案（order=520）。只讲读得出来的话；不撒谎。
 * @module host/prompts/availability
 */
import { REASON_CODES } from '../launch/reason-codes.js';

const CONCURRENCY_LINE = 'Concurrency budget: at most 3 tasks in flight for this harness, and at most 4 across all harnesses.';

const LEAD_MEMBER_ROUTE_TEXT = 'Qoder is reachable through its team member: spawn_teammate with name "qoder" and route the task to it. Do not call qoder_run here.';

export function availabilityText(runtime, opts = {}) {
  const c = runtime.currentConfig?.() ?? runtime.current?.() ?? {};
  if (c.enabled !== true) {
    return 'Qoder (CN, desktop) integration is installed but turned OFF (enabled=false). Do not attempt to use qoder tools; tell the user to enable it in the harness hub settings if they want it used.';
  }
  const hasTools = opts.hasTools !== false;
  if (!hasTools) {
    return `Qoder integration is ON and this agent routes Qoder work through the "qoder" team member. ${LEAD_MEMBER_ROUTE_TEXT} ${CONCURRENCY_LINE}`;
  }
  const ps = runtime.probeState?.() ?? { status: 'idle' };
  if (ps.status !== 'done') {
    return `Qoder integration is ON; availability probe is ${ps.status} (${ps.pendingReason || 'pending'}). Tools qoder_run/qoder_status are available but dispatch may fail if Qoder is not running with CDP --remote-debugging-port=${Number(c.cdpPort) || 9333}. Plugin never starts/kills/restarts Qoder. ${CONCURRENCY_LINE}`;
  }
  const r = ps.result ?? {};
  if (r.installed !== true) {
    return `Qoder integration is ON but the local Qoder CDP target is NOT reachable (reason=${r.reason || 'unknown'}, port=${Number(c.cdpPort) || 9333}). Do not fabricate a result. Ask the user to start Qoder with --remote-debugging-port=${Number(c.cdpPort) || 9333} (the settings card can write a Startup .cmd). Plugin never starts/kills/restarts Qoder. ${CONCURRENCY_LINE}`;
  }
  const last = runtime.lastRun?.();
  const lastLine = last ? ` Last run reason=${last.reasonCode}${last.sessionId ? ` session=${last.sessionId}` : ''}.` : '';
  return `Qoder (CN desktop) is reachable via CDP on port ${Number(c.cdpPort) || 9333} (target=${r.targetTitle || r.targetId || 'qoder'}). Use qoder_run to dispatch to a visible Qoder session (new or reused by session_key/resume/boundSessionId); read receipts before replying. Channel: CDP+applicationInvoke only; no CLI, no GUI automation, no reverse proxy. scheduled_tasks is not supported (Qoder has no plan task list) — do not claim task scheduling.${lastLine} ${CONCURRENCY_LINE}`;
}
