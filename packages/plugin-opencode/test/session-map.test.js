/**
 * @file session/map.js（plugin-opencode 精简版）的单元面。
 *
 * ★ 护栏：全程只有**内存假 settings**（describe/update/mutate 三件套）——
 *   不碰磁盘、不碰任何真实用户目录（`~/.dsh` / `~/.workbuddy` / `~/.config/opencode` 一概不写）。
 *   假宿主故意比真 schema（`z.dict(z.any())`）**更严**：越界字段 / 坏类型**同步抛**
 *   ⇒ 把"写入前净化"这条纪律钉成回归测试（真机上等价形态 = 一条坏记录让整份 namespace 被拒）。
 *
 * ★ 覆盖面：sanitize 净化 / adopt 先写胜出与显式布尔 / lookup 的 id 形态闸 / touch 热度与粘滞位 /
 *   supersede·forget·purge 的降级链 / retention 200 / summary 上限 20 / sweep 只碰自建陈旧项 /
 *   落盘记账（noop·failed·pending）。
 *
 * 通道事实出处：`00-recon/OPENCODE-LOCAL-RECON-20261015.md`（§2 建会话 / §11.1 桌面可见 / §11 形状核验·硬删）。
 *
 * @module test/session-map
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_RETENTION,
  SESSION_SUMMARY_LIMIT,
  isResumableRecord,
  loadSessionMap,
  sanitizeRecord,
  sessionSummary,
  sweepOwnSessions,
  unresumableCode,
} from '../src/host/session/map.js';

const NS = 'dsh-plugin-opencode';

/** 实机样本（recon §11："dsh smoke" 那条会话）。 */
const SES_A = 'ses_ec039b26effeFSRxqFRSQfPfba';
/** 造样本（形态与实机一致：`ses_` + [A-Za-z0-9]+）。 */
const sid = (n) => `ses_${String(n).padStart(12, '0')}`;
const SES_B = sid(1);
const SES_C = sid(2);

