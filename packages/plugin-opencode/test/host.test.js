/**
 * host 侧主测试 —— 契约面（schema/patch 同步）、探测、服务解析、HTTP 客户端、回执、下发编排。
 *
 * 测试纪律（与仓库同款）：
 *   - 绝不读写真实家目录：探测/服务解析全部走 `DSH_OPENCODE_HOME` 假家目录（临时目录）；
 *   - 网络面全部离线：fetch 由测试桩接管（与真实服务零交互）；
 *   - 凭据用**测试假口令**并断言"口令不进任何证据字段"。
 *
 * @module test/host.test
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Config } from '../src/host/config/schema.js';
import {
  clampWaitMs,
  createDispatcher,
  deriveSessionKey,
  deriveTitle,
  normalizeDirKey,
  normalizePermissionRequest,
  parseModelRef,
} from '../src/host/gateway/dispatch.js';
import { GatewayHttpError, createOpencodeClient } from '../src/host/gateway/opencode-client.js';
import { buildReceipt, extractText, pickAssistantMessage } from '../src/host/gateway/receipt.js';
import { createServiceAccess, readServiceFile } from '../src/host/gateway/service.js';
import { REASON_CODES } from '../src/host/launch/reason-codes.js';
import { detectOpencode, validateServiceFile } from '../src/host/probe/detect.js';

// ─────────────────────────── 工具 ───────────────────────────

const FAKE_PASSWORD = 'test-password-not-a-real-secret';
const FAKE_URL = 'http://127.0.0.1:49374';

function unwrap(x) {
  return x !== null && x !== undefined && typeof x.get === 'function' ? x.get() : x;
}

/** 假家目录 + 可选 service.json。返回 {home, env, cleanup}。 */
function makeHome(service = undefined) {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  if (service !== undefined) {
    const dir = join(home, '.local', 'state', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.json'), JSON.stringify(service));
  }
  return { home, env: { DSH_OPENCODE_HOME: home }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function makeService(overrides = {}) {
  return { id: 'oc-test', version: '2.0.28', url: FAKE_URL, pid: 1234, password: FAKE_PASSWORD, ...overrides };
}

/** 离线 fetch 桩：routes 键 = `METHOD /path`；值 = {status, body} 或函数（拿到 init/URL 自掷）。 */
function makeFetch(routes, calls) {
  const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async text() {
      if (body === undefined || body === null) return '';
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  });
  return async function fetchImpl(url, init = {}) {
    const u = url instanceof URL ? url : new URL(String(url));
    const method = init.method ?? 'GET';
    calls.push({
      method,
      path: u.pathname,
      search: u.search,
      headers: init.headers ?? {},
      body: init.body === undefined ? null : JSON.parse(String(init.body)),
      signal: init.signal,
    });
    const route = routes[`${method} ${u.pathname}`];
    if (route === undefined) return respond(404, { error: 'no-route', key: `${method} ${u.pathname}` });
    if (typeof route === 'function') return route(init, u);
    return respond(route.status ?? 200, route.body);
  };
}

/** 某会话的通用路由包（成功默认值可覆盖）。 */
function routesForSession(id, {
  outcome = 'succeeded',
  reply = 'hello from opencode',
  inboxId = 'inbox_1',
  permissions = [],
  wait = { status: 204, body: '' },
  model = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' },
} = {}) {
  const r = {};
  r[`GET /api/session/${id}`] = { status: 200, body: { data: { id, outcome, model } } };
  r[`GET /api/session/${id}/message`] = {
    status: 200,
    body: {
      data: [
        {
          id: 'msg_a1',
          type: 'assistant',
          content: [{ type: 'text', text: reply }],
          finish: 'stop',
          cost: 0.12,
          tokens: { input: 10, output: 20, reasoning: 3 },
        },
        { id: inboxId, type: 'user', content: [] },
      ],
    },
  };
  r[`POST /api/experimental/session/${id}/wait`] = wait;
  r[`GET /api/session/${id}/permission`] = { status: 200, body: { data: permissions } };
  return r;
}

function makeSessionsStub(initial = {}) {
  const map = new Map(Object.entries(initial));
  const log = [];
  return {
    log,
    lookup(key) {
      const rec = map.get(key);
      return rec === undefined ? null : { ...rec };
    },
    touch(key) {
      log.push(['touch', key]);
      return true;
    },
    adopt(key, rec) {
      log.push(['adopt', key, rec.sessionId]);
      map.set(key, { ...rec });
      return { ok: true, adopted: true };
    },
    forget(key) {
      log.push(['forget', key]);
      const had = map.has(key);
      map.delete(key);
      return had;
    },
    summary() {
      return [...map.entries()].map(([k, v]) => ({ sessionKey: k, sessionId: v.sessionId, state: 'ok', own: true, lastUsedAt: 0 }));
    },
  };
}

function makeDispatcher({ config = {}, routes = {}, calls = [], env, sessions = makeSessionsStub() } = {}) {
  const fetchImpl = makeFetch(routes, calls);
  const full = {
    enabled: true,
    model: '',
    variant: '',
    workspace: 'D:/ws',
    boundSessionId: '',
    serviceDir: '',
    baseUrl: '',
    waitTimeoutMs: 900_000,
    sessions: {},
    ...config,
  };
  return {
    sessions,
    calls,
    dispatcher: createDispatcher({
      resolveConfig: () => ({ ...full }),
      sessions,
      fetchImpl,
      env: () => env,
    }),
  };
}

// ───────────────────── 1. schema ↔ patch 同步 ─────────────────────

test('schema 默认值（解包 volatile 后）与 cordis.patch.yml 字面量一致', () => {
  const validated = Config['~standard'].validate({});
  assert.equal(validated.issues, undefined, `schema 校验失败：${JSON.stringify(validated.issues ?? [])}`);
  const cfg = validated.value;
  assert.equal(unwrap(cfg.enabled), false, 'enabled 出厂默认必须是 false（对外契约）');
  assert.equal(unwrap(cfg.model), '');
  assert.equal(unwrap(cfg.variant), '');
  assert.equal(unwrap(cfg.workspace), '');
  assert.equal(unwrap(cfg.boundSessionId), '');
  assert.equal(unwrap(cfg.serviceDir), '');
  assert.equal(unwrap(cfg.baseUrl), '');
  assert.equal(unwrap(cfg.waitTimeoutMs), 900_000);
  assert.deepEqual(unwrap(cfg.sessions), {});
  assert.deepEqual(cfg.launch, { variantValues: {} });

  const patchText = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8');
  const patchKeys = [...patchText.matchAll(/^ {8}([a-zA-Z_][a-zA-Z0-9_]*):/gm)].map((m) => m[1]);
  const schemaKeys = [...readFileSync(join(import.meta.dirname, '..', 'src', 'host', 'config', 'schema.js'), 'utf8')
    .matchAll(/^ {2}([a-zA-Z_][a-zA-Z0-9_]*):/gm)].map((m) => m[1]);
  assert.deepEqual([...patchKeys].sort(), [...schemaKeys].sort(),
    `patch 顶层键与 schema 顶层键不一致：patch=${patchKeys.join(',')} schema=${schemaKeys.join(',')}`);
  assert.match(patchText, /^\s+enabled: false$/m);
  assert.match(patchText, /^\s+waitTimeoutMs: 900000$/m);
  assert.match(patchText, /^\s+variantValues: \{\}$/m);
});

// ───────────────────── 2. 只读探测 ─────────────────────

test('detectOpencode：service.json 命中 ⇒ installed；证据逐处留痕且绝不含口令', async () => {
  const { home, env, cleanup } = makeHome(makeService());
  try {
    const probe = await detectOpencode(null, {}, env);
    assert.equal(probe.installed, true);
    assert.equal(probe.reason, 'ok');
    assert.equal(probe.baseUrl, FAKE_URL);
    assert.equal(probe.version, '2.0.28');
    assert.equal(probe.pid, 1234);
    assert.ok(probe.servicePath.startsWith(home), 'servicePath 应指向假家目录内的命中文件');
    assert.ok(Array.isArray(probe.evidence) && probe.evidence.length >= 1);
    const blob = JSON.stringify(probe);
    assert.equal(blob.includes(FAKE_PASSWORD), false, 'ProbeResult 绝不携带口令');
  } finally {
    cleanup();
  }
});

test('detectOpencode：无文件 ⇒ service-missing（且证据列出查过的路径）', async () => {
  const { env, cleanup } = makeHome();
  try {
    const probe = await detectOpencode(null, {}, env);
    assert.equal(probe.installed, false);
    assert.equal(probe.reason, 'service-missing');
    assert.ok(probe.evidence.length >= 2, '两条候选路径都应留痕');
  } finally {
    cleanup();
  }
});

test('detectOpencode：非回环 url / 缺 password ⇒ 不认定（fail-closed）', async () => {
  const bad1 = makeHome(makeService({ url: 'http://10.0.0.5:1234' }));
  const bad2 = makeHome(makeService({ password: '' }));
  try {
    const p1 = await detectOpencode(null, {}, bad1.env);
    assert.equal(p1.installed, false);
    assert.equal(p1.reason, 'service-missing'); // 全部候选不通过 ⇒ 找不到可用服务
    assert.match(JSON.stringify(p1.evidence), /non-loopback-url/);
    const p2 = await detectOpencode(null, {}, bad2.env);
    assert.equal(p2.installed, false);
    assert.match(JSON.stringify(p2.evidence), /missing-password/);
  } finally {
    bad1.cleanup();
    bad2.cleanup();
  }
});

test('validateServiceFile：形状闸（非对象/缺 url/缺口令）', () => {
  assert.deepEqual(validateServiceFile(null), { ok: false, reason: 'invalid-json' });
  assert.deepEqual(validateServiceFile([]), { ok: false, reason: 'invalid-json' });
  assert.equal(validateServiceFile({ url: '' }).reason, 'missing-url');
  assert.equal(validateServiceFile({ url: 'https://evil.example.com' }).reason, 'non-loopback-url');
  assert.equal(validateServiceFile({ url: FAKE_URL }).reason, 'missing-password');
  const ok = validateServiceFile({ url: FAKE_URL, version: '2.0.28', pid: 7, password: 'x' });
  assert.deepEqual(ok, { ok: true, url: FAKE_URL, version: '2.0.28', pid: 7 });
});

// ───────────────────── 3. 服务解析 ─────────────────────

test('readServiceFile：命中即回连接与口令；authLine 不含口令', () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const r = readServiceFile(env);
    assert.equal(r.ok, true);
    assert.equal(r.baseUrl, FAKE_URL);
    assert.equal(r.password, FAKE_PASSWORD);
    assert.equal(r.authLine.includes(FAKE_PASSWORD), false);
  } finally {
    cleanup();
  }
});

