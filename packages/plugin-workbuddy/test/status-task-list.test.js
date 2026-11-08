/**
 * 桌面端**任务清单**（`launch/task-list.js`）回归测试。
 *
 * 覆盖：
 *   ① 标题：`name` → `prompt` 首行 → `(untitled)`；120 code point 截断；
 *   ② 字段与口径：status / scheduleType / 三个时间（created/updated/lastRun/nextRun/validUntil）/ active；
 *   ③ 默认只列活行（`deleted_at IS NULL`）；`includeDeleted:true` 含软删历史且 `active:false`；
 *   ④ 排序 `created_at DESC`；limit 默认 50 / 上限钳制 / `truncated` 只回答"还有没有更多"；
 *   ⑤ 失败纪律：库缺失 ⇒ `ok:false + reason`；**真·空表 ⇒ `ok:true + []`**（读不到 ≠ 没有任务）；
 *      表缺失 / 旧 schema 缺列 ⇒ `ok:false` 且逐列点名；
 *   ⑥ 只读纪律：库文件字节不变；只读句柄上写被 SQLite 拒绝；不 close 调用方句柄；
 *   ⑦ 接线：`workbuddy_status` 的 `tasks` 段（含 `all` 切片与 output.schema 校验）+ 状态路由 `taskList`；
 *   ⑧ 无副作用：读取任务清单不发起任何网络连接 / fetch（纯 SQLite 只读）。
 *
 * 夹具纪律：只用临时 `WORKBUDDY_HOME` 下的夹具库（经 `test-home-guard`），不碰真实 `~/.workbuddy`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import { readTaskList, TASK_LIST_DEFAULT_LIMIT, TASK_LIST_MAX_LIMIT, TASK_TITLE_MAX_CHARS } from '../src/host/launch/task-list.js';
import { makeStatusRoute } from '../src/host/routes/status/get.js';
import { makeStatusTool } from '../src/host/tools/status.js';

/** 与真机 2026-11-08 实测列集一致（`automations` 表的核心列，另加两列不消费的真实列）。 */
const SCHEMA_FULL = `
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    name TEXT,
    prompt TEXT,
    status TEXT,
    schedule_type TEXT,
    next_run_at INTEGER,
    last_run_at INTEGER,
    valid_until TEXT,
    model_id TEXT,
    owner_user_id TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    deleted_at INTEGER
  );
`;

async function withFixture(fn) {
  const home = mkdtempSync(join(tmpdir(), 'wb-task-list-'));
  const prevWbHome = process.env.WORKBUDDY_HOME;
  const prevCostHome = process.env.DSH_WB_COST_HOME;
  process.env.WORKBUDDY_HOME = home;
  process.env.DSH_WB_COST_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prevWbHome === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = prevWbHome;
    if (prevCostHome === undefined) delete process.env.DSH_WB_COST_HOME;
    else process.env.DSH_WB_COST_HOME = prevCostHome;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* 退出期清理失败不覆盖结论 */ }
  }
}

/** 造真机形状的夹具库；未给字段 NULL。 */
function seedDb(home, rows, { schema = SCHEMA_FULL, filename = 'workbuddy.db' } = {}) {
  const path = join(home, filename);
  const db = new DatabaseSync(path);
  try {
    db.exec(schema);
    const stmt = db.prepare(
      'INSERT INTO automations (id, name, prompt, status, schedule_type, next_run_at, last_run_at, '
      + 'valid_until, model_id, owner_user_id, created_at, updated_at, deleted_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) {
      stmt.run(
        r.id ?? null, r.name ?? null, r.prompt ?? null, r.status ?? 'ACTIVE', r.schedule_type ?? 'once',
        r.next_run_at ?? null, r.last_run_at ?? null, r.valid_until ?? null,
        r.model_id ?? null, r.owner_user_id ?? null,
        r.created_at ?? null, r.updated_at ?? null, r.deleted_at ?? null,
      );
    }
  } finally {
    db.close();
  }
  return path;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function createMockRuntime() {
  return {
    registry: () => 'REGISTERED',
    registrationError: () => null,
    detected: () => ({ installed: false, reason: 'fixture', resolvedPath: '', method: 'no-exec', at: 0, evidence: [] }),
    currentConfig: () => ({}),
    probeState: () => ({ result: null }),
    inFlight: () => [],
    lastRun: () => null,
    probe: async () => {},
  };
}

async function callStatusRoute(runtime) {
  const route = makeStatusRoute({ get: () => undefined }, runtime, 'dsh-plugin-workbuddy', {});
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b ?? ''; },
  };
  await route.handler(
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7777' } },
    res,
  );
  return { status: res.statusCode, payload: res.body === '' ? null : JSON.parse(res.body) };
}

