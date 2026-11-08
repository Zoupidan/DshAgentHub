/**
 * 下发与回执（submitRich + readHistory 轮询）。事实出处 04-docs/qoder/15。
 * @module host/gateway/dispatch
 */
import { randomUUID } from 'node:crypto';
import { withCdp, describeSystem, listChatModels, submitRich, readHistory, catalogList, listWorkspaces } from './cdp.js';
import { REASON_CODES, REASON_TEXT, redact, oneLine } from '../launch/reason-codes.js';
import { isSessionId } from '../session/map.js';
import { DEFAULT_CDP_PORT } from '../../shared/constants.js';

export function deriveSessionKey(input = {}) {
  if (typeof input.session_key === 'string' && input.session_key.trim()) return input.session_key.trim().slice(0, 200);
  if (typeof input.sessionKey === 'string' && input.sessionKey.trim()) return input.sessionKey.trim().slice(0, 200);
  const ws = String(input.workspace ?? input.cwd ?? '').trim();
  return `qoder:${ws || 'default'}`;
}

export function promptExcerpt(text, max = 120) {
  const s = oneLine(redact(String(text ?? ''))).replace(/\s+/g, ' ');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  });
}

function extractAssistantText(history) {
  if (history == null) return '';
  if (typeof history === 'string') return history;
  if (Array.isArray(history)) {
    const parts = [];
    for (const item of history) {
      const role = String(item?.role ?? item?.author ?? item?.type ?? '').toLowerCase();
      if (role.includes('assistant') || role.includes('ai') || role.includes('model')) {
        const text = item?.content ?? item?.text ?? item?.message ?? item?.body ?? '';
        if (typeof text === 'string' && text.trim()) parts.push(text);
        else if (Array.isArray(text)) parts.push(text.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join(''));
      }
    }
    if (parts.length) return parts.join('\n').trim();
    // fallback: last item's text
    const last = history[history.length - 1];
    const t = typeof last?.content === 'string' ? last.content : typeof last?.text === 'string' ? last.text : '';
    if (t) return t;
  }
  if (typeof history === 'object') {
    const candidates = [history.messages, history.items, history.turns, history.history, history.entries, history.data];
    for (const c of candidates) if (Array.isArray(c)) return extractAssistantText(c);
    if (typeof history.text === 'string') return history.text;
    if (typeof history.content === 'string') return history.content;
    if (typeof history.reply === 'string') return history.reply;
  }
  return '';
}

function extractOutcome(history) {
  if (!history || typeof history !== 'object') return null;
  const status = String(history.status ?? history.outcome ?? history.state ?? '').toLowerCase();
  if (status.includes('fail') || status.includes('error')) return 'failed';
  if (status.includes('interrupt') || status.includes('cancel') || status.includes('abort')) return 'interrupted';
  if (status.includes('complet') || status.includes('success') || status.includes('done') || status.includes('idle')) return 'succeeded';
  // heuristic from message roles
  if (Array.isArray(history)) {
    const last = history[history.length - 1];
    const st = String(last?.status ?? last?.state ?? '').toLowerCase();
    if (st.includes('complet') || st.includes('done')) return 'succeeded';
  }
  return null;
}

function hasNewAssistantSince(history, baselineCount) {
  if (Array.isArray(history)) return history.length > baselineCount;
  const arr = history?.messages ?? history?.items ?? history?.turns ?? history?.history ?? history?.entries;
  if (Array.isArray(arr)) return arr.length > baselineCount;
  return !!extractAssistantText(history);
}

function historyCount(history) {
  if (Array.isArray(history)) return history.length;
  const arr = history?.messages ?? history?.items ?? history?.turns ?? history?.history ?? history?.entries;
  return Array.isArray(arr) ? arr.length : 0;
}