/** 记账字段白名单 + 类型（假 schema：只有这些字段、只有这些类型能进 settings）。 */
const FIELD_TYPES = {
  sessionId: 'string',
  cwd: 'string',
  lastUsedAt: 'number',
  outputBytes: 'number',
  own: 'boolean',
  superseded: 'boolean',
  unconfirmed: 'boolean',
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 普通对象深度合并（与 `settings.update` 的实测语义同款：补丁里省略的字段保留旧值）。 */
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

/**
 * 内存 settings stub（对齐 dsh-settings 的关键语义：`describe()` 行形 `{ns, value}`、
 * `update` 深合并 + 校验、`mutate` 的 `unset`、真宿主的异步返回）。
 * `state` 直接可写 ⇒ 用例可以种入"用户手改坏"的记录（绕过本模块的净化）。
 */
function makeSettings({ async = false, reject = false, withMutate = true } = {}) {
  const state = { sessions: {} };
  const calls = { update: [], mutate: [] };
  const checkRecord = (key, record) => {
    for (const [field, value] of Object.entries(record)) {
      const want = FIELD_TYPES[field];
      if (want === undefined) throw new Error(`$.sessions.${key}.${field} unknown field`);
      if (typeof value !== want) throw new Error(`$.sessions.${key}.${field} expected ${want} but got ${typeof value}`);
    }
  };
  const finish = () => (reject
    ? Promise.reject(new Error('settings rejected the write'))
    : (async ? Promise.resolve(undefined) : undefined));
  const svc = {
    describe: () => [{ ns: NS, value: { sessions: structuredClone(state.sessions) } }],
    update: (ns, patch) => {
      calls.update.push({ ns, patch });
      for (const [key, record] of Object.entries(patch?.sessions ?? {})) checkRecord(key, record);
      deepMerge(state, { sessions: patch?.sessions ?? {} });
      return finish();
    },
    ...(withMutate ? {
      mutate: (ns, ops) => {
        calls.mutate.push({ ns, ops });
        for (const op of ops) {
          if (op?.op === 'unset' && Array.isArray(op.path) && op.path.length === 2 && op.path[0] === 'sessions') {
            delete state.sessions[op.path[1]];
          }
        }
        return finish();
      },
    } : {}),
  };
  return { svc, state, calls };
}

/** 假宿主 ctx（settings 可选缺席 —— 极简宿主形态必须能跑）。 */
const makeCtx = (settings) => ({ get: (name) => (name === 'settings' ? settings.svc : undefined) });
const bareCtx = () => ({ get: () => undefined });

test('S0 护栏：settings 面缺席也能装配（本套件不需要任何真实用户目录）', () => {
  const sessions = loadSessionMap(bareCtx(), NS);
  assert.equal(sessions.list().length, 0);
  assert.equal(sessions.summary().length, 0);
  assert.equal(sessions.read('k'), null);
  assert.equal(sessions.persistence().noop, 0);
});

test('S1 sanitizeRecord：坏类型字段一律丢弃（不拖垮整份 namespace），布尔 false 保真', () => {
  assert.deepEqual(
    sanitizeRecord({
      sessionId: 42, cwd: 7, lastUsedAt: 'now', outputBytes: -1,
      own: 'yes', superseded: 1, unconfirmed: null, junk: 'x',
    }),
    {},
  );
  assert.deepEqual(sanitizeRecord(null), {});
  // 布尔 false 是"清真"（深度合并下省略才是"保留旧值"）⇒ 必须原样留下。
  assert.deepEqual(
    sanitizeRecord({
      sessionId: SES_A, cwd: 'D:/repo', lastUsedAt: 1, outputBytes: 0,
      own: false, superseded: false, unconfirmed: false,
    }),
    {
      sessionId: SES_A, cwd: 'D:/repo', lastUsedAt: 1, outputBytes: 0,
      own: false, superseded: false, unconfirmed: false,
    },
  );
  // 形态不合法的 id（workbuddy 时代的 `conv-1` 之类）不认。
  assert.deepEqual(sanitizeRecord({ sessionId: 'conv-1' }), {});
  assert.deepEqual(sanitizeRecord({ sessionId: `${SES_A} ` }), {}, '尾随空格 = 形态不合法（不做 trim 猜测）');
});

test('S2 adopt：先写胜出 + 布尔键显式给值 + 补丁只动目标 key', () => {
  const settings = makeSettings();
  const sessions = loadSessionMap(makeCtx(settings), NS);

  const first = sessions.adopt('k1', { sessionId: SES_A, cwd: 'D:/repo', own: true });
  assert.deepEqual(
    { ok: first.ok, adopted: first.adopted, sessionId: first.sessionId, reason: first.reason, persistState: first.persistState },
    { ok: true, adopted: true, sessionId: SES_A, reason: '', persistState: 'attempted' },
    '同步假宿主 ⇒ attempted',
  );

  const patch = settings.calls.update[0].patch;
  assert.deepEqual(Object.keys(patch), ['sessions'], '补丁顶层只有 sessions');
  assert.deepEqual(Object.keys(patch.sessions), ['k1'], '★ 深合并补丁只动目标 key');
  const record = patch.sessions.k1;
  assert.deepEqual(
    Object.keys(record).sort(),
    ['cwd', 'lastUsedAt', 'outputBytes', 'own', 'sessionId', 'superseded', 'unconfirmed'],
  );
  assert.equal(record.sessionId, SES_A);
  assert.equal(record.cwd, 'D:/repo');
  assert.equal(record.own, true);
  assert.equal(record.superseded, false, '★ 判死位必须显式给值：省略 = 保留旧值 ⇒ 健康会话被永久判死');
  assert.equal(record.unconfirmed, false);
  assert.equal(typeof record.lastUsedAt, 'number');

  // ★ 先写胜出：不同 id 一律拒绝，既有记录不动、也不写盘。
  const conflict = sessions.adopt('k1', { sessionId: SES_B, own: true });
  assert.deepEqual(
    {
      ok: conflict.ok, adopted: conflict.adopted, sessionId: conflict.sessionId,
      reason: conflict.reason, persistState: conflict.persistState,
    },
    { ok: false, adopted: false, sessionId: SES_A, reason: 'first-write-wins', persistState: 'noop' },
  );
  assert.equal(sessions.read('k1').sessionId, SES_A);
  assert.equal(settings.calls.update.length, 1, '拒绝路径不写盘');

  // 同一个 id 重复 adopt ⇒ 幂等 no-op（不写盘）。
  const again = sessions.adopt('k1', { sessionId: SES_A });
  assert.deepEqual(
    { ok: again.ok, adopted: again.adopted, reason: again.reason, persistState: again.persistState },
    { ok: true, adopted: false, reason: 'already-recorded', persistState: 'noop' },
  );
  assert.equal(settings.calls.update.length, 1);

  // 第二条 key：补丁只含它自己，k1 的记录逐字段不动。
  const snapshot = structuredClone(settings.state.sessions.k1);
  assert.equal(sessions.adopt('k2', { sessionId: SES_C }).ok, true);
  assert.deepEqual(Object.keys(settings.calls.update[1].patch.sessions), ['k2']);
  assert.deepEqual(settings.state.sessions.k1, snapshot, '★ 深合并只动目标 key');

  // 坏 id / 空 key ⇒ 拒绝，不写盘、不造记录。
  assert.equal(sessions.adopt('k3', { sessionId: 'conv-1' }).reason, 'malformed-session-id');
  assert.equal(sessions.adopt('', { sessionId: SES_A }).reason, 'empty-session-key');
  assert.equal(sessions.read('k3'), null);
  assert.equal(settings.calls.update.length, 2);

  // 判死之后允许接管（supersede 语义），并把两个位显式清真；own 粘滞。
  assert.equal(sessions.supersede('k1').ok, true);
  const taken = sessions.adopt('k1', { sessionId: SES_B });
  assert.equal(taken.ok, true);
  assert.equal(taken.adopted, true);
  assert.equal(sessions.read('k1').superseded, false, '★ 接管必须显式清真判死位');
  assert.equal(sessions.read('k1').unconfirmed, false);
  assert.equal(sessions.read('k1').own, true, 'own 粘滞：接管后仍算自建（回收判据）');
  assert.equal(sessions.resumable('k1').sessionId, SES_B);
});

test('S3 lookup：只认 SESSION_ID_PATTERN 合法 id；坏记录当"无可用 id"（不崩、不猜）', () => {
  const settings = makeSettings();
  // 用户手改 / 老版本留下的坏记录：直接种进 settings 用户层（绕过本模块的写入净化）。
  settings.state.sessions.bad = { sessionId: 'conv-1', lastUsedAt: 5, own: true };
  settings.state.sessions.junk = 'not-a-record';
  settings.state.sessions.ok = { sessionId: SES_A, lastUsedAt: 9 };
  const sessions = loadSessionMap(makeCtx(settings), NS);

  assert.equal(sessions.lookup('bad'), null, '★ 形态不合法的 id 不算"记得"');
  assert.equal(sessions.read('bad').sessionId, null, '但记录本身可读（历史留痕）');
  assert.equal(sessions.resumable('bad'), null);
  assert.equal(unresumableCode(sessions.read('bad')), 'untracked');
  assert.equal(isResumableRecord(sessions.read('bad')), false);
  assert.equal(sessions.read('junk'), null, '非对象记录当没记过');
  assert.equal(sessions.lookup('ok').sessionId, SES_A);
  assert.equal(sessions.lookup('missing'), null);
  assert.equal(sessions.read(''), null);
  assert.equal(sessions.lookup(''), null);

  const rows = sessions.summary();
  assert.deepEqual(
    rows.map((r) => [r.sessionKey, r.state]),
    [['ok', 'resumable'], ['bad', 'untracked']],
    '摘要行只含对象记录，状态码与 unresumableCode 同源',
  );
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    ['lastUsedAt', 'own', 'sessionId', 'sessionKey', 'state'],
    '行形状 = types/index.js 的 SessionSummaryRow',
  );
});

