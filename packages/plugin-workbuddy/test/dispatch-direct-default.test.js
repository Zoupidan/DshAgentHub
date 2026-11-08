/**
 * @file T6 回归：`workbuddy_run` 的**默认下发路径 = 直接点火（CDP 直建）**，计划任务仅作回退。
 *
 * <p>★ 为什么单独成文件、而且**从 schema 真值取配置** ★
 * `test/followup-dispatcher.test.js` 的 R0–R4 已覆盖"直连三分支"的实现细节，但它们都**手写**
 * `enableDirectIgnition: true` —— 那证明的是"开关打开时行为对"，证明不了"**默认就是开着的**"。
 * 本文件的 D1 用 `Config['~standard'].validate({})` 的解析结果当配置（只补 `enabled` / `cwdRoot`），
 * 于是断言的每一条都锚在 **schema 默认值**上：谁把默认值改回 opt-in，D1 立刻变红。
 *
 * <p>覆盖矩阵（与施工单 T6 的验收条目一一对应）：
 *   - D1 默认配置 ⇒ `directIgnite` 恰一次、`automationRun` 零次（默认路径就是直连）；
 *   - D2 ignite 成功 ⇒ `lastRun.transport === 'direct'`（回执首行也写 direct，不谎称 automation）；
 *   - D3 CDP 不可用 ⇒ **自动回退**计划任务，回执 `fallback` 两键如实，作业照常完成（任务不丢）；
 *   - D4 其它**派发前**失败（建会话被拒）⇒ 同样回退，且指纹码原样进回执（不静默）；
 *   - D5 **派发后**失败 ⇒ **零回退**（R-NEW-2：回退 = 同一条 prompt 跑第二遍，双份积分）；
 *   - D6 `resume:true` + 记性命中 ⇒ 仍**先追发**（现有行为保留，直连默认不改变追发优先级）；
 *   - D7 显式关掉直连 ⇒ 与旧计划任务主路逐字节一致（逃生口仍在，direct 面零构造零调用）。
 *
 * <p>★ 全程零真实 IO ★
 * 两个 CDP 面（`directIgnite` / `followUp`）和计划任务面（`automationRun`）全部经 `makeRunTool`
 * 的 `seams` 注入假件；目录读取走假件 `catalog`；会话记性用内存 Map。套件级护栏
 * （`WORKBUDDY_TEST_HOME_GUARD` + `WORKBUDDY_HOME` 落在系统临时目录）与兄弟套件同款。
 *
 * @module test/dispatch-direct-default
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRunTool } from '../src/host/tools/run.js';
import { Config } from '../src/host/config/schema.js';
import { FOLLOWUP_CODES } from '../src/host/followup/dispatcher.js';

/* ───────────────────────── 配置：schema 真值（不是手写 true） ───────────────────────── */

/**
 * `Config` 的**默认解析结果**（解掉 0.1.7 的 `{get()}` volatile 包装器，官方读法见
 * `config/runtime.js` 的 `currentConfig()`），只把"运行时由用户/宿主给"的两项覆盖成测试值：
 *   - `enabled: true`：总闸，否则 `execute()` 第一步就抛（与默认路径无关）；
 *   - `cwdRoot: 'C:/repo'`：让 `autoCwd` 有确定值（schema 默认 '' 会让 argv 里 cwd 为空串）。
 *
 * @returns {Record<string, any>}
 */
function defaultConfigFromSchema() {
  const plain = JSON.parse(
    JSON.stringify(Config['~standard'].validate({}).value, (_k, v) =>
      (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)),
  );
  return { ...plain, enabled: true, cwdRoot: 'C:/repo' };
}

const PROBE_OK = { installed: true, reason: 'ok' };

/* ───────────────────────── 被测环境（全部 seam，零网络零真库） ───────────────────────── */

