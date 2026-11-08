/**
 * T8a · 计划任务删除路由（`POST /plugin-workbuddy/tasks/delete`）。
 *
 * 覆盖（与任务书逐条对应；契约已与客户端约定死）：
 *  ① 200：body 里的 id 是活行 ⇒ **只软删那一条**，返回 `{ ok:true, id, retired:true }`，
 *     其它活行分毫不动、行数不变（绝不 INSERT / 绝不批量）；
 *  ② 404：id 不存在 / 已软删 ⇒ `{ ok:false, error:'NOT_FOUND', id }`（已软删行不被二次改写）；
 *  ③ 400：非 JSON / 缺 id / id 非字符串 / 空串 / body 超 200 字节 ⇒ `{ ok:false, error:'BAD_REQUEST' }`；
 *  ④ 403：非 loopback / Host 不可信 ⇒ fail-closed，**连库都不碰**；
 *  ⑤ 405：非 POST ⇒ Allow: POST；
 *  ⑥ 库文件不存在 ⇒ 404，且**不得**为一次删除创建空库；
 *  ⑦ `routes/index.js` 挂载：`kind:'exact'` + 约定路径（makeRoutes 签名不变）。
 *
 * ★ 本文件只碰 `mkdtemp` 夹具库；`--import test-home-guard.mjs` 是套件级兜底（结构上写不到真库）。
 *
 * @module test/task-delete-route.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';

import { makeTasksDeleteRoute, ROUTE_TASKS_DELETE, TASK_DELETE_BODY_LIMIT_BYTES } from '../src/host/routes/tasks/delete.js';
import { makeRoutes } from '../src/host/routes/index.js';

/** 一次性夹具家目录 + WORKBUDDY_HOME 指向它（结束还原并清理）。 */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'wb-task-delete-'));
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

/** 造最小 `automations` 夹具（`retireRow` 只读写 id / deleted_at / updated_at）。 */
function seedDb(home, rows) {
  const db = new DatabaseSync(join(home, 'workbuddy.db'));
  try {
    db.exec(`CREATE TABLE automations (
      id TEXT PRIMARY KEY,
      name TEXT,
      next_run_at INTEGER,
      valid_until TEXT,
      deleted_at INTEGER,
      updated_at INTEGER)`);
    const insert = db.prepare(
      'INSERT INTO automations (id, name, next_run_at, valid_until, deleted_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)',
    );
    for (const row of rows) insert.run(row.id, row.id, row.deletedAt ?? null, row.updatedAt ?? 1000);
  } finally {
    db.close();
  }
}

/** 读回全表（断言用；只读连接，不制造写。 */
function readRows(home) {
  const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
  try {
    return db.prepare('SELECT id, deleted_at, updated_at FROM automations ORDER BY id').all()
      .map((r) => ({ id: String(r.id), deletedAt: r.deleted_at, updatedAt: r.updated_at }));
  } finally {
    db.close();
  }
}

/** 造请求：真实 async-iterable（路由按流读 body）+ 指定 method / socket / Host。 */
function makeReq({ method = 'POST', remoteAddress = '127.0.0.1', host = '127.0.0.1:58088', body, rawBody } = {}) {
  const payload = rawBody !== undefined ? rawBody : (body === undefined ? '' : JSON.stringify(body));
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload, 'utf8')]);
  req.method = method;
  req.headers = host === null ? {} : { host };
  if (remoteAddress !== null) req.socket = { remoteAddress };
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.body = b ?? ''; },
  };
}

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    json: res.body === '' ? null : JSON.parse(res.body),
  };
}

const route = makeTasksDeleteRoute();

test('契约常量：路径 = /plugin-workbuddy/tasks/delete；body 上限 200 字节', () => {
  assert.equal(ROUTE_TASKS_DELETE, '/plugin-workbuddy/tasks/delete');
  assert.equal(TASK_DELETE_BODY_LIMIT_BYTES, 200);
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, ROUTE_TASKS_DELETE);
});

test('① 200：只软删 body 里那一条活行；其它活行/已删行分毫不动，行数不变', async () => {
  await withHome(async (home) => {
    seedDb(home, [
      { id: 'auto-target', updatedAt: 1000 },
      { id: 'auto-other', updatedAt: 1000 },
      { id: 'auto-gone', deletedAt: 900, updatedAt: 900 },
    ]);

    const out = await call(route, makeReq({ body: { id: 'auto-target' } }));
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.json, { ok: true, id: 'auto-target', retired: true });
    assert.equal(out.headers['content-type'], 'application/json; charset=utf-8');

    const rows = readRows(home);
    assert.equal(rows.length, 3, '★ 绝不 INSERT、绝不删行（软删只改列）');
    const target = rows.find((r) => r.id === 'auto-target');
    assert.notEqual(target.deletedAt, null, '目标行 deleted_at 置位');
    assert.notEqual(target.updatedAt, 1000, 'updated_at 同步刷新');
    assert.equal(rows.find((r) => r.id === 'auto-other').deletedAt, null, '★ 其它活行分毫不动');
    assert.equal(rows.find((r) => r.id === 'auto-other').updatedAt, 1000, '★ 其它行连 updated_at 都不动');
    assert.equal(rows.find((r) => r.id === 'auto-gone').deletedAt, 900, '已删行保持原值');
    assert.equal(rows.find((r) => r.id === 'auto-gone').updatedAt, 900);
  });
});