test('S4 touch：热度推进、id 不变、判死位粘滞；缺 key 安全 no-op', async () => {
  const settings = makeSettings({ async: true });
  const sessions = loadSessionMap(makeCtx(settings), NS);
  sessions.adopt('k1', { sessionId: SES_A, cwd: 'D:/repo', own: true });
  await sessions.settled();
  const before = sessions.read('k1');

  const touched = sessions.touch('k1');
  assert.deepEqual(
    { ok: touched.ok, persistState: touched.persistState, persistError: touched.persistError },
    { ok: true, persistState: 'pending', persistError: '' },
    '异步假宿主 ⇒ pending（写盘不阻塞调用方）',
  );
  const after = sessions.read('k1');
  assert.ok(after.lastUsedAt >= before.lastUsedAt, '★ 热度戳必须推进');
  assert.equal(after.sessionId, SES_A, 'touch 不换 id');
  assert.equal(after.cwd, 'D:/repo');
  assert.equal(after.own, true);
  const touchPatch = settings.calls.update.at(-1).patch.sessions.k1;
  assert.equal(touchPatch.sessionId, SES_A);
  assert.equal(touchPatch.own, true);
  assert.equal(touchPatch.superseded, false, '补丁里布尔键显式给值');
  assert.equal(touchPatch.unconfirmed, false);
  await sessions.settled();
  assert.equal(sessions.persistence().failures, 0);

  // 补丁后置合并（同键以补丁为准）；坏类型/未知字段被净化丢弃。
  assert.equal(sessions.touch('k1', { outputBytes: 123, sessionId: 42, junk: 'x' }).ok, true);
  const merged = sessions.read('k1');
  assert.equal(merged.outputBytes, 123, '补丁字段生效');
  assert.equal(merged.sessionId, SES_A, '★ 坏类型补丁（id=42）被丢弃 ⇒ 旧 id 保留');
  assert.equal(merged.junk, undefined, '未知字段被丢弃');

  // ★ touch 不得洗白判死位（否则死会话被下一轮"保鲜"救活）。
  sessions.supersede('k1');
  sessions.touch('k1');
  assert.equal(sessions.read('k1').superseded, true);
  assert.equal(sessions.resumable('k1'), null);

  // 缺 key ⇒ 安全 no-op：不造空壳、不落盘。
  const updatesBefore = settings.calls.update.length;
  assert.deepEqual(
    { ok: sessions.touch('never').ok, persistState: sessions.touch('never').persistState },
    { ok: false, persistState: 'no_record' },
  );
  assert.equal(sessions.read('never'), null, '绝不凭空造记录');
  assert.equal(settings.calls.update.length, updatesBefore, '不落盘');
  assert.equal(sessions.touch('').persistState, 'failed');
});

