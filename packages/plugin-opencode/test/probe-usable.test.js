/**
 * T7 回归：OpenCode 探测必须判**可用性**，不是"service.json 在不在"。
 *
 * 背景（2026-11-08 用户报障）：后台 sidecar（bun.exe / opencode-cli.exe）会写下 service.json，
 *   GUI 没开、模型读不到时旧探测仍报 `installed:true` ⇒ 卡片"运行中"但模型为空。
 *   本套件用**本机夹具 HTTP 服务**把四种真相逐一钉死（不碰真实 `~/.local/state/opencode`，
 *   也不碰真实服务）：
 *     ① pid 活 + info 2xx + model 非空   ⇒ installed:true,  reason:'ok'
 *     ② pid 活 + info 2xx + model 空     ⇒ installed:false, reason:'models-unreadable'
 *     ③ pid 活 + info 非 2xx / 连不上 / 超时 ⇒ installed:false, reason:'service-unreachable'
 *     ④ pid 死（哪怕是别的进程在服务）    ⇒ installed:false, reason:'stale-service'（pid 闸先于 HTTP）
 *   外加两条纪律断言：**password 绝不进 evidence / 返回值**；Basic 头确实来自 service.json（不是匿名请求）。
 *
 * 纪律：
 *   - 零进程拉起（探测本身只允许 fs 只读 + 回环 GET）；夹具服务只是测试进程里的 node:http server；
 *   - 全部走 `DSH_OPENCODE_HOME` 假家目录，绝不读真实服务注册文件；
 *   - 不用真实 pid 断言"活着"（用 process.pid），死 pid 用 999999 —— Windows 的 pid 恒为 4 的倍数，
 *     这个号在本机不可能是真进程（同步在用例里说明）。
 *
 * @module test/probe-usable.test
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { availabilityText } from '../src/host/prompts/availability.js';
import { detectOpencode, isPidAlive } from '../src/host/probe/detect.js';

const FAKE_PASSWORD = 'fixture-password-never-echoed';
const FAKE_VERSION = '2.2.5';

/** 假家目录 + service.json。返回 {home, env, cleanup}。 */
function makeHome(service) {
  const home = mkdtempSync(join(tmpdir(), 'oc-usable-home-'));
  const dir = join(home, '.local', 'state', 'opencode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'service.json'), JSON.stringify(service));
  return { home, env: { DSH_OPENCODE_HOME: home }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** service.json 内容（url 由夹具服务动态给；pid 默认 = 本测试进程，保证"活着"）。 */
function makeService({ url, pid = process.pid, password = FAKE_PASSWORD } = {}) {
  return { id: 'oc-fixture', version: FAKE_VERSION, url, pid, password };
}

/**
 * 本机夹具服务：模拟 opencode 的 `/api/info` 与 `/api/model`。
 *
 * @param {{
 *   info?: {status: number, body?: any, raw?: string, hang?: boolean},
 *   model?: {status: number, body?: any, raw?: string, hang?: boolean},
 *   password?: string,
 * }} [opts]
 * @returns {Promise<{port: number, requests: Array<{path: string, auth: string}>, close: () => Promise<void>}>}
 */
function startFixture(opts = {}) {
  const info = opts.info ?? { status: 200, body: { version: FAKE_VERSION, pid: process.pid } };
  const model = opts.model ?? { status: 200, body: { location: {}, data: [{ id: 'm1', providerID: 'opencode' }] } };
  const expectedAuth = `${'Bas'}${'ic'} ${Buffer.from(`opencode:${opts.password ?? FAKE_PASSWORD}`).toString('base64')}`;
  const requests = [];

  const send = (res, spec) => {
    if (spec === null) return; // hang：接管后什么都不回（客户端须在 1s 内自己收尸）
    res.writeHead(spec.status, { 'content-type': 'application/json' });
    res.end(spec.raw !== undefined ? spec.raw : JSON.stringify(spec.body ?? null));
  };

  const server = createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization ?? '' });
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.url === '/api/info') {
      send(res, info.hang === true ? null : info);
      return;
    }
    if (req.url === '/api/model') {
      send(res, model.hang === true ? null : model);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        port,
        requests,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(done);
        }),
      });
    });
  });
}

/** 夹具 url（回环，形状闸认可）。 */
const fixtureUrl = (port) => `http://127.0.0.1:${port}`;

/** 证据逐条拼成可读文本（卡片上也是 `target · detail` 形态）。 */
function evidenceText(probe) {
  return probe.evidence.map((e) => `${e.target} · ${e.detail}`).join('\n');
}

/** 断言 ProbeResult 的序列化结果里没有口令（明文与 Basic 编码两种形态都不许出现）。 */
function assertNoCredential(probe) {
  const blob = JSON.stringify(probe);
  assert.equal(blob.includes(FAKE_PASSWORD), false, 'ProbeResult 绝不携带明文口令');
  const encoded = Buffer.from(`opencode:${FAKE_PASSWORD}`).toString('base64');
  assert.equal(blob.includes(encoded), false, 'ProbeResult 绝不携带 Basic 编码后的口令');
  assert.equal(blob.includes('authorization'), false, '探测证据里不许出现请求头');
}

