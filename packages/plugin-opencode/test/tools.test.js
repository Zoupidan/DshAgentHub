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
import { makePurgeTool } from '../src/host/tools/purge.js';
import { makeRunTool } from '../src/host/tools/run.js';
import { makeStatusTool } from '../src/host/tools/status.js';

// ─────────────────────────── 桩 ───────────────────────────

function makeRuntime({ config = {}, probe = null } = {}) {
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
    inFlight: () => [],
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
