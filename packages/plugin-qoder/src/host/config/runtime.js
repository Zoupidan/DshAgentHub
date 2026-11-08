/**
 * 插件端 SSOT（Single Source of Truth）—— 全部可变状态的唯一持有者（plugin-qoder 版）。
 *
 * 结构与 plugin-opencode/src/host/config/runtime.js 同构（target 注入、probeState 三态、
 * inFlight 记账、lastRun、signin/credits 快照）。本文件**不认识 ctx.jobs**（H-ORTHOGONAL）。
 *
 * @module host/config/runtime
 */
import { REGISTRY_STATES, RUN_STATES, PROBE_TARGET } from './constants.js';
import { DEFAULT_CDP_PORT } from '../../shared/constants.js';

export const DEFAULT_CONCURRENCY_CAP = 3;

export function defaultProbeState(target = PROBE_TARGET) {
  return { status: 'idle', target, result: null, pendingReason: 'detection-not-started' };
}

export function createRuntime(options = {}) {
  const pluginId = options.pluginId ?? 'plugin-qoder';
  const ns = options.ns ?? 'dsh-plugin-qoder';
  const target = options.target ?? PROBE_TARGET;

  let _config = options.config ?? {};
  let _registry = REGISTRY_STATES.UNKNOWN;
  let _registrationError = null;
  let _probe = defaultProbeState(target);
  let _serviceInfo = null; // { baseUrl, port, targetId, title, url, endpointId, workspaceCatalog }
  let _lastRun = null;
  const _inFlight = new Map();
  let _credits = null; // { usage, campaigns, claimState, checkedAt, error? }
  let _boundSession = '';
  const _concurrencyCap = Number.isFinite(options.concurrencyCap) && options.concurrencyCap > 0
    ? Math.floor(options.concurrencyCap) : DEFAULT_CONCURRENCY_CAP;

  function _now() { return Date.now(); }

  function currentConfig() {
    // volatile 字段在宿主侧可能是 {get()} 包装器；这里做最小解包，保持与 opencode 口径兼容。
    const src = _config && typeof _config === 'object' ? _config : {};
    const out = { ...src };
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (v && typeof v === 'object' && typeof v.get === 'function' && Object.keys(v).length <= 2) {
        try { out[k] = v.get(); } catch { /* 保留原值 */ }
      }
    }
    return out;
  }

  return {
    pluginId, ns, target, concurrencyCap: _concurrencyCap,

    current: currentConfig,
    currentConfig,
    setConfig(next) { _config = (next && typeof next === 'object') ? next : {}; return _config; },

    registry() { return _registry; },
    setRegistry(state, reason) {
      if (Object.values(REGISTRY_STATES).includes(state)) _registry = state;
      else _registry = REGISTRY_STATES.UNKNOWN;
      if (reason !== undefined) _registrationError = reason == null ? null : String(reason);
      return _registry;
    },
    registrationError() { return _registrationError; },
    setRegistrationError(err) { _registrationError = err == null ? null : String(err); return _registrationError; },

    probeState() { return _probe; },
    probe() { return _probe.result; },
    probePending(reason) {
      _probe = { status: 'pending', target, result: _probe.result, pendingReason: String(reason ?? 'detection-in-flight') };
      return _probe;
    },
    setProbe(result) {
      _probe = { status: 'done', target, result: result ?? null, pendingReason: '' };
      return _probe;
    },

    serviceInfo() { return _serviceInfo; },
    setServiceInfo(info) { _serviceInfo = info && typeof info === 'object' ? info : null; return _serviceInfo; },

    credits() { return _credits; },
    setCredits(next) { _credits = next && typeof next === 'object' ? next : null; return _credits; },

    boundSession() { return typeof _boundSession === 'string' ? _boundSession : ''; },
    setBoundSession(id) { _boundSession = typeof id === 'string' ? id.trim() : ''; return _boundSession; },

    inFlightCount() { return _inFlight.size; },
    inFlight() {
      return [..._inFlight.values()].map((r) => ({
        sessionKey: r.sessionKey, sessionId: r.sessionId, startedAt: r.startedAt, phase: r.phase ?? '',
      }));
    },
    async reprobe(probeFn, ctx, cfg) {
      this.probePending('detection-in-flight');
      try {
        const res = await (typeof probeFn === 'function' ? probeFn(cfg ?? currentConfig()) : null);
        this.setProbe(res);
        if (res?.installed) {
          this.setServiceInfo({ port: (cfg ?? currentConfig())?.cdpPort, baseUrl: res.baseUrl, targetId: res.targetId, targetTitle: res.targetTitle, targetUrl: res.targetUrl });
        }
        return this.probeState();
      } catch (e) {
        this.setProbe({ installed: false, reason: 'error', evidence: [{ at: Date.now(), method: 'internal', target: 'reprobe', detail: String(e?.message ?? e).slice(0, 180) }], at: Date.now() });
        return this.probeState();
      }
    },
    getRun(key) { return key ? _inFlight.get(key) ?? null : null; },
    startRun(key, meta = {}) {
      if (typeof key !== 'string' || !key) return { ok: false, reason: 'bad-key' };
      if (_inFlight.has(key)) return { ok: false, reason: 'workspace-busy', record: _inFlight.get(key) };
      if (_inFlight.size >= _concurrencyCap) return { ok: false, reason: 'concurrency-limit', count: _inFlight.size };
      const rec = {
        sessionKey: key, sessionId: String(meta.sessionId ?? ''), startedAt: _now(),
        phase: String(meta.phase ?? ''), state: RUN_STATES.RUNNING,
      };
      _inFlight.set(key, rec);
      return { ok: true, record: rec };
    },
    updateRun(key, patch = {}) {
      const rec = _inFlight.get(key);
      if (!rec) return null;
      if (typeof patch.sessionId === 'string') rec.sessionId = patch.sessionId;
      if (typeof patch.phase === 'string') rec.phase = patch.phase;
      return rec;
    },
    finishRun(key, result = {}) {
      const rec = _inFlight.get(key) ?? null;
      if (rec) _inFlight.delete(key);
      _lastRun = {
        sessionId: String(result.sessionId ?? rec?.sessionId ?? ''),
        sessionKey: String(key ?? rec?.sessionKey ?? ''),
        resumed: !!result.resumed,
        promptExcerpt: String(result.promptExcerpt ?? ''),
        acceptedAt: Number.isFinite(result.acceptedAt) ? result.acceptedAt : null,
        idleAt: Number.isFinite(result.idleAt) ? result.idleAt : null,
        waitStatus: result.waitStatus ?? null,
        outcome: result.outcome ?? null,
        reply: String(result.reply ?? ''),
        model: result.model ?? null,
        reasonCode: String(result.reasonCode ?? 'ok'),
        reasonText: String(result.reasonText ?? ''),
        reasonEvidence: String(result.reasonEvidence ?? ''),
        at: _now(),
      };
      return _lastRun;
    },
    forgetRun(key) { if (key) _inFlight.delete(key); },
    lastRun() { return _lastRun; },
    setLastRun(next) { _lastRun = next && typeof next === 'object' ? next : null; return _lastRun; },

    state() {
      return {
        pluginId, ns, registry: _registry, registrationError: _registrationError,
        probe: _probe, serviceInfo: _serviceInfo ? { ..._serviceInfo, endpointId: _serviceInfo.endpointId } : null,
        inFlight: this.inFlight(), lastRun: _lastRun, credits: _credits, at: _now(),
      };
    },
  };
}
