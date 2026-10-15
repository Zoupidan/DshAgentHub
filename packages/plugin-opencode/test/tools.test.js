/**
 * 工具面测试 —— 4 个工具的闸门、作业接线（jobs.start 的 {cancel, done, readOutput}）、
 * 以及收敛器 `reconcileTools` 的 U4 语义（OFF 一处不注册 / 原子注册 / 探测落地收敛）。
 *
 * 全部离线：dispatch 与 runtime 均为测试桩；不触网、不读写真实家目录。
 *
 * @module test/tools.test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeApprovalsTool } from '../src/host/tools/approvals.js';
import { reconcileTools } from '../src/host/tools/index.js';
import { IN_FLIGHT_STATES, LAST_RUN_STATES, projectLastRun, projectRunRecord } from '../src/host/launch/in-flight-states.js';
import { makePurgeTool } from '../src/host/tools/purge.js';
import { makeRunTool } from '../src/host/tools/run.js';
import { makeStatusTool } from '../src/host/tools/status.js';

// ─────────────────────────── 桩 ───────────────────────────

function makeRuntime({ config = {}, probe = null, inFlight = [] } = {}) {
  let registry = 'UNKNOWN';
  let registrationError = null;
  let detected = probe;
  let last = null;
  const detectedListeners = new Set();
  return {
    current: () => config,
    currentConfig: () => config,
    setSource() {},
    detected: () => detected,
    probeArgs: () => null,
    async probe() { return detected; },
    async awaitDetection() { return detected; },
    async reprobe() { return detected; },
    probeState() {
      return detected === null
        ? { status: 'idle', result: null, pendingReason: 'detection-not-started' }
        : { status: 'done', result: detected, pendingReason: '' };
    },
    onDetected(cb) { detectedListeners.add(cb); return () => detectedListeners.delete(cb); },
    fireDetected(p) { detected = p; for (const cb of [...detectedListeners]) cb(); },
    setRegistry(s) { registry = s; },
    registry: () => registry,
    setRegistrationError(e) { registrationError = e; },
    registrationError: () => registrationError,
    acquireWorkspaceLock: () => true,
    releaseWorkspaceLock() { this._released = (this._released ?? 0) + 1; },
    start(jobId, handle) { this._started = { jobId, handle }; },
    finish(jobId, code) { this._finished = { jobId, code }; },
    forget(jobId) { this._forgotten = jobId; },
    noteRun(rec) { last = rec; },
    lastRun: () => last,
    inFlight: () => inFlight.map((r) => ({ ...r })),
  };
}

function makeCtx() {
  const sctxs = [];
  const ctx = {
    registered: [],
    disposed: [],
    effects: [],
    tools: {
      register(def) {
        ctx.registered.push(def.name);
        return () => ctx.disposed.push(def.name);
      },
    },
    effect(fn, label) { ctx.effects.push({ label, cleanup: fn() }); },
    inject(deps, cb) {
      const cleanups = [];
      const listeners = [];
      const sctx = {
        settings: { configure() {} },
        fiber: { config: {} },
        effect(fn) { const c = fn(); if (typeof c === 'function') cleanups.push(c); return () => {}; },
        on(name, fn) { listeners.push([name, fn]); return () => {}; },
        emit(name) { for (const [n, fn] of listeners) if (n === name) fn(); },
        dispose() { for (const c of cleanups) c(); },
      };
      sctxs.push(sctx);
      const ret = cb(sctx);
      return { dispose: () => { if (typeof ret === 'function') ret(); sctx.dispose(); } };
    },
    logger: { warn() {}, info() {} },
    fiber: { config: {} },
  };
  return { ctx, sctxs };
}

function makeJobsCtx() {
  const captured = { spec: null, handle: null };
  return {
    captured,
    ctx: {
      jobs: {
        start(spec) {
          captured.spec = spec;
          captured.handle = spec.run();
          return 'job_test_1';
        },
      },
    },
  };
}

const OUTCOME_OK = {
  ok: true,
  reason: 'ok',
  reasonText: '',
  reasonEvidence: '',
  sessionId: 'ses_1',
  sessionKey: 'k1',
  sessionOrigin: 'new',
  resumed: false,
  fallbackReason: null,
  model: { providerID: 'opencode', id: 'm1', variant: '' },
  promptExcerpt: 'do things',
  delivery: 'queue',
  acceptedAt: 1000,
  idleAt: 2000,
  waitStatus: 'idle-204',
  outcome: 'succeeded',
  reply: 'done!',
  replyTruncated: false,
  cost: 0.5,
  tokens: { input: 1, output: 2, reasoning: 0 },
  permissionRequests: [],
  permissionsError: null,
  version: '2.0.28',
  text: 'done!',
  at: 3000,
};

// ─────────────────── opencode_run：闸门 ───────────────────

test('run 工具：总闸 OFF ⇒ 拒绝（enabled 是硬闸）', async () => {
  const runtime = makeRuntime({ config: { enabled: false }, probe: { installed: true } });
  const tool = makeRunTool(runtime, {}, () => ({ enabled: false }), makeJobsCtx().ctx, {});
  await assert.rejects(() => tool.execute({ prompt: 'x' }), /switched OFF/);
});

test('run 工具：探测未落地 ⇒ 拒绝并指向 opencode_status', async () => {
  const runtime = makeRuntime({ config: { enabled: true }, probe: null });
  const tool = makeRunTool(runtime, {}, () => ({ enabled: true }), makeJobsCtx().ctx, {});
  await assert.rejects(() => tool.execute({ prompt: 'x' }), /no availability detection has completed/);
});

test('run 工具：服务缺失 ⇒ 拒绝（含 reason 证据）', async () => {
  const runtime = makeRuntime({ config: { enabled: true }, probe: { installed: false, reason: 'service-missing' } });
  const tool = makeRunTool(runtime, {}, () => ({ enabled: true }), makeJobsCtx().ctx, {});
  await assert.rejects(() => tool.execute({ prompt: 'x' }), /service was not found \(reason: service-missing\)/);
});

test('run 工具：工作区忙 ⇒ ERR_WORKSPACE_BUSY', async () => {
  const runtime = makeRuntime({ config: { enabled: true }, probe: { installed: true } });
  runtime.acquireWorkspaceLock = () => false;
  const tool = makeRunTool(runtime, {}, () => ({ enabled: true }), makeJobsCtx().ctx, {});
  await assert.rejects(
    () => tool.execute({ prompt: 'x', session_key: 'k1' }),
    (err) => err.code === 'ERR_WORKSPACE_BUSY',
  );
});

test('run 工具：空 prompt 且非 wait_only ⇒ 拒绝；wait_only 无目标 ⇒ 拒绝', async () => {
  const runtime = makeRuntime({ config: { enabled: true }, probe: { installed: true } });
  const tool = makeRunTool(runtime, {}, () => ({ enabled: true }), makeJobsCtx().ctx, {});
  await assert.rejects(() => tool.execute({ prompt: '   ' }), /non-empty string/);
  await assert.rejects(() => tool.execute({ prompt: '', wait_only: true }), /wait_only needs a target/);
});

// ─────────────────── opencode_run：作业接线 ───────────────────

test('run 工具：作业接线（完成路径）——返回值键集、noteRun 记账、锁释放', async () => {
  const config = { enabled: true, model: '', variant: '', workspace: 'D:/ws' };
  const runtime = makeRuntime({ config, probe: { installed: true } });
  const { ctx, captured } = makeJobsCtx();
  const dispatch = { run: async (args, hooks) => { hooks.onPhase?.('prompting'); hooks.onPhase?.('waiting'); return { ...OUTCOME_OK }; } };
  const tool = makeRunTool(runtime, makeSessionsStub(), () => config, ctx, dispatch);

  const ret = await tool.execute({ prompt: 'do things', session_key: 'k1' });
  assert.deepEqual(Object.keys(ret).sort(), ['job_id', 'session_id', 'session_key', 'transport', 'wait_only']);
  assert.equal(ret.job_id, 'job_test_1');
  assert.equal(ret.session_key, 'k1');
  assert.equal(ret.wait_only, false);
  assert.match(ret.transport, /transport=local-http/);

  const settled = await captured.handle.done;
  assert.equal(settled.status, 'completed');
  assert.equal(settled.reply, 'done!');
  assert.equal(runtime._finished.code, 0);
  assert.equal(runtime._forgotten, 'job_test_1');
  assert.equal(runtime._released, 1, '锁必须释放');

  const rec = runtime.lastRun();
  assert.equal(rec.sessionId, 'ses_1');
  assert.equal(rec.sessionKey, 'k1');
  assert.equal(rec.outcome, 'succeeded');
  assert.equal(rec.waitStatus, 'idle-204');
  assert.equal(rec.reasonCode, 'ok');
  assert.equal(rec.cost, 0.5);
  assert.equal(rec.reply, 'done!');
  assert.equal(rec.at, 3000);

  const output = captured.handle.readOutput();
  assert.match(output, /transport=local-http/);
  assert.match(output, /\[ok\]/);
  assert.match(output, /done!/);
});

test('run 工具：wait_timeout ⇒ still_running（exit 0），noteRun 归一在途原因', async () => {
  const config = { enabled: true };
  const runtime = makeRuntime({ config, probe: { installed: true } });
  const { ctx, captured } = makeJobsCtx();
  const dispatch = {
    run: async () => ({
      ...OUTCOME_OK,
      ok: false,
      reason: 'wait_timeout',
      reasonText: '等待超时',
      reply: '',
      text: '',
      outcome: null,
      cost: null,
      tokens: null,
      waitStatus: 'timeout',
    }),
  };
  const tool = makeRunTool(runtime, makeSessionsStub(), () => config, ctx, dispatch);
  await tool.execute({ prompt: 'slow task', session_key: 'k1' });
  const settled = await captured.handle.done;
  assert.equal(settled.status, 'still_running');
  assert.equal(runtime._finished.code, 0);
  assert.equal(runtime.lastRun().reasonCode, 'wait_timeout');
  assert.equal(runtime.lastRun().reply, '');
  const output = captured.handle.readOutput();
  assert.match(output, /\[still_running\]/);
  assert.match(output, /同一会话再等可拿回执/);
});

test('run 工具：硬失败 ⇒ failed（exit -1）；审批待批 ⇒ still_running + 指引', async () => {
  const config = { enabled: true };
  const runtime = makeRuntime({ config, probe: { installed: true } });
  const j1 = makeJobsCtx();
  const dispatchFail = { run: async () => ({ ...OUTCOME_OK, ok: false, reason: 'task_failed', reasonEvidence: 'stop', reply: '', text: '', outcome: 'failed' }) };
  const tool1 = makeRunTool(runtime, makeSessionsStub(), () => config, j1.ctx, dispatchFail);
  await tool1.execute({ prompt: 'x', session_key: 'k1' });
  const s1 = await j1.captured.handle.done;
  assert.equal(s1.status, 'failed');
  assert.equal(runtime._finished.code, -1);

  const j2 = makeJobsCtx();
  const dispatchAp = {
    run: async () => ({
      ...OUTCOME_OK,
      ok: false,
      reason: 'approval_pending',
      reply: '',
      text: '',
      outcome: null,
      waitStatus: 'idle-204',
      permissionRequests: [{ requestID: 'r1', action: 'bash', save: false, sourceType: 'tool', sourceID: 't1', messageID: 'm1' }],
    }),
  };
  const tool2 = makeRunTool(runtime, makeSessionsStub(), () => config, j2.ctx, dispatchAp);
  await tool2.execute({ prompt: 'y', session_key: 'k1' });
  const s2 = await j2.captured.handle.done;
  assert.equal(s2.status, 'still_running');
  assert.match(j2.captured.handle.readOutput(), /待批/);
  assert.equal(runtime.lastRun().permissionRequests[0].requestID, 'r1');
  assert.equal(runtime.lastRun().permissionRequests[0].state, 'pending');
});

function makeSessionsStub() {
  return {
    lookup: () => null,
    touch: () => true,
    adopt: () => ({ ok: true }),
    forget: () => false,
    summary: () => [],
  };
}

// ─────────────────── 其它工具的对外面 ───────────────────

test('status 工具：探测证据 / 模型 / 记性 / 最近回执 / 待批计数', async () => {
  const last = {
    sessionId: 'ses_1',
    sessionKey: 'k1',
    resumed: false,
    outcome: 'succeeded',
    waitStatus: 'idle-204',
    reasonCode: 'ok',
    reasonText: '',
    reasonEvidence: '',
    cost: 0.5,
    model: { providerID: 'opencode', id: 'm1', variant: 'high' },
    reply: 'done!',
    permissionRequests: [{ requestID: 'r1', action: 'bash', source: 'tool:t1', state: 'pending', decision: '' }],
  };
  const runtime = makeRuntime({ config: { enabled: true }, probe: { installed: true, reason: 'ok', version: '2.0.28', pid: 1, baseUrl: 'http://127.0.0.1:1', evidence: [{ target: 'a', detail: 'ok' }] } });
  runtime.setRegistry('REGISTERED');
  runtime.noteRun(last);
  const sessions = makeSessionsStub();
  const dispatch = {
    models: async () => ({
      ok: true,
      models: [{ id: 'm1', providerID: 'opencode', variants: ['low', 'high'], isFree: true, enabled: true, status: '' }],
      source: 'http://127.0.0.1:1',
    }),
  };
  const tool = makeStatusTool(runtime, sessions, () => ({ enabled: true }), dispatch);
  const ret = await tool.execute({});
  assert.match(ret.text, /service: OK · version=2\.0\.28/);
  assert.match(ret.text, /opencode\/m1 \[free\] · variants: low\/high/);
  assert.match(ret.text, /last run: .*outcome=succeeded/);
  assert.match(ret.text, /approvals: 1 pending/);
});

// ─────────── 在途四态投影（用户口径 2026-10-15：下发中/执行中/压缩中/已结束） ───────────
//   映射依据与「压缩中」无信号调查结论 = src/host/launch/in-flight-states.js 文件头（含行号）。

test('projectRunRecord：已知 phase 全表映射；未知值绝不硬塞成压缩中/已结束', () => {
  const now = 1_000_000;
  const at = (phase) => projectRunRecord({ sessionKey: 'k', sessionId: 's', startedAt: now - 5_000, phase }, now);

  // 下发中 —— dispatch.js:361/368/391/436/455（'' = 首个 phase 未到；run.js:169）
  for (const phase of ['', 'connecting', 'resolving-session', 'creating-session', 'setting-model', 'prompting']) {
    assert.equal(at(phase).state, IN_FLIGHT_STATES.DISPATCHING, `phase=${phase} 应为下发中`);
    assert.equal(at(phase).label, '下发中');
  }
  // 执行中 —— dispatch.js:238('waiting')/272('receipt')；'fetching-receipt' 是文档别名（types/index.js:48）
  for (const phase of ['waiting', 'receipt', 'fetching-receipt']) {
    assert.equal(at(phase).state, IN_FLIGHT_STATES.RUNNING, `phase=${phase} 应为执行中`);
    assert.equal(at(phase).label, '执行中');
  }
  // 未知值：如实说"未知"并原样回传 phase（不吞原文）
  const weird = at('some-future-phase');
  assert.equal(weird.state, IN_FLIGHT_STATES.UNKNOWN);
  assert.equal(weird.label, '未知');
  assert.equal(weird.phase, 'some-future-phase');

  // ★ 硬红线：「压缩中」当前没有可观察信号（调查结论见模块注释）⇒ 现有任何 phase 都不得映射到它；
  //   在途记录也绝不许显示成"已结束"（run.js:229-230 收敛即 forget，表里必为未结束）。
  for (const phase of ['', 'connecting', 'resolving-session', 'creating-session', 'setting-model', 'prompting', 'waiting', 'receipt', 'fetching-receipt', 'some-future-phase']) {
    assert.notEqual(projectRunRecord({ phase }, now).state, IN_FLIGHT_STATES.COMPACTING, `phase=${phase} 不得冒充压缩中`);
    assert.notEqual(projectRunRecord({ phase }, now).state, IN_FLIGHT_STATES.FINISHED, `phase=${phase} 不得冒充已结束`);
  }

  // 时长回传：有界、时钟回拨夹 0、坏值 null（不猜）
  const row = at('waiting');
  assert.equal(row.waitedMs, 5_000);
  assert.equal(row.sessionKey, 'k');
  assert.equal(row.sessionId, 's');
  assert.equal(projectRunRecord({ phase: 'waiting', startedAt: now + 999 }, now).waitedMs, 0);
  assert.equal(projectRunRecord({ phase: 'waiting' }, now).waitedMs, null);
});

test('projectLastRun：终态回执才算已结束；超时/无回执/未受理各有其位（no receipt ≠ finished）', () => {
  assert.equal(projectLastRun(null).state, LAST_RUN_STATES.NONE);

  // 终态回执三值（idle-204 + 结构化 outcome；与 judge()/receiptView 同源，见模块注释）
  for (const outcome of ['succeeded', 'failed', 'interrupted']) {
    const v = projectLastRun({ waitStatus: 'idle-204', outcome, reasonCode: outcome === 'succeeded' ? 'ok' : 'task_failed' });
    assert.equal(v.finished, true, `outcome=${outcome} 有终态回执 ⇒ 已结束`);
    assert.equal(v.note, '');
  }
  // 等待超时：即使服务端那一刻仍挂着旧 succeeded（新鲜度闸后 outcome=null），也绝不认已结束
  const timeout = projectLastRun({ waitStatus: 'timeout', outcome: null, reasonCode: 'wait_timeout' });
  assert.equal(timeout.state, LAST_RUN_STATES.RUNNING);
  assert.equal(timeout.finished, false);
  assert.match(timeout.note, /no receipt ≠ finished/);
  // 取消同理
  assert.equal(projectLastRun({ waitStatus: 'aborted', outcome: null, reasonCode: 'wait_aborted' }).state, LAST_RUN_STATES.RUNNING);
  // idle-204 但无终态回执（receipt_missing）⇒ 不许把"空转"折成"结束"
  const idleNoReceipt = projectLastRun({ waitStatus: 'idle-204', outcome: null, reasonCode: 'receipt_missing' });
  assert.equal(idleNoReceipt.state, LAST_RUN_STATES.UNRESOLVED);
  assert.equal(idleNoReceipt.finished, false);
  assert.match(idleNoReceipt.note, /no receipt ≠ finished/);
  // 停在审批：判为"未结束"（judge 把它排在最前；回复后可续等）
  const stuck = projectLastRun({ waitStatus: 'idle-204', outcome: null, reasonCode: 'approval_pending' });
  assert.equal(stuck.state, LAST_RUN_STATES.RUNNING);
  assert.match(stuck.note, /stopped at an approval/);
  // 任务根本没被受理（下发面失败）⇒ not-started，不存在"未结束的任务"
  assert.equal(projectLastRun({ waitStatus: null, outcome: null, reasonCode: 'prompt_rejected' }).state, LAST_RUN_STATES.NOT_STARTED);
  // ★ 双保险：outcome 有值但 waitStatus 不是 idle-204（理论上会被 receiptView 拦掉）⇒ 仍不认已结束
  assert.equal(projectLastRun({ waitStatus: 'timeout', outcome: 'succeeded', reasonCode: 'ok' }).finished, false);
});

test('status 工具：在途明细逐条 —— key/id 短形 + 四态标签 + 已等待时长；在途必非已结束', async () => {
  const runtime = makeRuntime({
    config: { enabled: true },
    probe: { installed: true, reason: 'ok' },
    inFlight: [
      { sessionKey: 'k1', sessionId: '', startedAt: Date.now() - 12_000, phase: 'creating-session' },
      { sessionKey: 'dir:d:/very/long/workspace/path', sessionId: 'ses_ec039b26effeFSRxqFRSQfPfba', startedAt: Date.now() - 65_000, phase: 'waiting' },
      { sessionKey: 'k3', sessionId: 'ses_live03', startedAt: Date.now() - 1_000, phase: 'some-future-phase' },
    ],
  });
  const tool = makeStatusTool(runtime, makeSessionsStub(), () => ({ enabled: true }), {
    models: async () => ({ ok: true, models: [], source: 'stub' }),
  });
  const ret = await tool.execute({});
  assert.match(ret.text, /in-flight: 3 — none finished \(no receipt ≠ finished\)/);
  assert.match(ret.text, /· k1 → \(no session yet\) \[下发中 dispatching · phase=creating-session\] waited 12s/);
  assert.match(ret.text, /· dir:d:\/very\/long… → ses_ec039b26effe… \[执行中 running · phase=waiting\] waited 1m05s/);
  assert.match(ret.text, /· k3 → ses_live03 \[未知 unknown · phase=some-future-phase\] waited 1s/);
  assert.doesNotMatch(ret.text, /\[已结束/);
  assert.doesNotMatch(ret.text, /\[压缩中/);
});

test('status 工具：超时 lastRun + 在途 ⇒ 双双明说未结束（no receipt ≠ finished；在途≠已结束）', async () => {
  const runtime = makeRuntime({
    config: { enabled: true },
    probe: { installed: true, reason: 'ok' },
    inFlight: [{ sessionKey: 'k1', sessionId: 'ses_x', startedAt: Date.now() - 3_000, phase: 'waiting' }],
  });
  runtime.noteRun({
    sessionId: 'ses_x', sessionKey: 'k1', resumed: false,
    outcome: null, waitStatus: 'timeout', reasonCode: 'wait_timeout', reasonText: '等待超时：任务可能仍在桌面端运行',
    reasonEvidence: '', cost: null, model: null, reply: '', permissionRequests: [],
  });
  const tool = makeStatusTool(runtime, makeSessionsStub(), () => ({ enabled: true }), {
    models: async () => ({ ok: true, models: [], source: 'stub' }),
  });
  const ret = await tool.execute({});
  assert.match(ret.text, /\[执行中 running · phase=waiting\]/);
  assert.match(ret.text, /last run: .*outcome=- wait=timeout reason=wait_timeout/);
  assert.match(ret.text, /state: NOT finished — the task may still be running/);
  assert.match(ret.text, /no receipt ≠ finished/);
  assert.doesNotMatch(ret.text, /outcome=succeeded/);
});

test('status 工具：idle-204 但无终态回执（receipt_missing）⇒ 不算已结束', async () => {
  const runtime = makeRuntime({ config: { enabled: true }, probe: { installed: true, reason: 'ok' } });
  runtime.noteRun({
    sessionId: 'ses_y', sessionKey: 'k9', resumed: true,
    outcome: null, waitStatus: 'idle-204', reasonCode: 'receipt_missing', reasonText: '回执缺失',
    reasonEvidence: '', cost: null, model: null, reply: '', permissionRequests: [],
  });
  const tool = makeStatusTool(runtime, makeSessionsStub(), () => ({ enabled: true }), {
    models: async () => ({ ok: true, models: [], source: 'stub' }),
  });
  const ret = await tool.execute({});
  assert.match(ret.text, /wait=idle-204 reason=receipt_missing/);
  assert.match(ret.text, /state: NOT finished — the session went idle but this round produced no terminal receipt/);
  assert.match(ret.text, /no receipt ≠ finished/);
});

test('status 工具：终态回执 ⇒ 不发未结束告警（已结束面照常出读数）', async () => {
  const runtime = makeRuntime({ config: { enabled: true }, probe: { installed: true, reason: 'ok' } });
  runtime.noteRun({
    sessionId: 'ses_z', sessionKey: 'k2', resumed: false,
    outcome: 'succeeded', waitStatus: 'idle-204', reasonCode: 'ok', reasonText: '',
    reasonEvidence: '', cost: 0.5, model: null, reply: 'done', permissionRequests: [],
  });
  const tool = makeStatusTool(runtime, makeSessionsStub(), () => ({ enabled: true }), {
    models: async () => ({ ok: true, models: [], source: 'stub' }),
  });
  const ret = await tool.execute({});
  assert.match(ret.text, /outcome=succeeded/);
  assert.match(ret.text, /in-flight: \(none\)/);
  assert.doesNotMatch(ret.text, /state: NOT finished/);
});

test('purge 工具：默认档不碰服务端；remote:true 明说硬删', async () => {
  const runtime = makeRuntime({});
  const dispatch = {
    purge: async () => ({ ok: true, reason: 'ok', reasonEvidence: '', sessionId: 'ses_x', deleted: true, forgot: true }),
  };
  const tool = makePurgeTool(runtime, () => ({ enabled: true }), dispatch);
  const ret = await tool.execute({ session_id: 'ses_x', remote: true });
  assert.equal(ret.deleted, true);
  assert.match(ret.text, /DELETED on the service/);

  const soft = makePurgeTool(runtime, () => ({ enabled: true }), {
    purge: async () => ({ ok: true, sessionId: 'ses_x', deleted: false, forgot: true }),
  });
  const ret2 = await soft.execute({ session_key: 'k1' });
  assert.match(ret2.text, /plugin memory cleared/);
});

test('approvals 工具：list 刷新 lastRun 待批；reply 回写 state=replied 并带续跑回执', async () => {
  const runtime = makeRuntime({});
  runtime.noteRun({
    sessionId: 'ses_1',
    at: 1,
    permissionRequests: [{ requestID: 'r1', action: 'bash', source: 'tool:t1', state: 'pending', decision: '' }],
  });
  const dispatch = {
    listApprovals: async () => ({
      ok: true,
      sessionId: 'ses_1',
      items: [{ requestID: 'r1', action: 'bash', save: false, sourceType: 'tool', sourceID: 't1' }],
    }),
    replyApproval: async () => ({
      ok: true,
      sessionId: 'ses_1',
      decision: 'once',
      receipt: { outcome: 'succeeded', reply: 'continued fine', cost: 0.1, tokens: null, model: null, replyTruncated: false },
      waitStatus: 'idle-204',
      itemsAfter: [],
      reason: 'ok',
      reasonText: '',
    }),
  };
  const tool = makeApprovalsTool(runtime, makeSessionsStub(), () => ({ enabled: true }), dispatch);

  const listed = await tool.execute({ action: 'list' });
  assert.match(listed.text, /1 pending approval request/);
  assert.equal(runtime.lastRun().permissionRequests[0].state, 'pending');

  const replied = await tool.execute({ action: 'reply', request_id: 'r1', decision: 'once', wait_ms: 10 });
  assert.equal(replied.ok, true);
  assert.match(replied.text, /replied once to r1/);
  assert.match(replied.text, /continued fine/);
  assert.equal(runtime.lastRun().permissionRequests[0].state, 'replied');
  assert.equal(runtime.lastRun().permissionRequests[0].decision, 'once');

  await assert.rejects(() => tool.execute({ action: 'reply', request_id: 'r1', decision: 'nope' }), /decision must be one of/);
});

// ─────────────────── 收敛器 reconcileTools（U4 心脏） ───────────────────

test('reconcileTools：enabled=true + 已装 ⇒ 注册 4 个工具并落 REGISTERED', () => {
  const config = { enabled: true };
  const runtime = makeRuntime({ config, probe: { installed: true } });
  const { ctx } = makeCtx();
  reconcileTools(ctx, { runtime, sessions: {}, config, Config: {}, NS: 'ns', detect: () => {}, dispatch: {} });
  assert.deepEqual(ctx.registered, ['opencode_run', 'opencode_status', 'opencode_purge', 'opencode_approvals']);
  assert.equal(runtime.registry(), 'REGISTERED');
});

test('reconcileTools：服务缺失 ⇒ 一个不注册且落 SERVICE_MISSING（不冒充就绪）', () => {
  const config = { enabled: true };
  const runtime = makeRuntime({ config, probe: { installed: false, reason: 'service-missing' } });
  const { ctx } = makeCtx();
  reconcileTools(ctx, { runtime, sessions: {}, config, Config: {}, NS: 'ns', detect: () => {}, dispatch: {} });
  assert.deepEqual(ctx.registered, []);
  assert.equal(runtime.registry(), 'SERVICE_MISSING');
});

test('reconcileTools：OFF 翻 ON 再翻 OFF —— 注册/注销由 volatile-update 驱动（U4）', () => {
  const config = { enabled: false };
  const runtime = makeRuntime({ config, probe: { installed: true } });
  const { ctx, sctxs } = makeCtx();
  reconcileTools(ctx, { runtime, sessions: {}, config, Config: {}, NS: 'ns', detect: () => {}, dispatch: {} });
  assert.deepEqual(ctx.registered, [], 'OFF 时一处都不注册');

  config.enabled = true;
  sctxs[0].emit('loader/volatile-update');
  assert.equal(ctx.registered.length, 4, '翻 ON 后 4 个工具在场');

  config.enabled = false;
  sctxs[0].emit('loader/volatile-update');
  assert.equal(ctx.disposed.length, 4, '翻 OFF 后 4 个工具全注销');
  assert.equal(runtime.registry(), 'UNREGISTERED');
});

test('reconcileTools：注册中途抛错 ⇒ 回滚已注册者 + DEGRADED（不许半注册）', () => {
  const config = { enabled: true };
  const runtime = makeRuntime({ config, probe: { installed: true } });
  const { ctx } = makeCtx();
  let calls = 0;
  ctx.tools.register = (def) => {
    calls += 1;
    if (calls === 2) throw new Error('boom: duplicate name');
    ctx.registered.push(def.name);
    return () => ctx.disposed.push(def.name);
  };
  reconcileTools(ctx, { runtime, sessions: {}, config, Config: {}, NS: 'ns', detect: () => {}, dispatch: {} });
  assert.deepEqual(ctx.registered, ['opencode_run']);
  assert.deepEqual(ctx.disposed, ['opencode_run'], '已注册者必须回滚');
  assert.equal(runtime.registry(), 'DEGRADED');
  assert.match(String(runtime.registrationError()), /boom/);
});

test('reconcileTools：探测落地（onDetected）后重新收敛 —— 服务消失 ⇒ 注销 + SERVICE_MISSING', () => {
  const config = { enabled: true };
  const runtime = makeRuntime({ config, probe: null });
  const { ctx } = makeCtx();
  reconcileTools(ctx, { runtime, sessions: {}, config, Config: {}, NS: 'ns', detect: () => {}, dispatch: {} });
  assert.equal(ctx.registered.length, 4, '未结论 ⇒ 乐观注册（工具自带 execute 闸兜底）');
  assert.equal(runtime.registry(), 'REGISTERED');

  runtime.fireDetected({ installed: false, reason: 'service-missing' });
  assert.equal(ctx.disposed.length, 4, '探测说没有 ⇒ 注销');
  assert.equal(runtime.registry(), 'SERVICE_MISSING');
});