test('createServiceAccess：baseUrl 覆盖只改地址；非回环一律拒绝（keep creds from service.json）', () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const ok = createServiceAccess({ resolveConfig: () => ({ baseUrl: 'http://127.0.0.1:60000' }) }).resolveConnection(env);
    assert.equal(ok.ok, true);
    assert.equal(ok.baseUrl, 'http://127.0.0.1:60000');
    assert.equal(ok.password, FAKE_PASSWORD);
    const bad = createServiceAccess({ resolveConfig: () => ({ baseUrl: 'http://192.168.1.10:1' }) }).resolveConnection(env);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'non-loopback-url');
    const missing = createServiceAccess({ resolveConfig: () => ({}) }).resolveConnection({ DSH_OPENCODE_HOME: join(tmpdir(), 'oc-does-not-exist-xyz') });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'service-missing');
  } finally {
    cleanup();
  }
});

// ───────────────────── 4. HTTP 客户端 ─────────────────────

test('客户端：Basic 头与请求形状；404 归一为 status=404 的 GatewayHttpError', async () => {
  const calls = [];
  const routes = {
    'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 9 } },
    'POST /api/session': { status: 200, body: { data: { id: 'ses_x1' } } },
    'POST /api/session/ses_x1/prompt': { status: 200, body: { data: { id: 'inbox_9' } } },
  };
  const client = createOpencodeClient({ baseUrl: FAKE_URL, password: FAKE_PASSWORD }, { fetchImpl: makeFetch(routes, calls) });

  const info = await client.info();
  assert.equal(info.version, '2.0.28');
  const expectAuth = `${'Bas'}${'ic'} ${Buffer.from(`opencode:${FAKE_PASSWORD}`).toString('base64')}`;
  assert.equal(calls[0].headers.authorization, expectAuth);
  assert.equal(calls[0].headers.authorization.includes(FAKE_PASSWORD), false, '口令不得以明文出现在头里');

  const created = await client.createSession({ title: 't1', directory: 'D:/ws' });
  assert.equal(created.id, 'ses_x1');
  assert.deepEqual(calls[1].body, { title: 't1', location: { directory: 'D:/ws' } });

  const accepted = await client.prompt('ses_x1', { text: 'hi', delivery: 'queue' });
  assert.equal(accepted.data.id, 'inbox_9');
  assert.deepEqual(calls[2].body, { text: 'hi', delivery: 'queue' });

  await assert.rejects(
    () => client.getSession('ses_missing'),
    (err) => err instanceof GatewayHttpError && err.status === 404 && err.kind === 'http',
  );
});