test('② 404：id 不存在 / 已软删（已删行不得被二次改写）', async () => {
  await withHome(async (home) => {
    seedDb(home, [
      { id: 'auto-live', updatedAt: 1000 },
      { id: 'auto-gone', deletedAt: 900, updatedAt: 900 },
    ]);

    const missing = await call(route, makeReq({ body: { id: 'auto-ghost' } }));
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json, { ok: false, error: 'NOT_FOUND', id: 'auto-ghost' });

    const deleted = await call(route, makeReq({ body: { id: 'auto-gone' } }));
    assert.equal(deleted.statusCode, 404);
    assert.deepEqual(deleted.json, { ok: false, error: 'NOT_FOUND', id: 'auto-gone' });

    const rows = readRows(home);
    assert.equal(rows.find((r) => r.id === 'auto-live').deletedAt, null, '404 分支不得误删活行');
    assert.equal(rows.find((r) => r.id === 'auto-gone').deletedAt, 900, '已删行的 deleted_at 不得被改写');
    assert.equal(rows.find((r) => r.id === 'auto-gone').updatedAt, 900, '已删行的 updated_at 不得被改写');
  });
});

test('③ 400：非法 body（非 JSON / 缺 id / id 非字符串 / 空串 / 超长）', async () => {
  await withHome(async (home) => {
    seedDb(home, [{ id: 'auto-live', updatedAt: 1000 }]);

    const cases = [
      { name: 'not-json', req: makeReq({ rawBody: 'not json{' }) },
      { name: 'empty-body', req: makeReq({ rawBody: '' }) },
      { name: 'json-null', req: makeReq({ rawBody: 'null' }) },
      { name: 'json-array', req: makeReq({ rawBody: '["auto-live"]' }) },
      { name: 'missing-id', req: makeReq({ body: {} }) },
      { name: 'id-number', req: makeReq({ body: { id: 123 } }) },
      { name: 'id-empty', req: makeReq({ body: { id: '   ' } }) },
      // 超 200 字节：合法的 JSON 形状也不收（契约把"太长"归到 400）。
      { name: 'too-long', req: makeReq({ body: { id: 'x'.repeat(300) } }) },
    ];
    for (const c of cases) {
      const out = await call(route, c.req);
      assert.equal(out.statusCode, 400, `${c.name}: 应回 400`);
      assert.deepEqual(out.json, { ok: false, error: 'BAD_REQUEST' }, `${c.name}: 载荷形状`);
    }
    assert.equal(readRows(home).find((r) => r.id === 'auto-live').deletedAt, null, '400 分支不得碰库');
  });
});

test('④ 403：非 loopback / Host 不可信 ⇒ fail-closed，且不碰库', async () => {
  await withHome(async (home) => {
    seedDb(home, [{ id: 'auto-live', updatedAt: 1000 }]);

    const remote = await call(route, makeReq({ remoteAddress: '192.168.1.50', body: { id: 'auto-live' } }));
    assert.equal(remote.statusCode, 403);
    assert.deepEqual(remote.json, { ok: false, error: 'FORBIDDEN' });

    const noSocket = await call(route, makeReq({ remoteAddress: null, body: { id: 'auto-live' } }));
    assert.equal(noSocket.statusCode, 403, '缺 socket 必须 fail-closed');

    // DNS-rebinding：socket 是回环，但 Host 是外部域名 ⇒ 同样拒绝。
    const rebound = await call(route, makeReq({ host: 'evil.example.com:58088', body: { id: 'auto-live' } }));
    assert.equal(rebound.statusCode, 403, '★ Host 栅栏挡 DNS-rebinding');

    assert.equal(readRows(home).find((r) => r.id === 'auto-live').deletedAt, null, '403 分支不得碰库');
  });
});

test('⑤ 405：非 POST ⇒ Allow: POST，且不碰库', async () => {
  await withHome(async (home) => {
    seedDb(home, [{ id: 'auto-live', updatedAt: 1000 }]);
    const out = await call(route, makeReq({ method: 'GET', body: { id: 'auto-live' } }));
    assert.equal(out.statusCode, 405);
    assert.equal(out.headers.allow, 'POST');
    assert.equal(out.json, null);
    assert.equal(readRows(home).find((r) => r.id === 'auto-live').deletedAt, null);
  });
});

test('⑥ 库文件不存在 ⇒ 404 NOT_FOUND，且不得为一次删除创建空库文件', async () => {
  await withHome(async (home) => {
    const dbFile = join(home, 'workbuddy.db');
    assert.equal(existsSync(dbFile), false, '前置：夹具里本来就没有库文件');
    const out = await call(route, makeReq({ body: { id: 'auto-live' } }));
    assert.equal(out.statusCode, 404);
    assert.deepEqual(out.json, { ok: false, error: 'NOT_FOUND', id: 'auto-live' });
    assert.equal(existsSync(dbFile), false, '★ 不得为一次删除凭空造出 workbuddy.db');
  });
});

test('⑦ routes/index.js 挂载：新增 exact 路由，且既有 status/diagnostics 位置不变', () => {
  const settings = { get: () => undefined };
  const runtime = {
    currentConfig: () => ({ enabled: false }),
    detected: () => null,
    registry: () => 'UNKNOWN',
    inFlight: () => [],
    lastRun: () => null,
  };
  const routes = makeRoutes(settings, runtime, 'dsh-plugin-workbuddy');
  assert.equal(routes.length, 3);
  assert.equal(routes[0].path, '/plugin-workbuddy/status', '状态路由仍在首位（UI 依赖）');
  assert.equal(routes[1].path, '/plugin-workbuddy/diagnostics', '诊断路由位次不变');
  assert.equal(routes[2].path, ROUTE_TASKS_DELETE);
  assert.equal(routes[2].kind, 'exact');
  assert.equal(typeof routes[2].handler, 'function');
});
