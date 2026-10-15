/**
 * 路由与断面文案测试 —— 状态载荷形状（契约字段名）、loopback 栅栏、诊断缓存、
 * `variantCapability`（红线探针的真实消费者）与系统提示文案的三态。
 *
 * @module test/routes.test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { availabilityText } from '../src/host/prompts/availability.js';
import { makeDiagnosticsRoute } from '../src/host/routes/diagnostics/get.js';
import { makeRoutes } from '../src/host/routes/index.js';
import { approvalsFromLastRun, makeStatusRoute, variantCapability } from '../src/host/routes/status/get.js';

function makeReq({ remote = '127.0.0.1', host = '127.0.0.1:3000' } = {}) {
  return { socket: { remoteAddress: remote }, headers: { host } };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(text) { this.body = text; },
  };
}

function parse(res) {
  return JSON.parse(res.body);
}

function makeStatusRuntime({ config = {}, probe = null, registry = 'UNKNOWN', last = null } = {}) {
  const full = {
    enabled: true, model: '', variant: '', workspace: '', boundSessionId: '', serviceDir: '', baseUrl: '', waitTimeoutMs: 900_000,
    launch: { variantValues: {} },
    ...config,
  };
  return {
    currentConfig: () => full,
    probeState: () => (probe === null
      ? { status: 'idle', result: null, pendingReason: 'detection-not-started' }
      : { status: 'done', result: probe, pendingReason: '' }),
    registry: () => registry,
    inFlight: () => [],
    lastRun: () => last,
  };
}

const CATALOG = {
  ok: true,
  models: [
    { id: 'deepseek-v4.1-flash-free', providerID: 'opencode', variants: ['low', 'high', 'max'], isFree: true, status: '', enabled: true },
  ],
  source: 'http://127.0.0.1:49374',
};

// ─────────────────── variantCapability（红线口径） ───────────────────

test('variantCapability：服务实况优先；数据表兜底；两者皆无如实说不知道', () => {
  const cfg = { model: 'p/m', launch: { variantValues: { 'p/m': ['a', 'b'] } } };
  const withService = variantCapability(cfg, ['low', 'high']);
  assert.equal(withService.source, 'service');
  assert.deepEqual(withService.values, ['low', 'high']);

  const fromTable = variantCapability(cfg);
  assert.equal(fromTable.source, 'config');
  assert.deepEqual(fromTable.values, ['a', 'b']);

  const nothing = variantCapability({ model: 'p/m', launch: { variantValues: {} } });
  assert.equal(nothing.source, 'unavailable:no-data');
  assert.deepEqual(nothing.values, []);
});

test('variantCapability：红线哨兵口径自检（键值必须出现在返回值 JSON 里）', () => {
  const probeCfg = { model: '__DSHKNOB_model__', launch: { variantValues: '__DSHKNOB_variantValues__' } };
  const blob = JSON.stringify(variantCapability(probeCfg));
  assert.ok(blob.includes('__DSHKNOB_variantValues__'), 'variantValues 的哨兵必须可观察（键真的被读走）');
});

test('approvalsFromLastRun：只数 pending，且带审批清单上限', () => {
  const many = Array.from({ length: 12 }, (_v, i) => ({ requestID: `r${i}`, action: 'bash', state: 'pending', decision: '' }));
  const out = approvalsFromLastRun({ sessionId: 'ses_1', at: 7, permissionRequests: [...many, { requestID: 'x', action: 'b', state: 'replied', decision: 'once' }] });
  assert.equal(out.pendingCount, 12);
  assert.equal(out.items.length, 10);
  assert.equal(out.items[0].sessionID, 'ses_1');
  assert.equal(out.items[0].at, 7);
  assert.equal(approvalsFromLastRun(null).pendingCount, 0);
});

// ─────────────────── 状态路由 ───────────────────

test('status 路由：loopback 可得完整载荷（形状=StatusPayload）；档位走服务实况', async () => {
  const last = {
    sessionId: 'ses_1', sessionKey: 'k1', resumed: true, promptExcerpt: 'p', delivery: 'queue',
    acceptedAt: 1, idleAt: 2, waitStatus: 'idle-204', outcome: 'succeeded', reply: 'ok', permissionRequests: [],
    model: null, cost: 0.1, tokens: null, reasonCode: 'ok', reasonText: '', reasonEvidence: '', at: 3,
  };
  const runtime = makeStatusRuntime({
    config: { model: 'opencode/deepseek-v4.1-flash-free', variant: 'high', workspace: 'D:/w' },
    probe: { installed: true, reason: 'ok', version: '2.0.28', pid: 9, baseUrl: 'http://127.0.0.1:49374', servicePath: 'C:/x/service.json', evidence: [] },
    registry: 'REGISTERED',
    last,
  });
  const dispatch = { models: async () => CATALOG };
  const route = makeStatusRoute(runtime, {}, dispatch, { now: () => 42 });

  const res = makeRes();
  await route.handler(makeReq(), res);
  assert.equal(res.statusCode, 200);
  const payload = parse(res);
  assert.equal(payload.pluginId, 'dsh-plugin-opencode');
  assert.equal(payload.registry, 'REGISTERED');
  assert.equal(payload.probe.version, '2.0.28');
  assert.equal(payload.config.model, 'opencode/deepseek-v4.1-flash-free');
  assert.equal(payload.config.waitTimeoutMs, 900_000);
  assert.equal(payload.variant.source, 'service');
  assert.deepEqual(payload.variant.values, ['low', 'high', 'max']);
  assert.equal(payload.models.length, 1);
  assert.equal(payload.modelsSource, 'service');
  assert.equal(payload.lastRun.sessionId, 'ses_1');
  assert.equal(payload.approvals.pendingCount, 0);
  assert.equal(payload.at, 42);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
});

test('status 路由：非回环 ⇒ 403 fail-closed（socket 与 Host 两道栅栏）', async () => {
  const runtime = makeStatusRuntime({});
  const route = makeStatusRoute(runtime, {}, { models: async () => CATALOG });
  const res1 = makeRes();
  await route.handler(makeReq({ remote: '192.168.1.5' }), res1);
  assert.equal(res1.statusCode, 403);
  const res2 = makeRes();
  await route.handler(makeReq({ host: 'evil.example.com' }), res2);
  assert.equal(res2.statusCode, 403);
  const res3 = makeRes();
  await route.handler(makeReq({ remote: '::ffff:127.0.0.1' }), res3);
  assert.equal(res3.statusCode, 200, 'IPv4-mapped 回环形态应放行');
});

test('status 路由：服务不可用 ⇒ modelsSource 说 unavailable，不拿旧数据冒充实况', async () => {
  const runtime = makeStatusRuntime({ config: { model: 'p/m' } });
  const route = makeStatusRoute(runtime, {}, { models: async () => ({ ok: false, reason: 'service_unreachable', models: [], source: 'none' }) });
  const res = makeRes();
  await route.handler(makeReq(), res);
  const payload = parse(res);
  assert.deepEqual(payload.models, []);
  assert.equal(payload.modelsSource, 'unavailable:service_unreachable');
  assert.equal(payload.variant.source, 'unavailable:service_unreachable');
});

// ─────────────────── 诊断路由 ───────────────────

test('diagnostics 路由：关闭时不做体检；开着时 checks 带缓存', async () => {
  let calls = 0;
  const dispatch = { inspect: async () => { calls += 1; return { ok: true, checks: [{ id: 'config', ok: true, detail: 'enabled=true' }], at: 5 }; } };
  const off = makeDiagnosticsRoute(dispatch, makeStatusRuntime({ config: { enabled: false } }), { now: () => 100 });
  const resOff = makeRes();
  await off.handler(makeReq(), resOff);
  assert.deepEqual(parse(resOff), { available: false, reason: 'plugin-disabled' });
  assert.equal(calls, 0);

  const on = makeDiagnosticsRoute(dispatch, makeStatusRuntime({ config: { enabled: true } }), { now: () => 100 });
  const res1 = makeRes();
  await on.handler(makeReq(), res1);
  assert.equal(parse(res1).cached, false);
  const res2 = makeRes();
  await on.handler(makeReq(), res2);
  assert.equal(parse(res2).cached, true);
  assert.equal(calls, 1, 'TTL 内不得重复体检');
  const resBad = makeRes();
  await on.handler(makeReq({ remote: '10.0.0.1' }), resBad);
  assert.equal(resBad.statusCode, 403);
});

test('makeRoutes：装配 2 条 exact 路由（状态 + 诊断），路径取自 shared 常量', () => {
  const routes = makeRoutes(makeStatusRuntime({}), {}, { models: async () => CATALOG });
  assert.equal(routes.length, 2);
  assert.equal(routes[0].kind, 'exact');
  assert.ok(routes.some((r) => r.path === '/plugin-opencode/status'));
  assert.ok(routes.some((r) => r.path === '/plugin-opencode/diagnostics'));
});

// ─────────────────── 可用性提示（三态 + 失败提示） ───────────────────

test('availabilityText：三态不撒谎（关闭 / 探测中 / 服务缺失 / 就绪含逐次提示）', () => {
  const off = availabilityText({ currentConfig: () => ({ enabled: false }), probeState: () => ({ status: 'idle', result: null, pendingReason: '' }), lastRun: () => null });
  assert.match(off, /switched OFF/);

  const pending = availabilityText({ currentConfig: () => ({ enabled: true }), probeState: () => ({ status: 'pending', result: null, pendingReason: 'detection-in-flight' }), lastRun: () => null });
  assert.match(pending, /still running/);

  const missing = availabilityText({
    currentConfig: () => ({ enabled: true }),
    probeState: () => ({ status: 'done', result: { installed: false, reason: 'service-missing' }, pendingReason: '' }),
    lastRun: () => null,
  });
  assert.match(missing, /was NOT found \(service-missing\)/);

  const ready = availabilityText({
    currentConfig: () => ({ enabled: true, model: '', variant: 'high' }),
    probeState: () => ({ status: 'done', result: { installed: true }, pendingReason: '' }),
    lastRun: () => null,
  });
  assert.match(ready, /is available/);
  assert.match(ready, /model not set — choosing one is your call/);
  assert.match(ready, /reasoning variant "high"/);

  const failed = availabilityText({
    currentConfig: () => ({ enabled: true }),
    probeState: () => ({ status: 'done', result: { installed: true }, pendingReason: '' }),
    lastRun: () => ({ reasonCode: 'wait_timeout', reasonText: '等待超时', reasonEvidence: 'ev' }),
  });
  assert.match(failed, /ended with wait_timeout/);
});