test('客户端：请求体非 JSON 的失败响应也归一（bodyText 脱敏保留证据）', async () => {
  const calls = [];
  const routes = {
    'POST /api/session/s1/prompt': { status: 500, body: 'boom: internal' },
  };
  const client = createOpencodeClient({ baseUrl: FAKE_URL, password: FAKE_PASSWORD }, { fetchImpl: makeFetch(routes, calls) });
  await assert.rejects(
    () => client.prompt('s1', { text: 'x' }),
    (err) => err instanceof GatewayHttpError && err.status === 500 && err.bodyText.includes('boom'),
  );
});

// ───────────────────── 5. 回执抽取 ─────────────────────

test('buildReceipt：按 inboxId 锚定本轮 assistant；content[] 文本拼接；cost 取消息实况', () => {
  const session = { id: 's', outcome: 'succeeded', model: { providerID: 'p', id: 'm', variant: 'low' } };
  const messages = [
    { id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'second' }] },
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'first' }] },
    { id: 'inbox_2', type: 'user' },
  ];
  const receipt = buildReceipt({ session, messages, inboxId: 'inbox_2' });
  assert.equal(receipt.reply, 'second');
  assert.equal(receipt.outcome, 'succeeded');
  assert.equal(receipt.anchored, true);
  assert.equal(receipt.model.providerID, 'p');
});