function matchWorkspaceItems(items, wsPath) {
  const norm = String(wsPath || '').replace(/\\/g, '/').toLowerCase();
  if (!norm) return null;
  for (const it of (Array.isArray(items) ? items : [])) {
    const w = it?.workspace && typeof it.workspace === 'object' ? it.workspace : null;
    const p = String(it?.workspacePath ?? it?.displayPath ?? it?.path ?? w?.path ?? it?.rootPath ?? '').replace(/\\/g, '/').toLowerCase();
    const wid = String(it?.workspaceId ?? w?.workspaceId ?? w?.id ?? (it?.kind === 'workspace' ? it?.id : '') ?? '');
    if (!wid || !p) continue;
    if (norm === p || norm.startsWith(p + '/') || p.startsWith(norm + '/')) {
      return { workspaceId: wid, workspacePath: String(it?.workspacePath ?? it?.displayPath ?? it?.path ?? wsPath), endpointId: String(w?.endpointId ?? it?.endpointId ?? '') };
    }
  }
  return null;
}

async function resolveWorkspace(session, config, cwd, authorityCtx = {}) {
  const explicitId = typeof config.workspaceId === 'string' ? config.workspaceId.trim() : '';
  const explicitPath = typeof config.workspace === 'string' ? config.workspace.trim() : '';
  const wsPath = cwd || explicitPath;
  if (explicitId) return { workspaceId: explicitId, workspacePath: wsPath || undefined, endpointId: authorityCtx.endpointId || '' };
  for (const fetcher of [() => listWorkspaces(session, authorityCtx), () => catalogList(session, authorityCtx)]) {
    try {
      const raw = await fetcher();
      const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.workspaces) ? raw.workspaces : Array.isArray(raw?.sessions) ? raw.sessions : [];
      const hit = matchWorkspaceItems(items, wsPath);
      if (hit) return hit;
    } catch {}
  }
  return null;
}