test('S5 supersede/forget：保留历史 id、停止自动续接；缺 key no_record', () => {
  const settings = makeSettings();
  const sessions = loadSessionMap(makeCtx(settings), NS);
  sessions.adopt('k1', { sessionId: SES_A });
  assert.equal(sessions.resumable('k1').sessionId, SES_A);

  const ruled = sessions.supersede('k1', 'server-404');
  assert.deepEqual(
    { ok: ruled.ok, reason: ruled.reason, persistState: ruled.persistState },
    { ok: true, reason: 'server-404', persistState: 'attempted' },
  );
  assert.equal(sessions.resumable('k1'), null, '★ 判死后不再自动续接');
  assert.equal(sessions.read('k1').sessionId, SES_A, 'id 留作历史留痕（清空会丢掉"曾经接过哪条"）');
  assert.equal(sessions.read('k1').superseded, true);
  assert.equal(settings.calls.update.at(-1).patch.sessions.k1.superseded, true, '补丁显式置真');

  assert.equal(sessions.supersede('missing').persistState, 'no_record');
  assert.equal(sessions.read('missing'), null, '不造空壳');
  assert.equal(sessions.supersede('').persistState, 'failed');

  // forget ≡ supersede（reason 透传；非法 reason 回退默认，不炸）。
  sessions.adopt('k2', { sessionId: SES_B });
  assert.equal(sessions.forget('k2', 'ERR_OPENCODE_HTTP_404').ok, true);
  assert.equal(sessions.resumable('k2'), null);
  assert.equal(sessions.read('k2').sessionId, SES_B);
  sessions.adopt('k3', { sessionId: SES_C });
  assert.equal(sessions.forget('k3', 42).ok, true);
  assert.equal(sessions.forget('never').persistState, 'no_record');
  assert.equal(sessions.forget('').persistState, 'failed');
});