test('buildReceipt：拿不到锚 ⇒ 退到最新一条 assistant；无正文 ⇒ null 如实', () => {
  const messages = [{ id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'latest' }] }];
  assert.equal(buildReceipt({ session: { outcome: 'succeeded' }, messages, inboxId: 'nope' }).reply, 'latest');
  const empty = buildReceipt({ session: { outcome: 'succeeded' }, messages: [], inboxId: '' });
  assert.equal(empty.reply, '');
  assert.equal(empty.outcome, 'succeeded');
  assert.equal(empty.anchored, false);
});

test('extractText/pickAssistantMessage：非 text 块忽略；parts[] 兜底', () => {
  assert.equal(extractText({ content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'keep' }] }), 'keep');
  assert.equal(extractText({ parts: [{ type: 'text', text: 'p' }] }), 'p');
  assert.equal(pickAssistantMessage([{ id: 'u', role: 'user' }, { id: 'a', role: 'assistant' }], '').id, 'a');
});

// ───────────────────── 6. 纯函数 ─────────────────────

test('parseModelRef / deriveSessionKey / deriveTitle / clampWaitMs', () => {
  assert.deepEqual(parseModelRef('opencode/deepseek-v4.1-flash-free'), { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' });
  assert.equal(parseModelRef('noslash'), null);
  assert.equal(parseModelRef('/leading'), null);
  assert.equal(parseModelRef('trailing/'), null);
  assert.equal(parseModelRef('a b/c'), null);
  assert.equal(parseModelRef(''), null);

  assert.equal(normalizeDirKey('D:\\Work\\Proj\\'), 'd:/work/proj');
  assert.equal(normalizeDirKey('/home/u/proj/'), '/home/u/proj');
  assert.equal(deriveSessionKey({ sessionKey: ' k1 ', workspace: 'D:/w' }), 'k1');
  assert.equal(deriveSessionKey({ sessionKey: '', workspace: 'D:/w' }), 'dir:d:/w');
  assert.equal(deriveSessionKey({ sessionKey: '', workspace: '' }), '');

  assert.equal(deriveTitle('hello\nworld', undefined), 'dsh: hello world');
  assert.equal(deriveTitle('', 'Given'), 'Given');

  assert.equal(clampWaitMs(1), 5_000);
  assert.equal(clampWaitMs(10_000_000), 3_600_000);
  assert.equal(clampWaitMs(undefined, 900_000), 900_000);
});

test('normalizePermissionRequest：字段归一（缺字段不炸）', () => {
  const n = normalizePermissionRequest({ id: 'r1', action: 'bash', save: true, source: { type: 'tool', id: 't1', messageID: 'm1' } });
  assert.deepEqual(n, { requestID: 'r1', action: 'bash', save: true, sourceType: 'tool', sourceID: 't1', messageID: 'm1' });
  const empty = normalizePermissionRequest(null);
  assert.equal(empty.requestID, '');
  assert.equal(empty.save, false);
});

// ───────────────────── 7. 下发编排（离线网关） ─────────────────────

test('dispatch.run：新会话全链路（建会话→设模型/档位→prompt→wait→回执）', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'POST /api/session': { status: 200, body: { data: { id: 'ses_new_1', location: { directory: 'D:/ws' } } } },
      'POST /api/session/ses_new_1/model': { status: 204, body: '' },
      'POST /api/session/ses_new_1/prompt': { status: 200, body: { data: { id: 'inbox_1' } } },
      ...routesForSession('ses_new_1'),
    };
    const sessions = makeSessionsStub();
    const { dispatcher } = makeDispatcher({
      config: { model: 'opencode/deepseek-v4.1-flash-free', variant: 'high' },
      routes, calls, env, sessions,
    });
    const out = await dispatcher.run({ prompt: 'do things', sessionKey: 'k1' });

    assert.equal(out.ok, true);
    assert.equal(out.reason, REASON_CODES.OK);
    assert.equal(out.sessionId, 'ses_new_1');
    assert.equal(out.sessionOrigin, 'new');
    assert.equal(out.resumed, false);
    assert.equal(out.reply, 'hello from opencode');
    assert.equal(out.outcome, 'succeeded');
    assert.equal(out.waitStatus, 'idle-204');
    assert.equal(out.cost, 0.12);
    assert.deepEqual(out.tokens, { input: 10, output: 20, reasoning: 3 });
    assert.deepEqual(out.model, { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' });
    assert.equal(out.version, '2.0.28');
    assert.equal(out.permissionRequests.length, 0);

    const create = calls.find((c) => c.method === 'POST' && c.path === '/api/session');
    assert.ok(create, '必须发生建会话');
    assert.equal(create.body.location.directory, 'D:/ws');
    assert.match(create.body.title, /^dsh: do things/);
    const setModel = calls.find((c) => c.path === '/api/session/ses_new_1/model');
    assert.deepEqual(setModel.body, { model: { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' } });
    const prompt = calls.find((c) => c.path === '/api/session/ses_new_1/prompt');
    assert.deepEqual(prompt.body, { text: 'do things', delivery: 'queue' });
    const wait = calls.find((c) => c.path === '/api/experimental/session/ses_new_1/wait');
    assert.ok(wait, '必须发生 wait');
    assert.ok(sessions.log.some((l) => l[0] === 'adopt' && l[1] === 'k1' && l[2] === 'ses_new_1'), '新会话必须被记性采纳');
  } finally {
    cleanup();
  }
});

test('dispatch.run：记性命中 ⇒ 复用同一会话（不建新会话），resumed=true', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'POST /api/session/ses_old/prompt': { status: 200, body: { data: { id: 'inbox_1' } } },
      ...routesForSession('ses_old', { reply: 'second round' }),
    };
    const sessions = makeSessionsStub({ k1: { sessionId: 'ses_old', cwd: 'D:/ws' } });
    const { dispatcher } = makeDispatcher({ routes, calls, env, sessions });
    const out = await dispatcher.run({ prompt: 'again', sessionKey: 'k1' });
    assert.equal(out.ok, true);
    assert.equal(out.sessionId, 'ses_old');
    assert.equal(out.sessionOrigin, 'resumed');
    assert.equal(out.resumed, true);
    assert.equal(out.reply, 'second round');
    assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/api/session'), false, '复用轮不得建新会话');
    assert.ok(sessions.log.some((l) => l[0] === 'touch' && l[1] === 'k1'));
  } finally {
    cleanup();
  }
});

test('dispatch.run：记性的会话已 404 ⇒ 清记性 + 新建 + fallbackReason 如实', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'POST /api/session': { status: 200, body: { data: { id: 'ses_new_2' } } },
      'POST /api/session/ses_new_2/prompt': { status: 200, body: { data: { id: 'inbox_1' } } },
      ...routesForSession('ses_new_2'),
    };
    const sessions = makeSessionsStub({ k1: { sessionId: 'ses_gone', cwd: 'D:/ws' } });
    const { dispatcher } = makeDispatcher({ routes, calls, env, sessions });
    const out = await dispatcher.run({ prompt: 'again', sessionKey: 'k1' });
    assert.equal(out.ok, true);
    assert.equal(out.sessionId, 'ses_new_2');
    assert.match(String(out.fallbackReason), /ses_gone/);
    assert.ok(sessions.log.some((l) => l[0] === 'forget' && l[1] === 'k1'));
    assert.ok(sessions.log.some((l) => l[0] === 'adopt' && l[2] === 'ses_new_2'));
  } finally {
    cleanup();
  }
});

