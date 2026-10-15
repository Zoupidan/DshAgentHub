/**
 * 装配冒烟测试 —— `apply()` 是唯一装配点：真实 runtime + 真实收敛器 + 假 ctx，
 * 验证「能装配、装配出了什么、关着时不注册任何工具」。
 *
 * 探测路径用 `DSH_OPENCODE_HOME` 指向临时空家目录（绝不读真实 `~/.local/state/opencode`）。
 *
 * @module test/apply.test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply, inject, name } from '../src/host/apply.js';
import { PLUGIN_ID } from '../src/shared/constants.js';

function makeApplyCtx() {
  const record = { routes: [], sections: [], registered: [], cleanups: [], fibers: 0 };
  const makeSctx = (extra) => ({
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') record.cleanups.push(cleanup);
      return () => {};
    },
    on: () => () => {},
    ...extra,
  });
  const ctx = {
    fiber: { config: {} },
    logger: { warn() {}, info() {} },
    get: () => undefined,
    tools: {
      register(def) {
        record.registered.push(def.name);
        return () => {};
      },
    },
    jobs: { start: () => 'job_x' },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') record.cleanups.push(cleanup);
      return () => {};
    },
    inject(deps, cb) {
      record.fibers += 1;
      const extra = {};
      if (deps.includes('webServer')) {
        extra.webServer = { register: (r) => { record.routes.push(r); return () => {}; } };
      }
      if (deps.includes('settings')) {
        extra.settings = { configure() {} };
      }
      if (deps.includes('systemPrompt')) {
        extra.systemPrompt = { section: (s) => { record.sections.push(s); return () => {}; } };
      }
      const ret = cb(makeSctx(extra));
      return { dispose: () => { if (typeof ret === 'function') ret(); } };
    },
  };
  return { ctx, record };
}

test('apply：总闸 OFF 也能完整装配 —— 工具一个不注册，路由与提示词照常在场', () => {
  const { ctx, record } = makeApplyCtx();
  const config = { enabled: false };
  ctx.fiber.config = config; // 真机契约：ctx.fiber.config === apply 收到的 config（sameObject）
  apply(ctx, config);
  assert.deepEqual(record.registered, [], 'OFF ⇒ 一处都不注册（U4）');
  assert.equal(record.routes.length, 2, '状态 + 诊断两条路由');
  assert.ok(record.routes.every((r) => r.kind === 'exact'));
  assert.equal(record.sections.length, 1, '可用性提示词 section');
  assert.equal(record.sections[0].order, 520);
  assert.match(record.sections[0].name, /plugin-opencode:availability/);
  assert.equal(typeof record.sections[0].text, 'function', 'section.text 必须是逐回合求值的函数');
  assert.match(record.sections[0].text(), /switched OFF/);
});

test('apply：总闸 ON ⇒ 注册 4 个工具；探测落地为 service-missing 后如实收敛', async () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-apply-home-'));
  const saved = process.env.DSH_OPENCODE_HOME;
  process.env.DSH_OPENCODE_HOME = home;
  try {
    const { ctx, record } = makeApplyCtx();
    const config = { enabled: true };
    ctx.fiber.config = config; // 同源契约（见上）
    apply(ctx, config);
    assert.equal(record.registered.length, 4, 'ON ⇒ 4 个工具（未结论时乐观注册）');
    assert.equal(name, PLUGIN_ID);
    assert.ok(inject.includes('tools') && inject.includes('jobs'));

    // 等探测落定（临时空家目录 ⇒ service-missing ⇒ 收敛器注销 + SERVICE_MISSING）。
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    const text = record.sections[0].text();
    assert.match(text, /was NOT found \(service-missing\)/);
  } finally {
    if (saved === undefined) delete process.env.DSH_OPENCODE_HOME;
    else process.env.DSH_OPENCODE_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