// ───────────────────── ① 可用：pid 活 + info + model 都通 ─────────────────────

test('可用 1：pid 活 + /api/info 2xx + /api/model 非空 ⇒ installed:true / reason:ok', async () => {
  const fixture = await startFixture();
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port) }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, true);
    assert.equal(probe.reason, 'ok');
    assert.equal(probe.baseUrl, fixtureUrl(fixture.port));
    assert.equal(probe.version, FAKE_VERSION);
    assert.equal(probe.pid, process.pid);
    assert.equal(probe.method, 'read-only');
    assert.ok(probe.servicePath.startsWith(home.home), 'servicePath 应指向假家目录内的命中文件');

    const details = probe.evidence.map((e) => `${e.target} · ${e.detail}`).join('\n');
    assert.match(details, /pid \d+ · alive/, 'pid 存活要留痕');
    assert.match(details, /\/api\/info · ok/, '/api/info 要留痕');
    assert.match(details, /\/api\/model · ok \(http=200, models=1\)/, '模型条数要留痕');
    assert.equal(fixture.requests.length, 2, '只打 info 与 model 两个只读端点');
    assert.deepEqual(fixture.requests.map((r) => r.path), ['/api/info', '/api/model']);
    assertNoCredential(probe);
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

test('可用 2：service.json 没写 pid ⇒ 不猜死，由 HTTP 判定（可用仍报 ok）', async () => {
  const fixture = await startFixture();
  // pid: null（不是 undefined —— 那会触发默认参数 = process.pid，就测不到"没写 pid"了）。
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port), pid: null }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, true);
    assert.equal(probe.reason, 'ok');
    assert.match(evidenceText(probe), /no pid/);
    assertNoCredential(probe);
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

// ───────────────────── ② 服务在但模型读不到（用户报的那个谎） ─────────────────────

test('模型 1：/api/model 返回空 data 数组 ⇒ installed:false / reason:models-unreadable', async () => {
  const fixture = await startFixture({ model: { status: 200, body: { location: {}, data: [] } } });
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port) }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, false, '模型表为空 ⇒ 不许再报"运行中"');
    assert.equal(probe.reason, 'models-unreadable');
    assert.equal(probe.baseUrl, fixtureUrl(fixture.port), '不可用时仍保留注册地址，便于对账');
    assert.match(evidenceText(probe), /empty \(http=200, entries=0, usable=0/);
    assertNoCredential(probe);
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

test('模型 2：/api/model 裸数组为空 ⇒ models-unreadable（两种形态都认）', async () => {
  const fixture = await startFixture({ model: { status: 200, body: [] } });
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port) }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, false);
    assert.equal(probe.reason, 'models-unreadable');
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

test('模型 3：条目缺 id/providerID ⇒ 不算"读得到"（与客户端的归一过滤同源）', async () => {
  const fixture = await startFixture({ model: { status: 200, body: { data: [{ name: 'no-ids' }] } } });
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port) }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, false);
    assert.equal(probe.reason, 'models-unreadable');
    assert.match(evidenceText(probe), /entries=1, usable=0/);
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

test('模型 4：/api/model 非 2xx ⇒ models-unreadable（带端点与状态码证据）', async () => {
  const fixture = await startFixture({ model: { status: 500, body: { error: 'boom' } } });
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port) }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, false);
    assert.equal(probe.reason, 'models-unreadable');
    assert.match(evidenceText(probe), /\/api\/model · failed: http=500/);
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

// ───────────────────── ③ info 不通：不可达 / 超时 / 非 2xx / 鉴权失败 ─────────────────────

test('不通 1：/api/info 404 ⇒ installed:false / reason:service-unreachable', async () => {
  const fixture = await startFixture({ info: { status: 404, body: { error: 'no-such-endpoint' } } });
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port) }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, false);
    assert.equal(probe.reason, 'service-unreachable');
    assert.match(evidenceText(probe), /\/api\/info · failed: http=404/);
    assert.equal(fixture.requests.length, 1, 'info 已判死 ⇒ 不再打 model');
    assertNoCredential(probe);
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

test('不通 2：端口没人监听 ⇒ service-unreachable（证据带错误码 ECONNREFUSED）', async () => {
  // 先占一个端口再放掉：拿到的号几乎不可能被别的进程瞬时复用。
  const fixture = await startFixture();
  const deadPort = fixture.port;
  await fixture.close();
  const home = makeHome(makeService({ url: fixtureUrl(deadPort) }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, false);
    assert.equal(probe.reason, 'service-unreachable');
    assert.match(evidenceText(probe), /\/api\/info · failed: unreachable \(E[A-Z]+\)/);
    assertNoCredential(probe);
  } finally {
    home.cleanup();
  }
});