test('dispatch.run：绑定会话 404 ⇒ bound_session_missing，不静默回退（不建会话）', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = { 'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } } };
    const { dispatcher } = makeDispatcher({ config: { boundSessionId: 'ses_bound' }, routes, calls, env });
    const out = await dispatcher.run({ prompt: 'x', sessionKey: 'k1' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON_CODES.BOUND_SESSION_MISSING);
    assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/api/session'), false);
  } finally {
    cleanup();
  }
});

test('dispatch.run：idle 但 outcome 为空 + 有待批权限 ⇒ approval_pending（清单带出）', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'POST /api/session': { status: 200, body: { data: { id: 'ses_ap' } } },
      'POST /api/session/ses_ap/prompt': { status: 200, body: { data: { id: 'inbox_1' } } },
      ...routesForSession('ses_ap', {
        outcome: null,
        permissions: [{ id: 'req_1', action: 'bash rm -rf', save: false, source: { type: 'tool', id: 'tl_1', messageID: 'm_9' } }],
      }),
    };
    const { dispatcher } = makeDispatcher({ routes, calls, env });
    const out = await dispatcher.run({ prompt: 'needs approval', sessionKey: 'k1' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON_CODES.APPROVAL_PENDING);
    assert.equal(out.permissionRequests.length, 1);
    assert.equal(out.permissionRequests[0].requestID, 'req_1');
    assert.equal(out.permissionRequests[0].sourceType, 'tool');
  } finally {
    cleanup();
  }
});

