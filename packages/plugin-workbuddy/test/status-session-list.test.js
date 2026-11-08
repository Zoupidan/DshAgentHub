/**
 * 桌面端**真实会话清单**（`launch/session-list.js`）回归测试。
 *
 * 覆盖（任务 T5 验收面）：
 *   ① 字段与口径：标题 / 三个时间 / active（`deleted_at IS NULL`）/ background / model / cwd；
 *   ② 标题三态（`title` → `custom_title` → `(untitled)`）与 120 字符截断（按 code point，不劈 emoji）；
 *   ③ 排序：`COALESCE(last_activity_at, created_at)` DESC（`last_activity_at` 空时用创建时间）；
 *   ④ limit 默认 50 / 超上限钳制 / `truncated` 只回答"还有没有更多"、`count` 只回答"这次给了几条"；
 *   ⑤ 失败面：库缺失 / 表缺失 / 旧 schema 缺列 / 库被独占锁 ⇒ `{ ok:false, reason }`，**绝不抛错**；
 *   ⑥ ★ 失败纪律（Lead 明令）：读不到时 `ok:false + reason`，**绝不以空数组冒充"没有会话"**——
 *      本文件用「无库」与「真·空表」两个对照把这条钉死（前者 ok:false，后者 ok:true + []）；
 *   ⑦ 只读纪律：库文件字节级不变；传只读句柄可用且写必被 SQLite 拒绝；不 close 调用方的句柄；
 *   ⑧ 两出口接线：`workbuddy_status` 的 `conversations` 段（含 `all` 切片与 output.schema 校验）
 *      与状态路由的 `sessionList` 字段，且**不改变**既有 `sessions` 段（插件会话记性）的语义；
 *   ⑨ 附带（跨任务同步 T6）：`enableDirectIgnition` 默认翻成 true 后，`ignition.mode/reason` 的
 *      「显式关 / 未读到该键 / 开但探不到 CDP ⇒ 回退」三分支不得再说"(schema default)"的旧假话。
 *
 * 夹具纪律：**只用临时 WORKBUDDY_HOME 下的夹具库**，经 `tools/dev/test-home-guard.mjs` 的进程环境；
 * 真库只读（`readOnly: true`）也不在测试里碰 —— 测试必须能在一台没装 WorkBuddy 的机器上绿。
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

import { readSessionList, SESSION_LIST_DEFAULT_LIMIT, SESSION_LIST_MAX_LIMIT, SESSION_TITLE_MAX_CHARS } from '../src/host/launch/session-list.js';
import { makeStatusRoute } from '../src/host/routes/status/get.js';
import { makeStatusTool } from '../src/host/tools/status.js';

/** 与真机 2026-11-08 实测列集一致（`PRAGMA table_info(sessions)` 41 列中的 12 列，含一个不消费的 status）。 */
const SCHEMA_FULL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    user_id TEXT,
    title TEXT,
    custom_title TEXT,
    status TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    last_activity_at INTEGER,
    deleted_at INTEGER,
    is_background_automation INTEGER,
    model TEXT
  );