test('S6 purge：deleted / tombstoned / memory-only 降级链，各自如实回报', () => {
  // ① mutate 可用 ⇒ 真删（settings 用户层里也不留）。
  const s1 = makeSettings();
  const a = loadSessionMap(makeCtx(s1), NS);
  a.adopt('k1', { sessionId: SES_A });
  const r1 = a.purge('k1');
  assert.deepEqual({ ok: r1.ok, mode: r1.mode }, { ok: true, mode: 'deleted' });
  assert.equal(a.read('k1'), null);
  assert.deepEqual(s1.calls.mutate[0].ops, [{ op: 'unset', path: ['sessions', 'k1'] }]);
  assert.equal('k1' in s1.state.sessions, false, '★ settings 用户层里真删了');
  assert.deepEqual({ ok: a.purge('k1').ok, mode: a.purge('k1').mode }, { ok: false, mode: 'no_record' });

  // ② 没有 mutate ⇒ 退化为 tombstone（记录还在、历史可查，但不再自动续接）。
  const s2 = makeSettings({ withMutate: false });
  const b = loadSessionMap(makeCtx(s2), NS);
  b.adopt('k2', { sessionId: SES_B });
  const r2 = b.purge('k2');
  assert.deepEqual({ ok: r2.ok, mode: r2.mode }, { ok: true, mode: 'tombstoned' });
  assert.equal(b.resumable('k2'), null);
  assert.equal(b.read('k2').sessionId, SES_B, 'tombstone：历史 id 仍在 settings 里');
  assert.equal(s2.state.sessions.k2.superseded, true);

  // ③ 连 settings 服务都没有 ⇒ 只清内存（重启后旧记录会回来 —— 如实说）。
  const bare = loadSessionMap(bareCtx(), NS);
  bare.adopt('k3', { sessionId: SES_C });
  const r3 = bare.purge('k3');
  assert.deepEqual({ ok: r3.ok, mode: r3.mode }, { ok: true, mode: 'memory-only' });
  assert.equal(bare.read('k3'), null);
  assert.equal(bare.persistence().noop, 2, 'adopt + purge 两次都没能落盘（如实记账）');

  assert.equal(loadSessionMap(bareCtx(), NS).purge('').mode, 'no_record', '空 key 不造写');
});

test('S7 retention 200：内存窗口淘汰最旧；summary 上限 20 条', () => {
  // 无 settings 服务 ⇒ 只有内存一层，窗口行为可直接观察。
  const bare = loadSessionMap(bareCtx(), NS);
  for (let i = 0; i <= SESSION_RETENTION; i += 1) {
    assert.equal(bare.adopt(`k${String(i)}`, { sessionId: sid(i) }).ok, true);
  }
  assert.equal(bare.list().length, SESSION_RETENTION, '★ 内存窗口 = 200 条');
  assert.equal(bare.read('k0'), null, '最旧的一条被淘汰');
  assert.equal(bare.read(`k${String(SESSION_RETENTION)}`).sessionId, sid(SESSION_RETENTION), '最新的一条还在');

  // summary：默认封顶 SESSION_SUMMARY_LIMIT，调用方可收窄；读失败/缺面一律空数组。
  const many = loadSessionMap(bareCtx(), NS);
  for (let i = 0; i < 25; i += 1) many.adopt(`m${String(i)}`, { sessionId: sid(1000 + i) });
  assert.equal(SESSION_SUMMARY_LIMIT, 20);
  assert.equal(many.summary().length, SESSION_SUMMARY_LIMIT);
  assert.equal(many.summary(5).length, 5);
  assert.equal(sessionSummary(many, 3).length, 3);
  assert.deepEqual(sessionSummary(null), []);
  assert.deepEqual(sessionSummary({}), []);
  assert.deepEqual(sessionSummary({ list() { throw new Error('reading failed'); } }), [], '读失败不得带崩调用方');
});