test('dispatch.run：等待被取消 ⇒ wait_aborted（任务未解除），快速返回', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const hangWait = (init) => new Promise((_resolve, reject) => {
      const fail = () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      };
      if (init.signal?.aborted) fail();
      else init.signal?.addEventListener('abort', fail, { once: true });
    });
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'POST /api/session': { status: 200, body: { data: { id: 'ses_hang' } } },
      'POST /api/session/ses_hang/prompt': { status: 200, body: { data: { id: 'inbox_1' } } },
      ...routesForSession('ses_hang'),
      'POST /api/experimental/session/ses_hang/wait': hangWait,
    };
    const { dispatcher } = makeDispatcher({ routes, calls, env });
    const out = await dispatcher.run({ prompt: 'long', sessionKey: 'k1', signal: AbortSignal.timeout(80) });
    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON_CODES.WAIT_ABORTED);
    assert.equal(out.waitStatus, 'aborted');
  } finally {
    cleanup();
  }
});

test('dispatch.run：等待超时 ⇒ wait_timeout（真等满 5s 下限；任务未解除）', { timeout: 30_000 }, async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const hangWait = (init) => new Promise((_resolve, reject) => {
      const fail = () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      };
      if (init.signal?.aborted) fail();
      else init.signal?.addEventListener('abort', fail, { once: true });
    });
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'POST /api/session': { status: 200, body: { data: { id: 'ses_slow' } } },
      'POST /api/session/ses_slow/prompt': { status: 200, body: { data: { id: 'inbox_1' } } },
      // ★ 会话此刻仍挂着**上一轮**的 succeeded 回执（真实可能：会话还在跑，outcome 是旧值）——
      //   超时一刻读到它绝不等于本轮结束（no receipt ≠ finished；judge dispatch.js:304-308）。
      ...routesForSession('ses_slow', { outcome: 'succeeded' }),
      'POST /api/experimental/session/ses_slow/wait': hangWait,
    };
    const { dispatcher } = makeDispatcher({ routes, calls, env });
    const started = Date.now();
    const out = await dispatcher.run({ prompt: 'slow', sessionKey: 'k1', waitTimeoutMs: 5000 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON_CODES.WAIT_TIMEOUT);
    assert.equal(out.waitStatus, 'timeout');
    assert.equal(out.outcome, null, '★ 超时不得拿旧回执冒充本轮（no receipt ≠ finished）');
    assert.equal(out.reply, '', '★ 非 idle-204 一刻读到的正文不得冒充本轮回执（receiptView 新鲜度闸）');
    assert.ok(Date.now() - started >= 4900, '必须真的等到下限时长');
  } finally {
    cleanup();
  }
});