/**
 * @param {object} [o]
 * @param {Record<string, any>} [o.overrides] 在 schema 默认值上覆盖的配置键。
 * @param {{cliSessionId: string, cwd?: string}} [o.recorded] 预置的会话记性（D6 用）。
 * @param {object} [o.directOutcome] `directIgnite` 的返回值；缺省 = 直连成功回执。
 * @param {object} [o.automationOutcome] `automationRun` 的 `done` 载荷；缺省 = 完成 + QUEUE-REPLY。
 */
function harness({ overrides = {}, recorded = null, directOutcome = null, automationOutcome = null } = {}) {
  const runtime = {
    notes: [],
    detected: () => PROBE_OK,
    awaitDetection: async () => PROBE_OK,
    inFlightCount: () => 0,
    registry: () => undefined,
    setRegistry: () => {},
    start: () => {},
    finish: () => {},
    forget: () => {},
    noteRun: (rec) => { runtime.notes.push(rec); },
    lastRun: () => runtime.notes.length === 0 ? null : runtime.notes[runtime.notes.length - 1],
    registrationError: () => null,
  };

  const handles = [];
  const jobs = {
    handles,
    start(spec) {
      handles.push(spec.run());
      return `job-${handles.length}`;
    },
  };

  // ★ 会话记性：形状与 `session/map.js` 一致（resumable 只认非 superseded + 非空 id）。
  const store = new Map();
  const events = [];
  if (recorded !== null) {
    store.set('K', { cliSessionId: recorded.cliSessionId, cwd: recorded.cwd ?? 'C:/repo', superseded: false });
  }
  let adoptedCount = 0;
  const sessions = {
    store,
    events,
    resumable: (k) => {
      const r = store.get(k);
      if (!r || r.superseded === true) return null;
      if (typeof r.cliSessionId !== 'string' || r.cliSessionId === '') return null;
      return { cliSessionId: r.cliSessionId, cwd: r.cwd ?? null };
    },
    lookup: (k) => store.get(k) ?? null,
    adopt: (k, rec) => {
      adoptedCount += 1;
      events.push(`adopt:${k}`);
      store.set(k, { cliSessionId: rec.cliSessionId, cwd: rec.cwd ?? null, own: rec.own === true, superseded: false });
      return { ok: true };
    },
    touch: (k) => { events.push(`touch:${k}`); return { ok: true }; },
    forget: (k) => { events.push(`forget:${k}`); store.delete(k); return { ok: true }; },
    supersede: (k) => { events.push(`supersede:${k}`); store.delete(k); return { ok: true }; },
    adoptedCount: () => adoptedCount,
  };

  const automationCalls = [];
  const automationRun = (req) => {
    automationCalls.push(req);
    // 计划任务侧的记账契约：一确认 sessions.id 就 adopt（`automation.js` 的真实行为）。
    try { req.sessionStore?.adopt?.(req.sessionKey, { cliSessionId: 'conv-default-1', cwd: req.cwd ?? '', own: true }); } catch { /* 忽略 */ }
    const done = Promise.resolve(automationOutcome ?? {
      status: 'completed',
      detail: 'QUEUE-REPLY',
      exitCode: 0,
      automation: {
        reason: null,
        automationId: 'automation-default-1',
        conversationId: 'conv-default-1',
        sessionId: 'conv-default-1',
        sessionKey: req.sessionKey ?? null,
        sessionPersist: { ok: true },
        retired: true,
        transcriptPath: null,
        reply: 'QUEUE-REPLY',
        creditsUsed: null, model: null, permission: null,
        usedModelId: null, sessionCwd: req.cwd ?? null,
        tokensUsed: null, phases: ['db-open', 'running'],
      },
    });
    return { cancel: () => {}, done, readOutput: () => 'QUEUE-REPLY' };
  };

  const directIgniteCalls = [];
  const directIgnite = async (req) => {
    directIgniteCalls.push(req);
    if (directOutcome !== null) return directOutcome;
    return {
      ok: true,
      stage: 'dispatch',
      dispatched: true,
      created: true,
      conversationId: 'dsh-ignite-default-1',
      title: 'go',
      elapsedMs: 5,
      model: null,
      effort: null,
      receipt: {
        raw: { state: 'completed', content: [{ type: 'text', text: 'DIRECT-REPLY' }] },
        output: 'DIRECT-REPLY',
        state: 'completed',
        artifacts: [],
      },
    };
  };

  const followUpCalls = [];
  const followUp = async (req) => {
    followUpCalls.push(req);
    return {
      ok: true,
      channel: 'track_a',
      receipt: {
        raw: { state: 'completed', content: [{ type: 'text', text: 'FOLLOWUP-REPLY' }] },
        output: 'FOLLOWUP-REPLY',
        state: 'completed',
        conversationModel: 'kimi-k3-1',
        conversationEffort: 'high',
        artifacts: [],
      },
    };
  };

  const cfg = { ...defaultConfigFromSchema(), ...overrides };
  const tool = makeRunTool(
    runtime, sessions, () => cfg, { jobs }, null, null,
    {
      automationRun,
      followUp,
      directIgnite,
      // ★ 倍率查表用假目录：settleAutomation 才不会碰共享 `desktopModels` 单例。
      catalog: { projection: () => ({ cost: { models: [] } }) },
    },
  );

  return {
    cfg, runtime, sessions, jobs,
    automationCalls, automationRun, directIgniteCalls, followUpCalls,
    call: (args) => tool.execute(args, { signal: new AbortController().signal }),
  };
}

