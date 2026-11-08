/**
 * `qoder_status` —— 只读状态面。
 * @module host/tools/status
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TOOL_STATUS } from '../../shared/constants.js';
import { getCredentialMeta } from '../signin/credentials.js';
import { inspectStartup } from '../startup/manager.js';
import { oneLine } from '../launch/reason-codes.js';

export const makeStatusTool = (runtime, sessions, read, dispatch) => defineTool({
  name: TOOL_STATUS,
  description:
    'Read-only status of the Qoder plugin: CDP probe evidence, live model catalog (when reachable), session memory, in-flight jobs, last run receipt, signin/credits summary (masked), and startup-item state. '
    + 'Never dispatches anything. Never echoes credentials. scheduled_tasks is not applicable for Qoder.',
  parameters: {
    reprobe: { type: 'boolean', description: 'Re-run the read-only CDP availability detection before answering.' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args) {
    const cfg = read?.() ?? runtime.currentConfig?.() ?? {};
    if (args?.reprobe === true && typeof runtime.reprobe === 'function') {
      const { detectProbe } = await import('../probe/detect.js');
      await runtime.reprobe(detectProbe, null, cfg);
    }
    const lines = [];
    const ps = runtime.probeState?.() ?? { status: 'idle' };
    lines.push(`qoder plugin · enabled=${cfg.enabled === true} · registry=${runtime.registry?.() ?? 'unknown'} · cdpPort=${Number(cfg.cdpPort) || 9333}`);
    if (ps.status === 'done') {
      const r = ps.result ?? {};
      lines.push(`cdp: ${r.installed ? 'OK' : 'NOT REACHABLE'} · reason=${r.reason || ''} · target=${r.targetTitle || r.targetId || ''}`);
      for (const e of (r.evidence ?? []).slice(-4)) lines.push(`  · ${e.target}: ${e.detail}`);
    } else {
      lines.push(`cdp: ${ps.status} (${ps.pendingReason || ''})`);
    }
    let models = { source: 'pending:probe', models: [] };
    if (dispatch && typeof dispatch.models === 'function' && cfg.enabled === true) {
      try { models = await dispatch.models(cfg); } catch (e) { models = { source: `unavailable:${String(e?.message ?? e).slice(0, 60)}`, models: [] }; }
    }
    lines.push(`models: source=${models.source} count=${Array.isArray(models.models) ? models.models.length : 0}`);
    for (const m of (Array.isArray(models.models) ? models.models : []).slice(0, 12)) {
      const key = m?.modelKey ?? m?.id ?? '';
      const efforts = Array.isArray(m?.efforts) ? m.efforts.map((e) => (typeof e === 'string' ? e : e?.id ?? '')).filter(Boolean).join('/') : '';
      const cws = Array.isArray(m?.availableContextWindows) ? m.availableContextWindows.join('/') : '';
      lines.push(`  · ${key}${efforts ? ` · efforts:${efforts}` : ''}${cws ? ` · ctx:${cws}` : ''}`);
    }
    const rows = typeof sessions?.summary === 'function' ? await sessions.summary(10) : [];
    lines.push(`sessions: ${rows.length ? rows.length : 0}`);
    for (const r of rows) lines.push(`  · ${r.sessionKey} → ${r.sessionId} [${r.state}] ${r.title || ''}`);
    const inflight = runtime.inFlight?.() ?? [];
    lines.push(`in-flight: ${inflight.length}`);
    for (const r of inflight) lines.push(`  · ${r.sessionKey} → ${r.sessionId || '(pending)'} phase=${r.phase} waited=${Math.max(0, Date.now() - (r.startedAt || Date.now()))}ms`);
    const last = runtime.lastRun?.();
    if (last) {
      lines.push(`last run: session=${last.sessionId || '-'} reason=${last.reasonCode} wait=${last.waitStatus ?? '-'} resumed=${last.resumed === true}`);
      if (last.reply) lines.push(`  reply: ${oneLine(last.reply).slice(0, 200)}`);
    }
    const cred = getCredentialMeta();
    lines.push(`signin: ${cred.configured ? `configured (${cred.masked}, ${cred.accountId})` : 'not configured (paste pt- PAT in settings)'} · region=cn`);
    const credits = runtime.credits?.();
    if (credits) lines.push(`credits: checkedAt=${credits.checkedAt || ''} state=${credits.claimState || 'unknown'}${credits.error ? ` error=${credits.error}` : ''}`);
    const su = inspectStartup(cfg);
    lines.push(`startup: path="${su.path}" exists=${su.exists} matches=${su.matches} port=${su.port}`);
    lines.push(`startup.registryRunKey: checked=${su.registryRunKey.checked} detected=${su.registryRunKey.detected} · ${su.registryRunKey.note}`);
    lines.push('scheduled_tasks: not applicable (Qoder has no plan task list) — count=0 invariant for this harness.');
    lines.push('approval relay: unknown/unverified (not fabricated).');
    return { text: lines.join('\n') };
  },
});