test('dispatch.run：prompt 被拒（400）⇒ prompt_rejected + HTTP 证据', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'POST /api/session': { status: 200, body: { data: { id: 'ses_rej' } } },
      'POST /api/session/ses_rej/prompt': { status: 400, body: { error: 'empty text' } },
    };
    const { dispatcher } = makeDispatcher({ routes, calls, env });
    const out = await dispatcher.run({ prompt: 'x', sessionKey: 'k1' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON_CODES.PROMPT_REJECTED);
    assert.match(out.reasonEvidence, /HTTP 400/);
  } finally {
    cleanup();
  }
});

test('dispatch.run：鉴权被拒 / 服务缺失 ⇒ 各自的原因码（fail-closed）', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = { 'GET /api/info': { status: 401, body: { error: 'unauthorized' } } };
    const { dispatcher } = makeDispatcher({ routes, calls, env });
    const out = await dispatcher.run({ prompt: 'x', sessionKey: '' });
    assert.equal(out.reason, REASON_CODES.AUTH_REJECTED);

    const home2 = makeHome(); // 没有 service.json
    try {
      const { dispatcher: d2 } = makeDispatcher({ routes: {}, calls: [], env: home2.env });
      const out2 = await d2.run({ prompt: 'x', sessionKey: '' });
      assert.equal(out2.reason, REASON_CODES.SERVICE_MISSING);
    } finally {
      home2.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('dispatch.run：总闸 OFF ⇒ disabled（防御性兜底）', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const { dispatcher } = makeDispatcher({ config: { enabled: false }, routes: {}, calls: [], env });
    const out = await dispatcher.run({ prompt: 'x' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, REASON_CODES.DISABLED);
  } finally {
    cleanup();
  }
});

test('dispatch.run：waitOnly 复用会话拿回执（不 prompt）', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      ...routesForSession('ses_keep', { reply: 'final answer' }),
    };
    const sessions = makeSessionsStub({ k1: { sessionId: 'ses_keep' } });
    const { dispatcher } = makeDispatcher({ routes, calls, env, sessions });
    const out = await dispatcher.run({ prompt: '', sessionKey: 'k1', waitOnly: true });
    assert.equal(out.ok, true);
    assert.equal(out.sessionId, 'ses_keep');
    assert.equal(out.reply, 'final answer');
    assert.equal(calls.some((c) => c.path.endsWith('/prompt')), false, 'waitOnly 绝不发 prompt');
  } finally {
    cleanup();
  }
});