// ══════════════════════════════════════════════════════════════════════════
// ① 标题与字段
// ══════════════════════════════════════════════════════════════════════════

test('标题三态：name → prompt 首行 → (untitled)；字段逐个落地', async () => {
  await withFixture(async (home) => {
    seedDb(home, [
      { id: 'a1', name: 'H6 预注册检验', prompt: '全文\n第二段', status: 'ACTIVE', schedule_type: 'once', created_at: 3000, valid_until: '2026-11-01T16:07:32+08:00' },
      { id: 'a2', name: '   ', prompt: '首行标题\n第二行', status: 'DONE', schedule_type: 'cron', created_at: 2000 },
      { id: 'a3', name: '\n', prompt: '   \n   ', created_at: 1000 },
      { id: 'a4', name: null, prompt: null, created_at: 500 },
    ]);
    const res = readTaskList();
    assert.equal(res.ok, true, res.reason ?? '');
    assert.equal(res.count, 4);
    const byId = Object.fromEntries(res.tasks.map((t) => [t.id, t]));
    assert.equal(byId.a1.title, 'H6 预注册检验');
    assert.equal(byId.a2.title, '首行标题');
    assert.equal(byId.a3.title, '(untitled)', 'prompt 首行为空白 ⇒ 未命名（不把空白当标题）');
    assert.equal(byId.a4.title, '(untitled)');
    assert.equal(byId.a1.status, 'ACTIVE');
    assert.equal(byId.a1.scheduleType, 'once');
    assert.equal(byId.a1.createdAt, 3000);
    assert.equal(byId.a1.validUntil, Date.parse('2026-11-01T16:07:32+08:00'));
    assert.equal(byId.a1.active, true);
    assert.equal(byId.a4.status, 'ACTIVE', '未给 status ⇒ 夹具默认值（这里只证明字段直通）');
  });
});