/* ───────────────────────── 测试 ───────────────────────── */

test('D0 套件级护栏生效：WORKBUDDY_HOME 指着一次性 tmp（本文件全部 seam，仍守同一条纪律）', () => {
  assert.equal(
    process.env.WORKBUDDY_TEST_HOME_GUARD,
    'on',
    '★ 套件级护栏没生效 —— 必须经 `node --import ./tools/dev/test-home-guard.mjs --test` 运行',
  );
  assert.ok(
    (process.env.WORKBUDDY_HOME ?? '').includes('wb-test-home-'),
    '★ WORKBUDDY_HOME 必须落在一次性临时目录（真库结构上不可达）',
  );
});

test('D1 ★★★ 默认配置（schema 真值）⇒ 直接点火是默认路径：ignite 恰一次、计划任务零 INSERT', async () => {
  const h = harness();
  // 前置（这条断言本身就是默认值的机器证据：谁把默认改回 opt-in，这里先红）。
  assert.equal(h.cfg.enableDirectIgnition, true, '★ schema 默认值必须是 true（默认直接点火）');

  const r = await h.call({ prompt: 'go', session_key: 'K' });

  assert.equal(h.directIgniteCalls.length, 1, '★ 默认路径 = 先 ignite（不是先写计划任务行）');
  assert.equal(h.automationCalls.length, 0, '★★ 直连成功 ⇒ 计划任务零 INSERT（慢路只在回退时用）');

  // 点火要素沿用工具面已算好的那套（与既有 direct 分支逐字同源，不另立一套）。
  const req = h.directIgniteCalls[0];
  assert.deepEqual(req.prompt, [{ type: 'text', text: 'go' }], 'prompt 必须打包成 ContentBlock[]');
  assert.equal(req.cwd, 'C:/repo');
  assert.equal(req.title, 'go', '点火名 = prompt 前 80 字');
  assert.equal(req.timeoutMs, 900_000, '点火预算 = 计划任务 15min 口径（不新增超时 knob）');
  assert.equal(req.cdpPort, 9222, '复用 followupCdpPort（不新增端口 knob）');

  assert.equal(r.resumed, false, '直连 = 新对话，不是续接');
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'fallback'), false, '成功轮不得带 fallback 键');
  assert.match(r.argv_preview, /^transport=direct/, '★ 回执首行必须说 direct（旧实现此处恒写 automation）');
  // 回执键集仍是既有 6 键（hardening 契约）——直连不给回执加新键，可见性走 lastRun。
  assert.deepEqual(
    Object.keys(r).sort(),
    ['argv_preview', 'job_id', 'not_sent', 'resumed', 'resumed_session_id', 'session_key'],
  );
});

