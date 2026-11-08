/**
 * Qoder CDP 网关（只读连接 + 页面 JS 桥调用）。
 *
 * 通道事实：`--remote-debugging-port=9333` 暴露 CDP；页面内桥为
 * `window.qoderDesktop.applicationInvoke({connectionId,requestId,method,input})`。
 * 事实出处：04-docs/qoder/15-真机点火实验记录-20261031.md。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 * 只连接本机 loopback；不代拉起/不代改 Qoder 配置。
 *
 * @module host/gateway/cdp
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { DEFAULT_CDP_PORT } from '../../shared/constants.js';
import { oneLine, redact } from '../launch/reason-codes.js';

const LOOPBACK = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 4000;
const EVAL_TIMEOUT_MS = 30_000;

function httpGetJson(port, path, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: LOOPBACK, port, path, timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) return reject(new Error(`CDP HTTP ${res.statusCode} ${path}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`CDP JSON 解析失败 ${path}: ${String(e?.message ?? e)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`CDP 连接超时 ${LOOPBACK}:${port}${path}`)));
    req.on('error', (e) => reject(new Error(`CDP 不可达 ${LOOPBACK}:${port}${path}: ${String(e?.message ?? e)}`)));
  });
}

function scoreTarget(t) {
  if (!t || typeof t !== 'object') return -1;
  const type = String(t.type ?? '').toLowerCase();
  if (type !== 'page') return -1;
  const url = String(t.url ?? '').toLowerCase();
  const title = String(t.title ?? '').toLowerCase();
  let score = 0;
  if (url.includes('qoder') || title.includes('qoder')) score += 10;
  if (url.startsWith('file:') || url.startsWith('vscode-file:') || url.startsWith('app:')) score += 1;
  if (url.includes('workbench') || url.includes('renderer')) score += 2;
  if (url.startsWith('devtools://') || url.includes('chrome-extension://')) score -= 100;
  if (!t.webSocketDebuggerUrl) score -= 50;
  return score;
}

export async function discoverTargets(port = DEFAULT_CDP_PORT) {
  const p = Number.isFinite(port) ? Math.floor(port) : DEFAULT_CDP_PORT;
  const list = await httpGetJson(p, '/json/list');
  return Array.isArray(list) ? list : [];
}

export async function pickQoderTarget(port = DEFAULT_CDP_PORT) {
  const targets = await discoverTargets(port);
  const ranked = targets.map((t) => ({ t, score: scoreTarget(t) })).filter((x) => x.score > -100).sort((a, b) => b.score - a.score);
  const best = ranked.find((x) => x.score > 0) ?? ranked[0];
  if (!best?.t) return null;
  return best.t;
}

export async function probeCdp(port = DEFAULT_CDP_PORT) {
  const p = Number.isFinite(port) ? Math.floor(port) : DEFAULT_CDP_PORT;
  const baseUrl = `http://${LOOPBACK}:${p}`;
  const evidence = [];
  const at = Date.now();
  const ev = (target, detail) => evidence.push({ at: Date.now(), method: 'cdp-http-readonly', target, detail: oneLine(redact(detail)) });
  try {
    let version = null;
    try { version = await httpGetJson(p, '/json/version'); ev(`${baseUrl}/json/version`, JSON.stringify({ Browser: version?.Browser, webSocketDebuggerUrl: !!version?.webSocketDebuggerUrl })); }
    catch (e) { ev(`${baseUrl}/json/version`, `unavailable: ${String(e?.message ?? e)}`); }
    const targets = await discoverTargets(p).catch((e) => { ev(`${baseUrl}/json/list`, `error: ${String(e?.message ?? e)}`); return []; });
    ev(`${baseUrl}/json/list`, `targets=${targets.length}`);
    const target = await pickQoderTarget(p).catch(() => null);
    if (!target) {
      return { installed: false, reason: targets.length ? 'target-not-found' : 'cdp-unavailable', baseUrl, targetId: '', targetUrl: '', targetTitle: '', endpointId: '', evidence, at };
    }
    ev(target.url || target.title || 'target', `picked type=${target.type} title=${String(target.title ?? '').slice(0, 80)}`);
    return {
      installed: true, reason: 'ok', baseUrl,
      targetId: String(target.id ?? ''),
      targetUrl: String(target.url ?? ''),
      targetTitle: String(target.title ?? ''),
      endpointId: '',
      webSocketDebuggerUrl: String(target.webSocketDebuggerUrl ?? ''),
      evidence, at,
    };
  } catch (e) {
    ev(baseUrl, `error: ${String(e?.message ?? e)}`);
    return { installed: false, reason: 'cdp-unavailable', baseUrl, targetId: '', targetUrl: '', targetTitle: '', endpointId: '', evidence, at };
  }
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }
  async open(timeoutMs = CONNECT_TIMEOUT_MS) {
    if (typeof WebSocket === 'undefined') throw new Error('当前 Node 环境无 WebSocket（需要 Node 22+）；无法连接 CDP');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`CDP WebSocket 连接超时: ${this.wsUrl}`)); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP WebSocket 错误: ${this.wsUrl}`)); }, { once: true });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
      ws.addEventListener('close', () => { this.closed = true; for (const [, p] of this.pending) p.reject(new Error('CDP 连接已关闭')); this.pending.clear(); });
    });
  }
  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return; }
    if (msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    }
  }
  send(method, params = {}, timeoutMs = EVAL_TIMEOUT_MS) {
    if (!this.ws || this.closed) return Promise.reject(new Error('CDP 未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 调用超时: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = EVAL_TIMEOUT_MS } = {}) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, replMode: false }, timeoutMs);
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || 'evaluate exception';
      throw new Error(oneLine(redact(text)));
    }
    return result?.result?.value;
  }
  close() { try { this.ws?.close(); } catch {} this.closed = true; }
}

export async function withCdp(port, fn, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const target = await pickQoderTarget(port);
  if (!target?.webSocketDebuggerUrl) {
    const err = new Error(`未找到 Qoder CDP renderer 目标（端口 ${port}）`);
    err.code = 'TARGET_NOT_FOUND';
    throw err;
  }
  const session = new CdpSession(String(target.webSocketDebuggerUrl));
  await session.open(timeoutMs);
  try { return await fn(session, target); }
  finally { session.close(); }
}

export function unwrapBridgeResult(raw) {
  if (raw && typeof raw === 'object' && typeof raw.ok === 'boolean') {
    if (raw.ok) return raw.value !== undefined ? raw.value : raw;
    const err = raw.error && typeof raw.error === 'object' ? raw.error : {};
    const msg = [err.code, err.domain, err.details?.method, err.details?.field, err.message].filter(Boolean).join(' ');
    const e = new Error(`bridge error: ${msg || JSON.stringify(err).slice(0, 180)}`);
    e.bridge = raw.error;
    throw e;
  }
  return raw;
}

export async function invokeBridge(session, method, input, { timeoutMs = EVAL_TIMEOUT_MS, connectionId, unwrap = false } = {}) {
  const connId = connectionId || `dsh-${randomUUID()}`;
  const reqId = `dsh-${randomUUID()}`;
  const payload = { connectionId: connId, requestId: reqId, method, input: input ?? {} };
  const expr = `(async () => {\n  const b = globalThis.qoderDesktop;\n  if (!b || typeof b.applicationInvoke !== 'function') throw new Error('qoderDesktop.applicationInvoke 不可用');\n  return await b.applicationInvoke(${JSON.stringify(payload)});\n})()`;
  const value = await session.evaluate(expr, { awaitPromise: true, returnByValue: true, timeoutMs });
  return { value: unwrap ? unwrapBridgeResult(value) : value, raw: value, connectionId: connId, requestId: reqId };
}

async function tryInvoke(session, candidates, { timeoutMs = 20_000 } = {}) {
  let lastErr;
  for (const c of candidates) {
    const method = typeof c === 'string' ? c : c.method;
    const input = typeof c === 'string' ? {} : (c.input ?? {});
    try {
      const { raw } = await invokeBridge(session, method, input, { timeoutMs });
      if (raw && raw.ok === false) { lastErr = Object.assign(new Error(`bridge ${method}: ${raw.error?.code || 'error'}`), { bridge: raw.error }); continue; }
      return unwrapBridgeResult(raw);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no bridge method succeeded');
}

export async function describeSystem(session) {
  const { raw } = await invokeBridge(session, 'system.describe', {}, { timeoutMs: 15_000 });
  return unwrapBridgeResult(raw);
}

export async function listChatModels(session, ctx = {}) {
  const eid = ctx.authorityEndpointId || ctx.endpointId || '';
  const base = eid ? { authorityEndpointId: eid, endpointId: eid } : {};
  const candidates = [
    { method: 'models.getCatalog', input: { ...base, fetchStrategy: 'cache' } },
    { method: 'models.getCatalog', input: { ...base, fetchStrategy: 'cacheFirst' } },
    { method: 'models.getCatalog', input: { ...base, fetchStrategy: 'remote' } },
    { method: 'listChatModels', input: eid ? { authorityEndpointId: eid } : {} },
    { method: 'chatSessions.listChatModels', input: eid ? { authorityEndpointId: eid } : {} },
  ];
  return await tryInvoke(session, candidates, { timeoutMs: 20_000 });
}

export async function listWorkspaces(session, ctx = {}) {
  const eid = ctx.authorityEndpointId || ctx.endpointId || '';
  return await tryInvoke(session, [
    { method: 'workspaces.list', input: eid ? { authorityEndpointId: eid } : {} },
    { method: 'workspaces.catalog.list', input: eid ? { endpointId: eid, authorityEndpointId: eid } : {} },
  ], { timeoutMs: 20_000 });
}

export async function catalogList(session, input = {}) {
  const eid = input.authorityEndpointId || input.endpointId || '';
  return await tryInvoke(session, [
    { method: 'chatSessions.catalog.list', input: { authorityEndpointId: eid, ...input } },
    { method: 'chatSessions.list', input: { authorityEndpointId: eid, ...input } },
    { method: 'workspaces.list', input: { authorityEndpointId: eid } },
  ], { timeoutMs: 20_000 });
}

export async function readHistory(session, sessionRef, options = {}) {
  const { raw } = await invokeBridge(session, 'chatSessions.readHistory', {
    session: sessionRef, ...(options.input ?? {}),
  }, { timeoutMs: Math.max(15_000, options.timeoutMs ?? 20_000) });
  return unwrapBridgeResult(raw);
}

export async function submitRich(session, input, { timeoutMs = 30_000 } = {}) {
  const { raw } = await invokeBridge(session, 'chatSessions.submitRich', input, { timeoutMs });
  return unwrapBridgeResult(raw);
}