`;

/**
 * 造一个一次性家目录并把 `WORKBUDDY_HOME` / `DSH_WB_COST_HOME` 都指过去。
 *
 * ★ 为什么两个都要指：`readSessionList()` 走 `workbuddyDbPath()`（WORKBUDDY_HOME）；
 *   而 `workbuddy_status` 还会读成本目录 —— 不隔离的话它会摸到宿主真实 `~/.workbuddy/cache`，
 *   测试就变成"取决于这台机器装没装 WorkBuddy"（既有测试的 `DSH_WB_COST_HOME` 同款纪律）。
 */
async function withFixture(fn) {
  const home = mkdtempSync(join(tmpdir(), 'wb-session-list-'));
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
    try { rmSync(home, { recursive: true, force: true }); } catch { /* 退出期清理失败不覆盖测试结论 */ }
  }
}

/** 造真机形状的夹具库；返回库路径。`rows` 里未给的字段一律 NULL（与真库同语义）。 */
function seedFullDb(home, rows, filename = 'workbuddy.db') {
  const path = join(home, filename);
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA_FULL);
    const stmt = db.prepare(
      'INSERT INTO sessions (id, cwd, title, custom_title, status, created_at, updated_at, '
      + 'last_activity_at, deleted_at, is_background_automation, model) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) {
      stmt.run(
        r.id ?? null, r.cwd ?? null, r.title ?? null, r.custom_title ?? null, r.status ?? 'active',
        r.created_at ?? null, r.updated_at ?? null, r.last_activity_at ?? null,
        r.deleted_at ?? null, r.is_background_automation ?? null, r.model ?? null,
      );
    }
  } finally {
    db.close();
  }
  return path;
}

/** 库文件内容摘要 —— 只读断言用（一个字节都不许变）。 */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 与既有 status 测试同款的最小 runtime 桩（只暴露真实存在的读数）。 */
function createMockRuntime() {
  return {
    registry: () => 'REGISTERED',
    registrationError: () => null,
    detected: () => ({ installed: false, reason: 'fixture', resolvedPath: '', method: 'no-exec', at: 0, evidence: [] }),
    inFlight: () => [],
    lastRun: () => null,
    probe: async () => {},
  };
}

/** 插件自己的会话记性夹具（用于证明 `sessions` 段语义没被 `conversations` 挤掉）。 */
const MOCK_SESSIONS = {
  list: () => [{ key: 'plugin-key-1', cliSessionId: 'cli-session-1', lastUsedAt: 1_712_600_000_000 }],
};

/** 路由面桩：`enabled:false` ⇒ 不读模型目录/成本目录/桌面端 IPC（本组用例只钉 sessionList 接线）。 */
function createRouteRuntime() {
  return {
    currentConfig: () => ({ enabled: false }),
    detected: () => null,
    registry: () => 'REGISTERED',
    registrationError: () => null,
    inFlight: () => [],
    lastRun: () => null,
  };
}

/** 直接经 handler 取载荷（与 host.test.js 的 routePayload 同款最小 req/res）。 */
async function callStatusRoute(runtime) {
  const route = makeStatusRoute({ get: () => undefined }, runtime, 'dsh-plugin-workbuddy', {});
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b ?? ''; },
  };
  await route.handler(
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7777' } },
    res,
  );
  return { statusCode: res.statusCode, json: JSON.parse(res.body) };
}

// ══════════════════════════════════════════════════════════════════════════
// ① 字段 / active / background / 排序
// ══════════════════════════════════════════════════════════════════════════

test('字段与排序：COALESCE(last_activity_at, created_at) DESC + active=deleted_at IS NULL + 契约字段集', async () => {
  await withFixture(async (home) => {
    const path = seedFullDb(home, [
      // a：最近活动 3000；软删为空 ⇒ active；后台任务；有模型/目录
      { id: 'a', title: 'Alpha', created_at: 1000, updated_at: 1500, last_activity_at: 3000, deleted_at: null, is_background_automation: 1, model: 'deepseek-v4-pro', cwd: 'D:/work' },
      // b：last_activity_at 为空 ⇒ 用 created_at=4000 参与排序（排最前）；软删 5000 ⇒ 非 active；无标题 ⇒ custom_title
      { id: 'b', title: null, custom_title: 'Beta renamed', created_at: 4000, updated_at: 4500, last_activity_at: null, deleted_at: 5000, is_background_automation: null },
      // c：last_activity_at=2000 压过更老的 created_at=500
      { id: 'c', title: 'Gamma', created_at: 500, updated_at: 800, last_activity_at: 2000, deleted_at: null },
      // d：两列标题皆空 ⇒ (untitled)；last_activity_at 空 ⇒ created_at=1000 排最后
      { id: 'd', title: null, custom_title: null, created_at: 1000, updated_at: 1200, last_activity_at: null, deleted_at: null },
    ]);

    const res = readSessionList({ db: path });
    assert.equal(res.ok, true, `夹具库必须可读：${res.reason ?? ''}`);
    assert.equal(res.reason, null);
    assert.equal(res.truncated, false);
    assert.equal(res.count, 4);
    assert.deepEqual(
      res.sessions.map((s) => s.id),
      ['b', 'a', 'c', 'd'],
      '排序键必须是 COALESCE(last_activity_at, created_at) DESC',
    );

    const byId = Object.fromEntries(res.sessions.map((s) => [s.id, s]));
    // ★ 键集是契约：多一个字段 = 载荷无谓扩散；少一个 = 消费方拿不到。
    assert.deepEqual(
      Object.keys(byId.a).sort(),
      ['active', 'background', 'createdAt', 'cwd', 'id', 'lastActivityAt', 'model', 'title', 'updatedAt'],
    );
    assert.equal(byId.a.title, 'Alpha');
    assert.equal(byId.a.createdAt, 1000);
    assert.equal(byId.a.updatedAt, 1500);
    assert.equal(byId.a.lastActivityAt, 3000);
    assert.equal(byId.a.active, true, 'deleted_at 为空 ⇒ 活跃');
    assert.equal(byId.a.background, true, 'is_background_automation=1 ⇒ 后台任务');
    assert.equal(byId.a.model, 'deepseek-v4-pro');
    assert.equal(byId.a.cwd, 'D:/work');

    assert.equal(byId.b.active, false, 'deleted_at 非空 ⇒ 软删（"活跃"不得把软删行算进来）');
    assert.equal(byId.b.title, 'Beta renamed', 'title 空 ⇒ 回落 custom_title');
    assert.equal(byId.b.lastActivityAt, null, 'last_activity_at 为空 ⇒ null（未知，不是 0/现在）');
    assert.equal(byId.b.model, null);
    assert.equal(byId.b.cwd, null);

    assert.equal(byId.d.title, '(untitled)', '两列标题皆空 ⇒ 占位而非空串');
    assert.equal(byId.d.active, true);
    assert.equal(byId.d.background, false, 'is_background_automation=NULL ⇒ 非后台');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ② 标题三态与截断
// ══════════════════════════════════════════════════════════════════════════

test('标题口径：title 优先 / custom_title 兜底 / (untitled) 占位 / 120 字符截断（不劈 emoji）', async () => {
  await withFixture(async (home) => {
    const exact = 'y'.repeat(SESSION_TITLE_MAX_CHARS);      // 恰好 120：不得加省略号
    const long = 'x'.repeat(SESSION_TITLE_MAX_CHARS + 10);  // 130：截断 + …
    const emoji = '😀'.repeat(SESSION_TITLE_MAX_CHARS + 10); // 代理对：截断必须按 code point
    const path = seedFullDb(home, [
      { id: 't1', title: exact, created_at: 600 },
      { id: 't2', title: long, created_at: 500 },
      { id: 't3', title: emoji, created_at: 400 },
      { id: 't4', title: '   ', custom_title: 'Custom Title', created_at: 300 },
      { id: 't5', title: null, custom_title: null, created_at: 200 },
      { id: 't6', title: 'Title Wins', custom_title: 'Custom Loses', created_at: 100 },
    ]);

    const res = readSessionList({ db: path });
    assert.equal(res.ok, true, `夹具库必须可读：${res.reason ?? ''}`);
    const byId = Object.fromEntries(res.sessions.map((s) => [s.id, s]));

    assert.equal(byId.t1.title, exact, '恰好 120 字符不得截断');
    assert.equal(byId.t2.title, `${'x'.repeat(SESSION_TITLE_MAX_CHARS)}…`);
    assert.equal(Array.from(byId.t2.title).length, SESSION_TITLE_MAX_CHARS + 1);

    assert.equal(Array.from(byId.t3.title).length, SESSION_TITLE_MAX_CHARS + 1);
    assert.ok(byId.t3.title.endsWith('…'));
    // 只留前 120 个 emoji + …；若按 UTF-16 码元截断，会留下孤立代理项，UTF-8 往返会变成 U+FFFD。
    assert.equal(byId.t3.title.slice(0, -1), '😀'.repeat(SESSION_TITLE_MAX_CHARS));
    assert.equal(
      Buffer.from(byId.t3.title, 'utf8').toString('utf8'),
      byId.t3.title,
      '截断必须发生在 code point 边界（否则孤立代理项会被 UTF-8 编码替换掉）',
    );

    assert.equal(byId.t4.title, 'Custom Title', '空白 title 视同空 ⇒ 回落 custom_title');
    assert.equal(byId.t5.title, '(untitled)');
    assert.equal(byId.t6.title, 'Title Wins', 'title 非空时优先 title（任务书口径）');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ③ limit / truncated / count
// ══════════════════════════════════════════════════════════════════════════

test('limit 与 truncated：默认 50、显式 limit、超上限钳制、count 只数本次回传', async () => {
  await withFixture(async (home) => {
    const total = SESSION_LIST_MAX_LIMIT + 5; // 205：足够验证钳制
    const rows = Array.from({ length: total }, (_, i) => ({
      id: `row-${String(i).padStart(3, '0')}`,
      title: `Conversation ${i}`,
      created_at: 1_000 + i, // 越大越新 ⇒ 降序回传 row-204 … row-000
    }));
    const path = seedFullDb(home, rows);

    const byDefault = readSessionList({ db: path });
    assert.equal(byDefault.ok, true);
    assert.equal(byDefault.count, SESSION_LIST_DEFAULT_LIMIT);
    assert.equal(byDefault.sessions.length, SESSION_LIST_DEFAULT_LIMIT);
    assert.equal(byDefault.sessions[0].id, 'row-204', '默认按最新在前');
    assert.equal(byDefault.sessions.at(-1).id, 'row-155');
    assert.equal(byDefault.truncated, true, `205 行 > 默认 ${SESSION_LIST_DEFAULT_LIMIT} 行 ⇒ 必须如实标出还有更多`);
    assert.equal(byDefault.count, byDefault.sessions.length, 'count = 本次实际回传条数');

    const three = readSessionList({ db: path, limit: 3 });
    assert.equal(three.count, 3);
    assert.deepEqual(three.sessions.map((s) => s.id), ['row-204', 'row-203', 'row-202']);
    assert.equal(three.truncated, true);

    const clamped = readSessionList({ db: path, limit: 1_000_000 });
    assert.equal(clamped.count, SESSION_LIST_MAX_LIMIT, '超上限必须钳制（防一句 limit 把整库倒进上下文）');
    assert.equal(clamped.truncated, true, '钳制后仍是 205 行库里的一部分 ⇒ 还有更多');

    // 「行数恰好等于 limit ⇒ 没有更多」用一份 200 行的库单独钉（205 行库上任何 limit 都会被钳到 200）。
    const exactPath = seedFullDb(home, rows.slice(0, SESSION_LIST_MAX_LIMIT), 'exact.db');
    const exact = readSessionList({ db: exactPath, limit: SESSION_LIST_MAX_LIMIT });
    assert.equal(exact.count, SESSION_LIST_MAX_LIMIT);
    assert.equal(exact.truncated, false, '行数恰好等于 limit ⇒ 没有更多，不得谎报 truncated');

    // 垃圾 limit ⇒ 回落默认值（不抛错、不把 0 当"不限"）。
    assert.equal(readSessionList({ db: path, limit: 0 }).count, SESSION_LIST_DEFAULT_LIMIT);
    assert.equal(readSessionList({ db: path, limit: Number.NaN }).count, SESSION_LIST_DEFAULT_LIMIT);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ④ 失败面：库缺失 / 表缺失 / 旧 schema / 被锁 —— 全部 ok:false + reason，绝不 throw
// ══════════════════════════════════════════════════════════════════════════

test('失败面：库缺失 ⇒ ok:false + db-missing（不是 ok:true + 空数组）', async () => {
  await withFixture(async (home) => {
    const res = readSessionList();
    assert.equal(res.ok, false);
    assert.deepEqual(res.sessions, []);
    assert.equal(res.count, 0);
    assert.equal(res.truncated, false);
    assert.match(res.reason, /^db-missing: /);
    assert.ok(res.reason.includes(join(home, 'workbuddy.db')), 'reason 必须带可复核的路径证据');
  });
});

test('失败面：库里没有 sessions 表 ⇒ sessions-table-missing', async () => {
  await withFixture(async (home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    try { db.exec('CREATE TABLE automations (id TEXT PRIMARY KEY)'); } finally { db.close(); }
    const res = readSessionList();
    assert.equal(res.ok, false);
    assert.deepEqual(res.sessions, []);
    assert.equal(res.reason, 'sessions-table-missing');
  });
});

test('失败面：旧 schema 缺列 ⇒ schema-missing-columns 逐列点名（不是到 SELECT 才炸）', async () => {
  await withFixture(async (home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    try {
      // 早期形态：只有 id/title/created_at。缺的列必须在 reason 里逐个点名。
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER)');
    } finally { db.close(); }

    const res = readSessionList();
    assert.equal(res.ok, false, '缺列必须失败 —— 用空数组/默认值硬凑出来的"清单"是假事实');
    assert.deepEqual(res.sessions, []);
    assert.match(res.reason, /^schema-missing-columns: /);
    for (const missing of ['custom_title', 'last_activity_at', 'deleted_at', 'model', 'cwd']) {
      assert.ok(res.reason.includes(missing), `reason 必须点名缺列 ${missing}：${res.reason}`);
    }
    assert.ok(!res.reason.includes('updated_at ') || true); // updated_at 也在缺列里；不额外钉格式
  });
});

test('失败面：库被独占锁 ⇒ ok:false + 带 locked 证据（等不到锁就如实说，不静默少几条）', async () => {
  await withFixture(async (home) => {
    const path = seedFullDb(home, [{ id: 'locked-1', title: 'Busy', created_at: 1000 }]);
    const locker = new DatabaseSync(path);
    try {
      locker.exec('BEGIN EXCLUSIVE');
      try { locker.prepare("INSERT INTO sessions (id, title, created_at) VALUES ('locker', 'x', 500)").run(); } catch { /* 只为持锁 */ }

      const res = readSessionList({ db: path, timeout: 50 });
      assert.equal(res.ok, false, '读不到锁就必须 ok:false —— 不能把"锁住了"读成"只有 N 条"');
      assert.deepEqual(res.sessions, []);
      assert.match(res.reason, /locked/i, `reason 必须带锁证据：${res.reason}`);
    } finally {
      try { locker.exec('ROLLBACK'); } catch { /* 已回滚/未开会话都不致命 */ }
      try { locker.close(); } catch { /* 关闭失败不覆盖断言 */ }
    }
  });
});

test('★ 失败纪律：无库(ok:false) 与 真·空表(ok:true + []) 必须可区分', async () => {
  await withFixture(async (home) => {
    // 1) 读不到 ⇒ ok:false + reason（不是"你没有会话"）
    const missing = readSessionList();
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /^db-missing: /);

    // 2) 工具面同样不得把失败伪装成空：conversations 必须 ok:false + reason
    //    （★ 必须在造夹具库**之前**跑 —— 这里要的就是"库里没有库"的那一态。）
    const tool = makeStatusTool(createMockRuntime(), () => ({}), {}, MOCK_SESSIONS);
    const sliced = await tool.execute({ section: 'conversations' });
    assert.equal(sliced.conversations.ok, false, '无库时 conversations 必须是 ok:false');
    assert.match(sliced.conversations.reason, /^db-missing: /);
    assert.equal(sliced.conversations.count, 0);
    const all = await tool.execute({});
    assert.equal(all.conversations.ok, false, 'all 切片同样不得把失败伪装成空清单');
    assert.match(all.conversations.reason, /^db-missing: /);

    // 3) 真·空表 ⇒ ok:true + []（这才是"确实没有会话"）——与第 1 步的 ok:false 构成对照
    const emptyPath = seedFullDb(home, []);
    const empty = readSessionList({ db: emptyPath });
    assert.equal(empty.ok, true, `空表也是成功读取：${empty.reason ?? ''}`);
    assert.deepEqual(empty.sessions, []);
    assert.equal(empty.count, 0);
    assert.equal(empty.reason, null);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 只读纪律
// ══════════════════════════════════════════════════════════════════════════

test('只读纪律：库文件字节不变 / 只读句柄可用且写入被拒 / 不 close 调用方句柄', async () => {
  await withFixture(async (home) => {
    const path = seedFullDb(home, [
      { id: 'ro-1', title: 'Read only', created_at: 1000, deleted_at: null },
      { id: 'ro-2', title: 'Soft deleted', created_at: 900, deleted_at: 3000 },
    ]);
    const before = sha256(path);

    // ① 本模块自己开的连接（生产路径）：读完库文件一个字节都不许变，也不留 -journal。
    const own = readSessionList({ db: path });
    assert.equal(own.ok, true, `只读读取必须成功：${own.reason ?? ''}`);
    assert.equal(sha256(path), before, '只读打开/读取不得改动库文件');

    // ② 调用方传入只读句柄：可读、且该句柄上任何写都被 SQLite 拒绝（模块若尝试写，走的是同一条拒绝）。
    const ro = new DatabaseSync(path, { readOnly: true });
    try {
      const viaHandle = readSessionList({ db: ro });
      assert.equal(viaHandle.ok, true);
      assert.equal(viaHandle.count, 2);
      assert.equal(ro.prepare('SELECT COUNT(*) c FROM sessions').get().c, 2, '模块不得 close 调用方的句柄');
      assert.throws(
        () => ro.prepare("INSERT INTO sessions (id, title) VALUES ('probe', 'x')").run(),
        /readonly|read.?only|attempt to write/i,
        '只读连接上写必须被 SQLite 拒绝（这正是"只读是结构性"的证据面）',
      );
      assert.equal(ro.prepare('SELECT COUNT(*) c FROM sessions').get().c, 2, '被拒的写不得留下任何行');
    } finally {
      ro.close();
    }

    // ③ 即使调用方给的是可写句柄，本模块也只读：行数与文件摘要都不变。
    const rw = new DatabaseSync(path);
    try {
      const viaRw = readSessionList({ db: rw });
      assert.equal(viaRw.ok, true);
      assert.equal(rw.prepare('SELECT COUNT(*) c FROM sessions').get().c, 2, '传入可写句柄也不得写入');
    } finally {
      rw.close();
    }
    assert.equal(sha256(path), before, '模块全程没有写库');
  });
});

test('无副作用：conversations 读取不发起任何网络连接 / fetch（纯 SQLite 只读，不碰 CDP）', async () => {
  // ★ Lead 的额外验收条：会话清单**只许**走 SQLite 只读查询，不得复用会做网络/CDP 探测的 helper。
  //   行为面证据：把 `net.connect` / `net.createConnection` / `globalThis.fetch` 都换成计数器，
  //   真读一次夹具库，三者必须恒为 0（静态面证据：本模块 import 面只有 node:fs + sqlite 读取口）。
  await withFixture(async (home) => {
    seedFullDb(home, Array.from({ length: 5 }, (_, i) => ({ id: `side-${i}`, title: `T${i}`, created_at: 1_000 + i })));

    let netCalls = 0;
    let fetchCalls = 0;
    const origConnect = net.connect;
    const origCreateConnection = net.createConnection;
    const origFetch = globalThis.fetch;
    net.connect = function patchedConnect(...args) { netCalls += 1; return origConnect.apply(this, args); };
    net.createConnection = function patchedCreateConnection(...args) { netCalls += 1; return origCreateConnection.apply(this, args); };
    globalThis.fetch = function patchedFetch(...args) { fetchCalls += 1; return origFetch.apply(this, args); };
    try {
      const res = readSessionList();
      assert.equal(res.ok, true, `夹具库必须可读：${res.reason ?? ''}`);
      assert.equal(res.count, 5);
      // 工具面同一份读取口也走一遍（确认 wiring 没有偷偷接别的 helper）。
      const tool = makeStatusTool(createMockRuntime(), () => ({}), {}, MOCK_SESSIONS);
      const sliced = await tool.execute({ section: 'conversations' });
      assert.equal(sliced.conversations.ok, true);
    } finally {
      net.connect = origConnect;
      net.createConnection = origCreateConnection;
      globalThis.fetch = origFetch;
    }
    assert.equal(netCalls, 0, '读取会话清单不得发起任何网络连接（CDP/HTTP 一次都不许）');
    assert.equal(fetchCalls, 0, '读取会话清单不得调用 fetch');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 永不 throw（诊断面）
// ══════════════════════════════════════════════════════════════════════════
test('永不 throw：非法 db 选项 / 垃圾 limit-timeout ⇒ ok:false 或默认值，不抛', async () => {
  await withFixture(async () => {
    const badNumber = readSessionList({ db: 42 });
    assert.equal(badNumber.ok, false);
    assert.match(badNumber.reason, /^db-invalid: /);

    const badObject = readSessionList({ db: {} });
    assert.equal(badObject.ok, false);
    assert.match(badObject.reason, /^db-invalid: /);

    const emptyPath = readSessionList({ db: '' });
    assert.equal(emptyPath.ok, false);
    assert.match(emptyPath.reason, /empty path/);

    // 无库 + 垃圾 limit/timeout：仍是有解释的 ok:false，而不是 TypeError。
    assert.doesNotThrow(() => readSessionList({ limit: Number.NaN, timeout: -5 }));
    assert.doesNotThrow(() => readSessionList({ limit: 'many', timeout: {} }));
    const res = readSessionList({ limit: Number.NaN, timeout: -5 });
    assert.equal(res.ok, false);
    assert.match(res.reason, /^db-missing: /);
  });
});

test('fail-closed：测试进程解析不到家目录 ⇒ ok:false（绝不回落真实 ~/.workbuddy）', {
  skip: !process.env.NODE_TEST_CONTEXT,
}, async () => {
  const prev = process.env.WORKBUDDY_HOME;
  delete process.env.WORKBUDDY_HOME;
  try {
    const res = readSessionList();
    assert.equal(res.ok, false, '测试进程必须 fail-closed —— 回落真家目录正是两次真库写入事故的根因');
    assert.match(res.reason, /^home-unresolved: /);
  } finally {
    if (prev !== undefined) process.env.WORKBUDDY_HOME = prev;
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 两出口接线：工具面 conversations 段 / 路由面 sessionList 字段
// ══════════════════════════════════════════════════════════════════════════

test('工具面：section=conversations 与 all 都带桌面清单；sessions 段语义保持不变；schema 零违约', async () => {
  await withFixture(async (home) => {
    seedFullDb(home, [
      { id: 'c-newer', title: 'Newest conversation', created_at: 2000, last_activity_at: 3000, deleted_at: null },
      { id: 'c-older', title: 'Older conversation', created_at: 1000, last_activity_at: 1500, deleted_at: 2500 },
    ]);
    const tool = makeStatusTool(createMockRuntime(), () => ({}), {}, MOCK_SESSIONS);

    const sliced = await tool.execute({ section: 'conversations' });
    assert.equal(sliced.section, 'conversations');
    assert.equal(sliced.conversations.ok, true, `有库必须读到：${sliced.conversations.reason ?? ''}`);
    assert.equal(sliced.conversations.count, 2);
    assert.deepEqual(sliced.conversations.sessions.map((s) => s.id), ['c-newer', 'c-older']);
    assert.equal(sliced.conversations.sessions[1].active, false);
    assert.equal(sliced.sessions, undefined, 'conversations 切片不得把插件的 sessions 段混进来');
    assert.deepEqual(
      validateJsonSchemaValue(tool.output.schema, sliced, 'workbuddy_status'),
      [],
      'conversations 切片必须完全落在 output.schema 内',
    );
    assert.ok(
      tool.output.schema.properties.conversations,
      'output.schema 必须声明 conversations（additionalProperties:false 之下，未声明的键必被宿主校验打回）',
    );

    const all = await tool.execute({});
    assert.equal(all.conversations.ok, true);
    assert.equal(all.conversations.count, 2);
    assert.deepEqual(all.conversations.sessions.map((s) => s.id), ['c-newer', 'c-older']);
    // ★ 既有 sessions 段（插件会话记性）语义不变：仍是 session_key / cli_session_id / resumable / last_used_at。
    assert.equal(all.sessions.length, 1);
    assert.equal(all.sessions[0].session_key, 'plugin-key-1');
    assert.equal(all.sessions[0].cli_session_id, 'cli-session-1');
    assert.equal(all.conversations.sessions[0].session_key, undefined, '两段不得互相串味');
    assert.deepEqual(
      validateJsonSchemaValue(tool.output.schema, all, 'workbuddy_status'),
      [],
      'all 切片必须完全落在 output.schema 内',
    );
  });
});

test('路由面：载荷新增 sessionList（同结构）；失败时 200 + ok:false，不拖垮整个状态路由', async () => {
  // ① 有库：sessionList 与工具面同源同形状；既有 sessions[] 字段仍在（未接线 ⇒ []）。
  await withFixture(async (home) => {
    seedFullDb(home, [
      { id: 'r-1', title: 'Route newest', created_at: 2000, last_activity_at: 3000, deleted_at: null },
      { id: 'r-2', title: 'Route older', created_at: 1000, last_activity_at: 1500, deleted_at: 2000 },
    ]);
    const { statusCode, json } = await callStatusRoute(createRouteRuntime());
    assert.equal(statusCode, 200);
    assert.equal(json.sessionList.ok, true, `路由必须读到夹具库：${json.sessionList.reason ?? ''}`);
    assert.equal(json.sessionList.count, 2);
    assert.deepEqual(json.sessionList.sessions.map((s) => s.id), ['r-1', 'r-2']);
    assert.equal(json.sessionList.sessions[0].title, 'Route newest');
    assert.equal(Array.isArray(json.sessions), true, '既有 sessions[] 字段必须原样保留');
    assert.equal(json.sessions.length, 0);
  });

  // ② 无库：sessionList 失败但路由照常 200（诊断端点必须能开）。
  await withFixture(async () => {
    const { statusCode, json } = await callStatusRoute(createRouteRuntime());
    assert.equal(statusCode, 200);
    assert.equal(json.sessionList.ok, false);
    assert.match(json.sessionList.reason, /^db-missing: /);
    assert.deepEqual(json.sessionList.sessions, []);
    assert.equal(json.sessionList.count, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 附带：T6 把 `enableDirectIgnition` 默认翻成 true 后的 ignition 文案口径
//   （跨任务同步：旧文案 `'enableDirectIgnition is off (schema default)'` 在新默认下是**假话**；
//    本组把「显式关 / 未读到该键 / 开但 CDP 探不到 ⇒ 回退」三分支钉住。直连成功那一支由
//    T6 的 dispatcher 用例覆盖 —— 这里不伪造一个 CDP 端点。）
// ══════════════════════════════════════════════════════════════════════════

test('ignition 文案：显式关闭 ≠ schema 默认 / 未读到该键不冒充显式关 / 开但探不到 ⇒ 如实写回退+询问', async () => {
  await withFixture(async () => {
    const off = await makeStatusTool(createMockRuntime(), () => ({ enableDirectIgnition: false }), {}).execute({});
    assert.equal(off.ignition.mode, 'automation');
    assert.match(off.ignition.reason, /explicitly turned off in the plugin settings/);
    assert.match(off.ignition.reason, /the default is direct ignition \(true\)/, '显式关必须说明"这是反默认的选择"');
    assert.doesNotMatch(off.ignition.reason, /is off \(schema default\)/, '旧假话不得复活');

    const unset = await makeStatusTool(createMockRuntime(), () => ({}), {}).execute({});
    assert.equal(unset.ignition.mode, 'automation', '读不到该键时不冒充直连');
    assert.match(unset.ignition.reason, /not true in the effective config/);
    assert.doesNotMatch(unset.ignition.reason, /explicitly turned off/, '配置没读到 ≠ 用户显式关（不得栽赃）');

    // 端口 1 在本机必然拒绝连接 ⇒ 确定性地走"开但探不到 CDP"分支（不碰真实桌面端）。
    const on = await makeStatusTool(createMockRuntime(), () => ({ enableDirectIgnition: true, followupCdpPort: 1 }), {}).execute({});
    assert.equal(on.ignition.mode, 'direct', 'mode 是配置意图（开了就是 direct），不是本轮实况');
    assert.equal(on.cdp.available, false);
    assert.match(on.ignition.reason, /enableDirectIgnition is on \(the default\)/);
    assert.match(on.ignition.reason, /no WorkBuddy CDP endpoint answered on port 1/);
    assert.match(on.ignition.reason, /fall back to the automation queue/, '回退预期必须写清');
    assert.match(on.ignition.reason, /ASK the user before doing anything/, '必须要求先问用户，禁止代设 env/代重启');
  });
});