test('D2 ★★★ ignite 成功 ⇒ lastRun.transport=direct、作业 completed、记性 adopt', async () => {
  const h = harness();
  await h.call({ prompt: 'go', session_key: 'K' });

  const done = await h.jobs.handles[0].done;
  assert.equal(done.status, 'completed');
  assert.equal(done.detail, 'DIRECT-REPLY');

  const last = h.runtime.notes[0];
  assert.equal(last?.transport, 'direct', '★★ lastRun 如实记 direct（回执首行同判据）');
  assert.equal(last?.automationId, null, '★ 直建不写 automations 表 ⇒ 行两角如实为无');
  assert.deepEqual(last?.phases, ['direct-ignite']);
  assert.equal(last?.resumed, false);
  assert.equal(last?.fallback, false);

  // ★ 记性：直建不 adopt 的话，下轮 resume:true 就命中不了（直建没有 automations 行可查）。
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'dsh-ignite-default-1', '★★ 必须 adopt 直建会话 id');
});

test('D3 ★★★ CDP 不可用 ⇒ 自动回退计划任务（任务不丢）：回执 fallback 两键如实、lastRun.transport=automation', async () => {
  const h = harness({
    directOutcome: {
      ok: false,
      code: FOLLOWUP_CODES.CDP_UNAVAILABLE,
      detail: 'port 9222 refused — WorkBuddy is not running or was started without WORKBUDDY_REMOTE_DEBUGGING_PORT',
      stage: 'detect',
      dispatched: false,
      created: false,
      conversationId: null,
      cleanup: 'none',
    },
  });

  const r = await h.call({ prompt: 'go', session_key: 'K' });

  assert.equal(h.directIgniteCalls.length, 1, '前置：确实试过直连');
  assert.equal(h.automationCalls.length, 1, '★★ 派发前失败 ⇒ 自动回退计划任务（绝不能静默丢任务）');
  assert.equal(h.automationCalls[0].prompt, 'go', '回退必须带同一条 prompt（不重写、不截断）');
  assert.equal(h.automationCalls[0].cwd, 'C:/repo');
  assert.equal(h.automationCalls[0].timeoutMs, 900_000, '回退超时沿用计划任务 15min 口径');

  assert.equal(r.fallback, true, '★ 回执必须带 fallback 两键（不静默降级）');
  assert.equal(r.fallbackReason, 'ERR_WORKBUDDY_CDP_UNAVAILABLE', '★ 指纹码原样透出');
  assert.match(r.argv_preview, /^transport=automation/, '★ 回退轮首行如实说 automation（不谎称 direct）');

  const done = await h.jobs.handles[0].done;
  assert.equal(done.status, 'completed', '★★ 任务照跑（回退不是失败）');
  assert.equal(done.detail, 'QUEUE-REPLY');

  const last = h.runtime.notes[0];
  assert.equal(last?.transport, 'automation', '★★ 回退轮真跑在计划任务上 ⇒ 不谎称 direct');
  assert.equal(last?.fallback, true);
  assert.equal(last?.fallbackReason, 'ERR_WORKBUDDY_CDP_UNAVAILABLE');
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-default-1', '回退轮的记性由计划任务侧 adopt');
});