test('不通 3：/api/info 挂住不回 ⇒ 1s 后收敛 service-unreachable（有界，不挂死）', async () => {
  const fixture = await startFixture({ info: { status: 200, body: {}, hang: true } });
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port) }));
  try {
    const startedAt = Date.now();
    const probe = await detectOpencode(null, {}, home.env);
    const elapsed = Date.now() - startedAt;
    assert.equal(probe.installed, false);
    assert.equal(probe.reason, 'service-unreachable');
    assert.match(evidenceText(probe), /timeout after 1000ms \(ETIMEDOUT\)/);
    assert.ok(elapsed < 3000, `探测必须在 1s 量级收口，实测 ${elapsed}ms`);
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

test('不通 4：Basic 头真的来自 service.json（口令不对 ⇒ 401 ⇒ service-unreachable）', async () => {
  const fixture = await startFixture({ password: FAKE_PASSWORD });
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port), password: 'wrong-password' }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, false);
    assert.equal(probe.reason, 'service-unreachable');
    assert.match(evidenceText(probe), /http=401/);
    assert.equal(fixture.requests[0].auth.startsWith('Basic '), true, '探测必须带 Basic 鉴权，不是匿名请求');
    assertNoCredential(probe);
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

// ───────────────────── ④ pid 已死：首选理由必须是 stale-service ─────────────────────

test('stale 1：pid 已死（999999）⇒ stale-service，且不再打任何 HTTP（pid 闸在前）', async () => {
  // Windows 的 pid 恒为 4 的倍数，999999 在本机不可能是真进程（Linux 上同步成立的概率也极低）。
  // 先自证这台机器当前确实认为它不存在：否则本用例会退化成"端口连不上"，断言会立刻红。
  assert.equal(isPidAlive(999999), false, '999999 必须被判死（否则本用例的前提不成立）');
  const fixture = await startFixture(); // 服务确实可用 —— 用来证明 pid 闸就是判死依据
  const home = makeHome(makeService({ url: fixtureUrl(fixture.port), pid: 999999 }));
  try {
    const probe = await detectOpencode(null, {}, home.env);
    assert.equal(probe.installed, false, '注册文件在 + 服务可用，但注册的 pid 已死 ⇒ 仍是不可用');
    assert.equal(probe.reason, 'stale-service');
    assert.match(evidenceText(probe), /dead \(process\.kill\(pid,0\) → ESRCH\)/);
    assert.equal(fixture.requests.length, 0, 'pid 已判死 ⇒ 一次 HTTP 都不该发');
    assertNoCredential(probe);
  } finally {
    await fixture.close();
    home.cleanup();
  }
});

// ───────────────────── ⑤ 可用性文案按 reason 如实区分 ─────────────────────

/** availabilityText 的最小 runtime 桩。 */
function runtimeFor(reason) {
  return {
    currentConfig: () => ({ enabled: true, model: '', variant: '' }),
    probeState: () => ({ status: 'done', result: { installed: false, reason }, pendingReason: '' }),
    lastRun: () => null,
  };
}

test('文案 1：stale / unreachable / models-unreadable 三句互不相同，且都不说"was NOT found"', () => {
  const stale = availabilityText(runtimeFor('stale-service'));
  const unreachable = availabilityText(runtimeFor('service-unreachable'));
  const models = availabilityText(runtimeFor('models-unreadable'));
  const all = [stale, unreachable, models];
  assert.equal(new Set(all).size, 3, '三种不可用必须三种说法（否则模型会拿错处置）');
  for (const text of all) assert.doesNotMatch(text, /was NOT found/);
  assert.match(stale, /stale-service/);
  assert.match(stale, /pid dead/);
  assert.match(unreachable, /service-unreachable/);
  assert.match(unreachable, /GET \/api\/info/);
  assert.match(models, /models-unreadable/);
  assert.match(models, /GET \/api\/model/);
  assert.match(models, /shows running yet no models/);
});

test('文案 2：service-missing 保留既有原句（旧契约逐字不动，hasTools 两支都在）', () => {
  const withTools = availabilityText(runtimeFor('service-missing'), { hasTools: true });
  const withoutTools = availabilityText(runtimeFor('service-missing'), { hasTools: false });
  assert.match(withTools, /was NOT found \(service-missing\)/);
  assert.match(withTools, /opencode_status lists which service\.json paths were checked/);
  assert.match(withoutTools, /was NOT found \(service-missing\)/);
  assert.match(withoutTools, /Do not delegate until it is available/);
});

test('文案 3：无工具面的 agent（Lead）拿到的也是同一条准确 reason + "不要派人"', () => {
  const text = availabilityText(runtimeFor('models-unreadable'), { hasTools: false });
  assert.match(text, /models-unreadable/);
  assert.match(text, /Do not delegate until it is available/);
});