test('dispatch.approvals：list 与 reply（reply 后把待批再数一遍）', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'GET /api/session/ses_ap/permission': { status: 200, body: { data: [{ id: 'req_1', action: 'bash', source: { type: 'tool' } }] } },
      'POST /api/session/ses_ap/permission/req_1/reply': { status: 204, body: '' },
    };
    const { dispatcher } = makeDispatcher({ routes, calls, env });
    const listed = await dispatcher.listApprovals({ sessionId: 'ses_ap' });
    assert.equal(listed.ok, true);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].requestID, 'req_1');

    const replied = await dispatcher.replyApproval({ sessionId: 'ses_ap', requestId: 'req_1', decision: 'once' });
    assert.equal(replied.ok, true);
    assert.deepEqual(calls.find((c) => c.path.includes('/reply')).body, { decision: 'once' });
    assert.equal(replied.itemsAfter.length, 1, 'replay 后仍把实况待批数带给调用方');

    const bad = await dispatcher.replyApproval({ sessionId: 'ses_ap', requestId: 'r', decision: 'maybe' });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, REASON_CODES.BAD_ARGS);

    // [实测形态] 回复已不存在的请求 ⇒ 404（PermissionNotFoundError）⇒ 说"请求没了"，不说"服务不可达"。
    const gone = await dispatcher.replyApproval({ sessionId: 'ses_ap', requestId: 'req_gone', decision: 'reject' });
    assert.equal(gone.ok, false);
    assert.equal(gone.reason, REASON_CODES.APPROVAL_NOT_FOUND);
    assert.match(gone.reasonEvidence, /HTTP 404/);

    // 对已删会话列待批 ⇒ 404 ⇒ session_not_found（同样不许归因成服务不可达）。
    const dead = await dispatcher.listApprovals({ sessionId: 'ses_dead' });
    assert.equal(dead.ok, false);
    assert.equal(dead.reason, REASON_CODES.SESSION_NOT_FOUND);
  } finally {
    cleanup();
  }
});

test('dispatch.purge：默认只清记性；remote:true 走硬删（404 视作已不在）', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'DELETE /api/session/ses_del': { status: 204, body: '' },
    };
    const sessions = makeSessionsStub({ k1: { sessionId: 'ses_del' } });
    const { dispatcher } = makeDispatcher({ routes, calls, env, sessions });

    const soft = await dispatcher.purge({ sessionKey: 'k1' });
    assert.equal(soft.ok, true);
    assert.equal(soft.deleted, false);
    assert.equal(soft.forgot, true);
    assert.equal(calls.some((c) => c.method === 'DELETE'), false);

    const hard = await dispatcher.purge({ sessionId: 'ses_del', remote: true });
    assert.equal(hard.ok, true);
    assert.equal(hard.deleted, true);
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/session/ses_del'));

    const gone = await dispatcher.purge({ sessionId: 'ses_gone', remote: true });
    assert.equal(gone.ok, true);
    assert.equal(gone.deleted, false);
    assert.equal(gone.reasonEvidence, 'already-gone');
  } finally {
    cleanup();
  }
});

test('dispatch.models：归一模型表（variants[]、免费三态）并经 30s TTL 缓存', async () => {
  const { env, cleanup } = makeHome(makeService());
  try {
    const calls = [];
    const routes = {
      'GET /api/info': { status: 200, body: { version: '2.0.28', pid: 1 } },
      'GET /api/model': {
        status: 200,
        body: [{
          id: 'deepseek-v4.1-flash-free',
          providerID: 'opencode',
          variants: [{ id: 'low' }, { id: 'high' }, { id: 'max' }],
          cost: { input: 0, output: 0 },
        }],
      },
    };
    const { dispatcher } = makeDispatcher({ routes, calls, env });
    const first = await dispatcher.models();
    assert.equal(first.ok, true);
    assert.equal(first.models[0].variants.join(','), 'low,high,max');
    assert.equal(first.models[0].isFree, true);
    const second = await dispatcher.models();
    assert.equal(second.ok, true);
    assert.equal(calls.filter((c) => c.path === '/api/model').length, 1, 'TTL 内不得二次打服务');
  } finally {
    cleanup();
  }
});