test('S8 sweepOwnSessions：只回收 own 且陈旧的；不碰未标记 own / 受保护的会话', () => {
  const settings = makeSettings();
  const sessions = loadSessionMap(makeCtx(settings), NS);
  const now = 1_800_000_000_000;
  const old = now - 30 * 24 * 3600 * 1000;

  sessions.adopt('own-stale', { sessionId: SES_A, own: true });
  sessions.touch('own-stale', { lastUsedAt: old });
  sessions.adopt('own-fresh', { sessionId: SES_B, own: true });
  sessions.touch('own-fresh', { lastUsedAt: now - 1000 });
  sessions.adopt('not-own-stale', { sessionId: SES_C }); // 用户自己的（未标 own）
  sessions.touch('not-own-stale', { lastUsedAt: old });
  sessions.adopt('own-dead', { sessionId: sid(7), own: true });
  sessions.supersede('own-dead');
  sessions.adopt('own-bound', { sessionId: sid(8), own: true });
  sessions.touch('own-bound', { lastUsedAt: old });

  const swept = sweepOwnSessions(sessions, { now, maxAgeMs: 7 * 24 * 3600 * 1000, boundSessionId: sid(8) });
  assert.equal(swept.scanned, 5);
  assert.equal(swept.own, 4, '只数 own:true 的条目');
  assert.deepEqual(swept.swept, ['own-stale']);
  assert.deepEqual(swept.kept, ['own-fresh']);
  assert.deepEqual(swept.dead, ['own-dead'], '已判死的只计数，不再动');
  assert.deepEqual(swept.protected, ['own-bound'], '★ 用户绑定的会话绝不回收');

  assert.equal(sessions.read('own-stale').superseded, true, '回收 = 标 superseded（保留历史 id）');
  assert.equal(sessions.read('own-stale').sessionId, SES_A);
  assert.equal(sessions.resumable('own-stale'), null);
  assert.equal(sessions.read('not-own-stale').superseded, false, '★ 未标 own 的条目一根手指都不碰');
  assert.equal(sessions.read('not-own-stale').lastUsedAt, old);
  assert.equal(sessions.read('own-fresh').superseded, false);
  assert.equal(sessions.read('own-bound').superseded, false);

  // 条数窗（opts.maxCount）：own 活记录超出 N 条 ⇒ 最旧的同样回收（哪怕还在时间窗内）。
  const s2 = makeSettings();
  const b = loadSessionMap(makeCtx(s2), NS);
  b.adopt('a', { sessionId: SES_A, own: true });
  b.touch('a', { lastUsedAt: now - 2000 });
  b.adopt('b', { sessionId: SES_B, own: true });
  b.touch('b', { lastUsedAt: now - 100 });
  const byCount = sweepOwnSessions(b, { now, maxAgeMs: 365 * 24 * 3600 * 1000, maxCount: 1 });
  assert.deepEqual(byCount.swept, ['a'], '★ 条数窗留下最新的一条，最旧的回收');
  assert.deepEqual(byCount.kept, ['b']);
});

test('S9 落盘记账：无 settings = noop、异步拒绝 = 记账不阻塞、同步抛 = failed', async () => {
  // ① 无 settings 服务 ⇒ noop（本进程内可续接，重启后丢失 —— 如实说）。
  const bare = loadSessionMap({ get: () => null }, NS);
  const r0 = bare.adopt('k', { sessionId: SES_A });
  assert.equal(r0.ok, true);
  assert.equal(r0.persistState, 'noop');
  assert.equal(bare.persistence().noop, 1);
  assert.equal(bare.persistence().lastError, 'settings.update unavailable');

  // ② 异步拒绝（真宿主的常见形态：写不进去）⇒ 调用方不被阻塞，失败落进记账。
  const s1 = makeSettings({ async: true, reject: true });
  const a = loadSessionMap(makeCtx(s1), NS);
  const r1 = a.adopt('k', { sessionId: SES_A });
  assert.equal(r1.persistState, 'pending', '★ 提交是异步的：此刻还没收敛');
  assert.equal(a.persistence().failures, 0);
  const settled = await a.settled();
  assert.equal(settled.failures, 1);
  assert.equal(settled.lastFailure.key, 'k');
  assert.equal(typeof settled.lastFailure.error, 'string');
  assert.equal(a.read('k').sessionId, SES_A, '内存态不受落盘失败影响（本进程内仍可续接）');

  // ③ update 同步抛 ⇒ failed（此刻就知道写不进去），成因逐字回传。
  const s2 = makeSettings();
  const b = loadSessionMap(makeCtx(s2), NS);
  s2.svc.update = () => { throw new Error('settings rejected the write (namespace is not writable)'); };
  const r2 = b.adopt('k', { sessionId: SES_A });
  assert.equal(r2.persistState, 'failed');
  assert.match(r2.persistError, /not writable/);
  assert.equal(b.persistence().failures, 1);
  assert.equal(b.persistence().lastFailure.key, 'k');
});