test('标题截断：120 code point（不劈 emoji），超长补 …', async () => {
  await withFixture(async (home) => {
    const long = '😀'.repeat(TASK_TITLE_MAX_CHARS + 5);
    seedDb(home, [{ id: 'long', name: long, created_at: 1000 }]);
    const res = readTaskList();
    const [task] = res.tasks;
    assert.equal(Array.from(task.title).length, TASK_TITLE_MAX_CHARS + 1, '120 个字符 + 省略号');
    assert.ok(task.title.endsWith('…'));
    assert.ok(!task.title.includes('\uFFFD'), '不得把 emoji 劈成半个（按 code point 截断）');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ② 活行 / 软删 / 排序 / limit
// ══════════════════════════════════════════════════════════════════════════

test('默认只列活行；includeDeleted:true 连软删历史一起给（active:false）', async () => {
  await withFixture(async (home) => {
    seedDb(home, [
      { id: 'live-1', name: '活着', created_at: 3000, deleted_at: null },
      { id: 'live-2', name: '也活着', created_at: 2000, deleted_at: null },
      { id: 'gone-1', name: '已退役', created_at: 4000, deleted_at: 9000 },
    ]);
    const live = readTaskList();
    assert.equal(live.ok, true);
    assert.deepEqual(live.tasks.map((t) => t.id), ['live-1', 'live-2'], '默认只列活行，且按 created_at DESC');
    assert.equal(live.tasks.every((t) => t.active === true), true);

    const all = readTaskList({ includeDeleted: true });
    assert.equal(all.count, 3);
    assert.deepEqual(all.tasks.map((t) => t.id), ['gone-1', 'live-1', 'live-2'], '含历史时同样按 created_at DESC');
    const gone = all.tasks.find((t) => t.id === 'gone-1');
    assert.equal(gone.active, false, '软删行必须标 active:false');
  });
});

test('limit：默认 50 / 显式 limit / 上限钳制 / truncated 只回答"还有更多"', async () => {
  await withFixture(async (home) => {
    const rows = Array.from({ length: TASK_LIST_MAX_LIMIT + 5 }, (_, i) => ({ id: `t-${i}`, name: `T${i}`, created_at: 10_000 - i }));
    seedDb(home, rows);
    const def = readTaskList();
    assert.equal(def.count, TASK_LIST_DEFAULT_LIMIT);
    assert.equal(def.truncated, true, `${TASK_LIST_MAX_LIMIT + 5} 行 > 默认 50 ⇒ truncated`);

    const small = readTaskList({ limit: 3 });
    assert.equal(small.count, 3);
    assert.equal(small.truncated, true);

    const over = readTaskList({ limit: 999_999 });
    assert.equal(over.count, TASK_LIST_MAX_LIMIT, '超过硬上限按上限给');
    assert.equal(over.truncated, true);
  });

  // 恰好等于上限的库：多取 1 行探测 ⇒ 不应误标 truncated。
  await withFixture(async (home) => {
    seedDb(home, Array.from({ length: TASK_LIST_MAX_LIMIT }, (_, i) => ({ id: `e-${i}`, name: `E${i}`, created_at: 1000 + i })));
    const exact = readTaskList({ limit: TASK_LIST_MAX_LIMIT });
    assert.equal(exact.count, TASK_LIST_MAX_LIMIT);
    assert.equal(exact.truncated, false, '恰好等于上限 ⇒ 不标 truncated');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ③ 失败面与失败纪律
// ══════════════════════════════════════════════════════════════════════════

test('失败纪律：无库 ⇒ ok:false + reason；真·空表 ⇒ ok:true + []（读不到 ≠ 没有任务）', async () => {
  await withFixture(async (home) => {
    const missing = readTaskList();
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /^db-missing: /);

    seedDb(home, []);
    const empty = readTaskList();
    assert.equal(empty.ok, true, `空表也是成功读取：${empty.reason ?? ''}`);
    assert.deepEqual(empty.tasks, []);
    assert.equal(empty.count, 0);
    assert.equal(empty.reason, null);
  });
});

test('旧 schema / 缺表 ⇒ ok:false 且逐列点名（不抛错）', async () => {
  await withFixture(async (home) => {
    // 旧 schema：只有核心三列 ⇒ 必须逐列点名缺什么，而不是等 SELECT 抛 "no such column"。
    const path = join(home, 'workbuddy.db');
    const db = new DatabaseSync(path);
    try {
      db.exec('CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER);');
      db.prepare('INSERT INTO automations (id, name, created_at) VALUES (?, ?, ?)').run('x', 'x', 1000);
    } finally {
      db.close();
    }
    const partial = readTaskList();
    assert.equal(partial.ok, false);
    assert.match(partial.reason, /^schema-missing-columns: /);
    assert.match(partial.reason, /prompt/);
    assert.match(partial.reason, /deleted_at/);

    // 表缺失：库里没有 automations（不是 WorkBuddy 的库？）
    rmSync(path);
    const noDb = new DatabaseSync(path);
    try {
      noDb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY);');
    } finally {
      noDb.close();
    }
    const noTable = readTaskList();
    assert.equal(noTable.ok, false);
    assert.equal(noTable.reason, 'automations-table-missing');
  });
});

test('永不 throw：非法 db 选项 / 垃圾 limit-timeout ⇒ 有解释的 ok:false，不抛', async () => {
  await withFixture(async () => {
    const badNumber = readTaskList({ db: 42 });
    assert.equal(badNumber.ok, false);
    assert.match(badNumber.reason, /^db-invalid: /);

    const badObject = readTaskList({ db: {} });
    assert.equal(badObject.ok, false);
    assert.match(badObject.reason, /^db-invalid: /);

    const emptyPath = readTaskList({ db: '' });
    assert.equal(emptyPath.ok, false);
    assert.match(emptyPath.reason, /empty path/);

    assert.doesNotThrow(() => readTaskList({ limit: Number.NaN, timeout: -5 }));
    const res = readTaskList({ limit: Number.NaN, timeout: -5 });
    assert.equal(res.ok, false);
    assert.match(res.reason, /^db-missing: /);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ④ 只读与无副作用
// ══════════════════════════════════════════════════════════════════════════

test('只读纪律：库文件字节不变 / 只读句柄上写入被拒 / 不 close 调用方句柄', async () => {
  await withFixture(async (home) => {
    const path = seedDb(home, [
      { id: 'ro-1', name: 'Read only', created_at: 1000 },
      { id: 'ro-2', name: 'Soft deleted', created_at: 900, deleted_at: 3000 },
    ]);
    const before = sha256(path);

    const own = readTaskList({ db: path });
    assert.equal(own.ok, true, own.reason ?? '');
    assert.equal(sha256(path), before, '只读打开/读取不得改动库文件');

    const ro = new DatabaseSync(path, { readOnly: true });
    try {
      const viaHandle = readTaskList({ db: ro });
      assert.equal(viaHandle.ok, true);
      assert.equal(viaHandle.count, 1);
      assert.equal(ro.prepare('SELECT COUNT(*) c FROM automations').get().c, 2, '模块不得 close 调用方的句柄');
      assert.throws(
        () => ro.prepare("INSERT INTO automations (id, name) VALUES ('probe', 'x')").run(),
        /readonly|read.?only|attempt to write/i,
        '只读连接上写必须被 SQLite 拒绝',
      );
    } finally {
      ro.close();
    }
    assert.equal(sha256(path), before, '模块全程没有写库');
  });
});

test('无副作用：读取任务清单不发起任何网络连接 / fetch', async () => {
  await withFixture(async (home) => {
    seedDb(home, Array.from({ length: 3 }, (_, i) => ({ id: `side-${i}`, name: `T${i}`, created_at: 1000 + i })));
    let netCalls = 0;
    let fetchCalls = 0;
    const origConnect = net.connect;
    const origCreateConnection = net.createConnection;
    const origFetch = globalThis.fetch;
    net.connect = function patchedConnect(...args) { netCalls += 1; return origConnect.apply(this, args); };
    net.createConnection = function patchedCreateConnection(...args) { netCalls += 1; return origCreateConnection.apply(this, args); };
    globalThis.fetch = function patchedFetch(...args) { fetchCalls += 1; return origFetch.apply(this, args); };
    try {
      const res = readTaskList();
      assert.equal(res.ok, true, res.reason ?? '');
      assert.equal(res.count, 3);
    } finally {
      net.connect = origConnect;
      net.createConnection = origCreateConnection;
      globalThis.fetch = origFetch;
    }
    assert.equal(netCalls, 0, '读取任务清单不得发起任何网络连接');
    assert.equal(fetchCalls, 0, '读取任务清单不得调用 fetch');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 接线：工具面 tasks 段 + 状态路由 taskList
// ══════════════════════════════════════════════════════════════════════════

test('接线：workbuddy_status 的 tasks 段（含 all 切片与 output.schema 校验）', async () => {
  await withFixture(async (home) => {
    seedDb(home, [
      { id: 'task-1', name: '会话清单开发', status: 'ACTIVE', created_at: 3000 },
      { id: 'task-2', name: '默认直连点火', status: 'ACTIVE', created_at: 2000 },
      { id: 'task-old', name: '已退役的历史任务', status: 'ACTIVE', created_at: 1000, deleted_at: 9000 },
    ]);
    const tool = makeStatusTool(createMockRuntime(), () => ({}), {}, null);
    const sliced = await tool.execute({ section: 'tasks' });
    assert.equal(sliced.section, 'tasks');
    assert.equal(sliced.tasks.ok, true, sliced.tasks.reason ?? '');
    assert.deepEqual(sliced.tasks.tasks.map((t) => t.title), ['会话清单开发', '默认直连点火'], '默认只列活行');
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, sliced, 'workbuddy_status'), [], 'tasks 切片必须落在 output.schema 内');

    // ★ 0.6.1 收口：历史任务要**显式**要（includeDeleted + taskLimit），不默认摊进每轮载荷。
    const history = await tool.execute({ section: 'tasks', includeDeleted: true, taskLimit: 1 });
    assert.equal(history.tasks.ok, true);
    assert.equal(history.tasks.count, 1);
    assert.equal(history.tasks.tasks[0].id, 'task-1');
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, history, 'workbuddy_status'), [], '带参数切片仍须落在 schema 内');

    const all = await tool.execute({});
    assert.equal(all.tasks.ok, true);
    assert.equal(all.tasks.tasks.length, 2, "'all' 只带活行（默认口径）");
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, all, 'workbuddy_status'), [], 'all 载荷必须落在 output.schema 内');
  });
});

test('接线：状态路由 taskList 字段（与工具面同源）', async () => {
  await withFixture(async (home) => {
    seedDb(home, [{ id: 'route-1', name: '路由里的任务', created_at: 1000 }]);
    // 同一夹具库里补一张 sessions 表：证明两个清单字段并列时互不影响（各自有各自的真源）。
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    try {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, custom_title TEXT, created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER, is_background_automation INTEGER, model TEXT, cwd TEXT);');
      db.prepare('INSERT INTO sessions (id, title, created_at, deleted_at) VALUES (?, ?, ?, ?)').run('s-1', '路由里的会话', 1000, null);
    } finally {
      db.close();
    }
    const { status, payload } = await callStatusRoute(createMockRuntime());
    assert.equal(status, 200);
    assert.equal(payload.taskList.ok, true, payload.taskList.reason ?? '');
    assert.equal(payload.taskList.count, 1);
    assert.equal(payload.taskList.tasks[0].title, '路由里的任务');
    assert.equal(payload.sessionList.ok, true, '会话清单字段仍在（两个清单并列，互不影响）');
    assert.equal(payload.sessionList.tasks, undefined, 'sessionList 不得混入任务清单（键互斥）');
  });
});