export function createDispatch({ runtime, sessions, logger }) {
  const log = (msg) => { try { logger?.info?.(`[qoder-dispatch] ${msg}`); } catch {} };

  async function models(config, ctx = {}) {
    const port = Number.isFinite(config?.cdpPort) ? config.cdpPort : DEFAULT_CDP_PORT;
    try {
      return await withCdp(port, async (session) => {
        let authority = ctx;
        if (!authority?.authorityEndpointId && !authority?.endpointId) {
          try { const d = await describeSystem(session); authority = { authorityEndpointId: String(d?.endpointId ?? d?.authorityEndpointId ?? ''), endpointId: String(d?.endpointId ?? '') }; } catch {}
        }
        const raw = await listChatModels(session, authority);
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.catalog?.models) ? raw.catalog.models : [];
        return { source: list.length ? 'service' : `service:empty-shape(${Object.keys(raw||{}).slice(0,4).join(',')})`, models: list, raw };
      });
    } catch (e) {
      return { source: `unavailable:${oneLine(redact(e?.message ?? e)).slice(0, 80)}`, models: [], error: String(e?.message ?? e) };
    }
  }

  function pickModel(config, modelList) {
    const want = typeof config?.model === 'string' ? config.model.trim() : '';
    if (!want) return null;
    const hit = (Array.isArray(modelList) ? modelList : []).find((m) => String(m?.modelKey ?? m?.id ?? m?.key ?? '') === want);
    if (!hit) return { ok: false, reason: REASON_CODES.MODEL_UNKNOWN, modelKey: want };
    const out = { modelKey: String(hit.modelKey ?? hit.id ?? want) };
    // effort/context: only attach if capability known to include it; reasoningEffort submitRich param is unverified => report unknown, do not send
    const effort = typeof config?.reasoningEffort === 'string' ? config.reasoningEffort.trim() : '';
    if (effort) {
      const efforts = Array.isArray(hit.efforts) ? hit.efforts.map((e) => (typeof e === 'string' ? e : e?.id ?? e?.key ?? e?.value)).filter(Boolean) : [];
      if (efforts.includes(effort)) {
        out.reasoningEffort = effort;
        out.reasoningEffortVerified = false; // submitRich input param 待验 (doc 14/15)
      } else {
        return { ok: false, reason: REASON_CODES.MODEL_UNKNOWN, modelKey: want, detail: `effort=${effort} 不在目录能力中` };
      }
    }
    const ctxw = Number(config?.contextWindow ?? 0);
    if (Number.isFinite(ctxw) && ctxw > 0) {
      const windows = Array.isArray(hit.availableContextWindows) ? hit.availableContextWindows.map((n) => Number(n)).filter(Number.isFinite) : [];
      if (windows.includes(ctxw)) out.contextWindow = ctxw;
      else return { ok: false, reason: REASON_CODES.MODEL_UNKNOWN, modelKey: want, detail: `contextWindow=${ctxw} 不在目录能力中` };
    }
    return { ok: true, value: out, catalogEntry: hit };
  }

  async function run(input, opts = {}) {
    const cfg = runtime.current();
    const port = Number.isFinite(cfg?.cdpPort) ? cfg.cdpPort : DEFAULT_CDP_PORT;
    const sessionKey = deriveSessionKey({ ...input, workspace: input?.workspace ?? cfg?.workspace });
    const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
    const waitOnly = input?.wait_only === true || input?.waitOnly === true;
    if (!prompt.trim() && !waitOnly) {
      return { ok: false, reasonCode: REASON_CODES.DISPATCH_REJECTED, reasonText: '缺少 prompt（wait_only=true 时才可省略）', sessionKey };
    }
    const resume = typeof input?.resume === 'string' && isSessionId(input.resume) ? input.resume.trim() : '';
    const bound = typeof cfg?.boundSessionId === 'string' && isSessionId(cfg.boundSessionId) ? cfg.boundSessionId.trim() : '';
    const mapped = await sessions.get(sessionKey).catch(() => null);
    const targetSessionId = resume || bound || (isSessionId(mapped?.sessionId) ? mapped.sessionId : '');
    const cwd = String(input?.workspace ?? input?.cwd ?? cfg?.workspace ?? '').trim();
    const start = runtime.startRun(sessionKey, { phase: 'connecting', sessionId: targetSessionId });
    if (!start.ok) {
      const reason = start.reason === 'concurrency-limit' ? REASON_CODES.UPSTREAM_ERROR : REASON_CODES.DISPATCH_REJECTED;
      return { ok: false, reasonCode: reason, reasonText: REASON_TEXT[reason] || start.reason, sessionKey, detail: start };
    }
    const onPhase = (p) => runtime.updateRun(sessionKey, { phase: p });
    const signal = opts.signal;
    const timeoutMs = Number.isFinite(input?.wait_timeout_ms) ? Number(input.wait_timeout_ms)
      : Number.isFinite(cfg?.waitTimeoutMs) ? Number(cfg.waitTimeoutMs) : 900_000;

    try {
      return await withCdp(port, async (session) => {
        onPhase('resolving-session');
        const desc = await describeSystem(session).catch(() => null);
        const endpointId = String(desc?.endpointId ?? desc?.authorityEndpointId ?? desc?.value?.endpointId ?? cfg?.endpointId ?? '').trim();
        const authorityCtx = endpointId ? { authorityEndpointId: endpointId, endpointId } : {};
        if (endpointId) runtime.setServiceInfo({ ...(runtime.serviceInfo() ?? {}), port, endpointId });

        let modelList = [];
        try { const mr = await listChatModels(session, authorityCtx); modelList = Array.isArray(mr) ? mr : Array.isArray(mr?.models) ? mr.models : Array.isArray(mr?.items) ? mr.items : []; } catch {}
        const modelPick = pickModel(cfg, modelList);
        if (modelPick && modelPick.ok === false) {
          const rec = runtime.finishRun(sessionKey, { sessionId: targetSessionId, resumed: !!targetSessionId, promptExcerpt: promptExcerpt(prompt), reasonCode: modelPick.reason, reasonText: REASON_TEXT[modelPick.reason] || modelPick.detail || '', reasonEvidence: modelPick.detail || '' });
          return { ok: false, sessionKey, sessionId: targetSessionId, ...rec };
        }

        let sessionId = targetSessionId;
        let resumed = !!targetSessionId;
        let workspaceResolved = null;
        if (!sessionId) {
          onPhase('creating-session');
          workspaceResolved = await resolveWorkspace(session, cfg, cwd, authorityCtx);
          if (!workspaceResolved?.workspaceId) {
            const rec = runtime.finishRun(sessionKey, { sessionId: '', resumed: false, promptExcerpt: promptExcerpt(prompt), reasonCode: REASON_CODES.WORKSPACE_UNKNOWN, reasonText: REASON_TEXT[REASON_CODES.WORKSPACE_UNKNOWN], reasonEvidence: `workspace=${oneLine(cwd).slice(0, 120)} workspaces/catalog未命中` });
            return { ok: false, sessionKey, ...rec };
          }
          sessionId = randomUUID();
          resumed = false;
        }

        const sessionRef = endpointId ? { authorityEndpointId: endpointId, sessionId } : { sessionId };
        let baseline = 0;
        if (!waitOnly && prompt.trim()) {
          try { const hist = await readHistory(session, sessionRef, { timeoutMs: 10_000 }); baseline = historyCount(hist); } catch {}
        } else if (waitOnly) {
          try { const hist = await readHistory(session, sessionRef, { timeoutMs: 10_000 }); baseline = historyCount(hist); } catch {}
        }

        if (!waitOnly && prompt.trim()) {
          onPhase('prompting');
          const payload = {
            session: sessionRef,
            newSession: !resumed,
            inputId: randomUUID(),
            clientSubmittedAtEpochMs: Date.now(),
            agentId: 'agent:default',
            inputSource: 'composer',
            prompt,
            attachments: [],
            selectedSkillNames: [],
            selectedPluginIds: [],
            selectedConnectorIds: [],
            selectedAgentNames: [],
            selectedCapabilityCommands: [],
            referencedChatSessionIds: [],
            productMode: 'coding',
            // permissionMode omitted => server 'auto' (per contract; explicit 5-value literals unverified)
          };
          if (modelPick?.ok && modelPick.value?.modelKey) {
            payload.model = { modelKey: modelPick.value.modelKey };
            // reasoningEffort submitRich param 待验 (doc 14/15): 不发送，仅记录 unknown 能力事实
            if (Number.isFinite(modelPick.value.contextWindow) && modelPick.value.contextWindow > 0) payload.contextWindow = modelPick.value.contextWindow;
          }
          if (!resumed && workspaceResolved?.workspaceId) {
            payload.workspace = endpointId ? { endpointId, workspaceId: workspaceResolved.workspaceId } : { workspaceId: workspaceResolved.workspaceId };
          }
          if (resumed && !endpointId) {
            // continue can work with sessionId alone per doc shape flexibility; keep as-is
          }
          let accepted;
          try {
            accepted = await submitRich(session, payload, { timeoutMs: 30_000 });
          } catch (e) {
            const msg = oneLine(redact(e?.message ?? e)).slice(0, 240);
            const rec = runtime.finishRun(sessionKey, { sessionId, resumed, promptExcerpt: promptExcerpt(prompt), acceptedAt: Date.now(), reasonCode: REASON_CODES.DISPATCH_REJECTED, reasonText: REASON_TEXT[REASON_CODES.DISPATCH_REJECTED], reasonEvidence: msg });
            await sessions.touch(sessionKey, { sessionId, state: 'unconfirmed', workspace: cwd || mapped?.workspace || '' }).catch(() => {});
            return { ok: false, sessionKey, sessionId, ...rec };
          }
          runtime.updateRun(sessionKey, { sessionId, phase: 'waiting' });
          await sessions.set(sessionKey, { sessionId, workspace: workspaceResolved?.workspacePath || cwd || mapped?.workspace || '', workspaceId: workspaceResolved?.workspaceId || mapped?.workspaceId || '', own: !resumed ? true : !!mapped?.own, state: 'resumable' }).catch(() => {});
          log(`accepted session=${sessionId} resumed=${resumed} ack=${oneLine(redact(JSON.stringify(accepted))).slice(0, 120)}`);
        } else {
          runtime.updateRun(sessionKey, { sessionId, phase: 'waiting' });
        }

        onPhase('receipt');
        const deadline = Date.now() + Math.max(5_000, timeoutMs);
        let lastHistory = null;
        let waitStatus = 'idle';
        while (Date.now() < deadline) {
          if (signal?.aborted) { waitStatus = 'aborted'; break; }
          try { lastHistory = await readHistory(session, sessionRef, { timeoutMs: 15_000 }); } catch (e) { lastHistory = lastHistory ?? { _readError: String(e?.message ?? e) }; }
          const outcome = extractOutcome(lastHistory);
          if (outcome === 'failed' || outcome === 'interrupted') { waitStatus = outcome; break; }
          if (hasNewAssistantSince(lastHistory, baseline)) {
            // if we can tell it completed, stop; else give it a short settle window once
            if (outcome === 'succeeded') { waitStatus = 'idle-204'; break; }
            const text = extractAssistantText(lastHistory);
            if (text && text.trim().length > 0) { waitStatus = 'idle-204'; break; }
          }
          try { await sleep(1200, signal); } catch { waitStatus = 'aborted'; break; }
        }
        if (Date.now() >= deadline && waitStatus === 'idle') waitStatus = 'timeout';

        const reply = extractAssistantText(lastHistory);
        const outcome = extractOutcome(lastHistory) ?? (reply ? 'succeeded' : (waitStatus === 'timeout' ? null : null));
        const reasonCode = waitStatus === 'timeout' ? REASON_CODES.WAIT_TIMEOUT
          : outcome === 'failed' ? REASON_CODES.DISPATCH_REJECTED
          : outcome === 'interrupted' ? REASON_CODES.DISPATCH_REJECTED
          : REASON_CODES.OK;
        const rec = runtime.finishRun(sessionKey, {
          sessionId, resumed, promptExcerpt: promptExcerpt(prompt),
          acceptedAt: Date.now(), idleAt: waitStatus === 'idle-204' ? Date.now() : null,
          waitStatus, outcome, reply: redact(reply).slice(0, 8000),
          model: modelPick?.ok ? { modelKey: modelPick.value.modelKey, reasoningEffort: configReasoningUnknown(modelPick) ? `requested:${cfg?.reasoningEffort ?? ''}(unknown-submit-param)` : (modelPick.value.reasoningEffort ?? ''), contextWindow: modelPick.value.contextWindow ?? 0 } : null,
          reasonCode, reasonText: REASON_TEXT[reasonCode] ?? '', reasonEvidence: `waitStatus=${waitStatus}`,
        });
        return { ok: reasonCode === REASON_CODES.OK || waitStatus === 'timeout', sessionKey, sessionId, resumed, ...rec, historyAvailable: lastHistory != null };
      });
    } catch (e) {
      const msg = oneLine(redact(e?.message ?? e)).slice(0, 240);
      const code = /target_not_found|未找到.*renderer/i.test(msg) ? REASON_CODES.TARGET_NOT_FOUND
        : /cdp.*不可达|连接超时|ECONNREFUSED/i.test(msg) ? REASON_CODES.CDP_UNAVAILABLE
        : REASON_CODES.BRIDGE_ERROR;
      const rec = runtime.finishRun(sessionKey, { sessionId: targetSessionId, resumed: !!targetSessionId, promptExcerpt: promptExcerpt(prompt), reasonCode: code, reasonText: REASON_TEXT[code], reasonEvidence: msg });
      return { ok: false, sessionKey, sessionId: targetSessionId, ...rec };
    }
  }

  function configReasoningUnknown(modelPick) {
    const cfg = runtime.current();
    return !!(modelPick?.ok && modelPick.value?.reasoningEffort && typeof cfg?.reasoningEffort === 'string' && cfg.reasoningEffort.trim());
  }

  async function inspect(config = runtime.currentConfig?.() ?? {}) {
    const checks = [];
    checks.push({ id: 'config', ok: config.enabled === true, detail: `enabled=${config.enabled === true} cdpPort=${Number(config.cdpPort) || DEFAULT_CDP_PORT}` });
    try {
      const mr = await models(config);
      checks.push({ id: 'models', ok: mr.source === 'service', detail: `source=${mr.source} count=${(mr.models ?? []).length}` });
    } catch (e) {
      checks.push({ id: 'models', ok: false, detail: String(e?.message ?? e).slice(0, 160) });
    }
    return { available: config.enabled === true, checks, at: Date.now() };
  }

  return { run, models, inspect, deriveSessionKey };
}