test('D4 ★★ 其它派发前失败（建会话被桌面端拒绝）⇒ 同样回退，指纹码原样进回执', async () => {
  const h = harness({
    directOutcome: {
      ok: false,
      code: FOLLOWUP_CODES.FOLLOWUP_FAILED,
      detail: 'create returned {errorCode:"CONVERSATION_ID_INVALID"}',
      stage: 'create',
      dispatched: false,
      created: false,
      conversationId: null,
      cleanup: 'removed',
    },
  });

  const r = await h.call({ prompt: 'go', session_key: 'K' });

  assert.equal(h.automationCalls.length, 1, '★ 派发前失败一律可回退（不是只有 CDP 不可用这一种）');
  assert.equal(r.fallback, true);
  assert.equal(r.fallbackReason, 'ERR_FOLLOWUP_FAILED', '指纹码不得被吞成笼统文案');
  const done = await h.jobs.handles[0].done;
  assert.equal(done.status, 'completed', '任务不丢');
});

test('D5 ★★★ 派发后失败 ⇒ 零回退（R-NEW-2：回退 = 同一条 prompt 跑第二遍）', async () => {
  const h = harness({
    directOutcome: {
      ok: false,
      code: FOLLOWUP_CODES.DISPATCH_TIMEOUT,
      detail: 'runPrompt evaluate timed out',
      stage: 'dispatch',
      dispatched: true,
      created: true,
      conversationId: 'dsh-ignite-stuck',
      cleanup: 'kept',
    },
  });

  const r = await h.call({ prompt: 'go', session_key: 'K' });

  assert.equal(h.directIgniteCalls.length, 1);
  assert.equal(h.automationCalls.length, 0, '★★★ 已派发 ⇒ 绝不回退（双份积分 + 两条对话）');
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'fallback'), false, '没回退就不许带 fallback 键');
  assert.match(r.argv_preview, /^transport=direct/, '它确实走的是 direct，首行照实说');
  const done = await h.jobs.handles[0].done;
  assert.equal(done.status, 'failed', '作业如实失败（诊断不吞）');
  const last = h.runtime.notes[0];
  assert.equal(last?.transport, 'direct');
  assert.equal(last?.sessionId, 'dsh-ignite-stuck', '必须报出是哪条对话（可能还在跑）');
  assert.equal(h.sessions.resumable('K'), null, '终态失败 ⇒ forget 记性（下轮重建）');
});

test('D6 ★★ resume:true + 记性命中 ⇒ 仍先追发（直连默认不改变追发优先级）', async () => {
  const h = harness({ recorded: { cliSessionId: 'conv-recorded', cwd: 'C:/repo' } });

  const r = await h.call({ prompt: 'more', session_key: 'K', resume: true });

  assert.equal(h.followUpCalls.length, 1, '★ 既有行为保留：记性命中先追发进同一条对话');
  assert.equal(h.directIgniteCalls.length, 0, '★ 追发成功的一轮不再点火（不重复发 prompt）');
  assert.equal(h.automationCalls.length, 0);
  assert.equal(r.resumed, true);
  assert.equal(r.resumed_session_id, 'conv-recorded');
  assert.match(r.argv_preview, /^transport=followup/, '追发轮首行如实说 followup');
  const last = h.runtime.notes[0];
  assert.equal(last?.transport, 'followup');
  assert.equal(last?.resumed, true);
});

test('D7 ★★ 显式关掉直连 ⇒ 与旧计划任务主路逐字节一致（direct 面零构造零调用）', async () => {
  const h = harness({ overrides: { enableDirectIgnition: false } });

  const r = await h.call({ prompt: 'go', session_key: 'K' });

  assert.equal(h.directIgniteCalls.length, 0, '★ 开关关 ⇒ direct 面一次都不许碰（零回归门禁）');
  assert.equal(h.automationCalls.length, 1, '★ 照旧走计划任务');
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'fallback'), false, '不是回退轮 ⇒ 不带 fallback 键');
  assert.match(r.argv_preview, /^transport=automation/);
  const done = await h.jobs.handles[0].done;
  assert.equal(done.status, 'completed');
  assert.equal(h.runtime.notes[0]?.transport, 'automation');
});
