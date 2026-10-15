/**
 * 工作区锁与并发上限（F10 / R4）—— 独立测试面。
 *
 * 判据与 `packages/plugin-workbuddy/test/workspace-concurrency.test.js` 的 runtime 层逐条对齐：
 *   同工作区互斥 / 同 jobId 幂等重入 / 仅凭 jobId 释放（forget 路径）/ 跨工作区放行 /
 *   cap=3 上限与释放自愈 / 快照不泄漏 / 自定义上限与非法值回落。
 * 本包此前只有 `tools.test.js` 以桩覆盖工具面拒绝路径 —— 锁定语义本身无专属断言，本文件补齐。
 *
 * 全部离线纯内存：直接针对 `src/host/config/runtime.js` 的模块级锁断言，不触网、不写盘；
 * 每例前置 `clearWorkspaceLocks()`，互不串扰。
 *
 * @module test/runtime-locks.test
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  DEFAULT_CONCURRENCY_CAP,
  acquireWorkspaceLock,
  clearWorkspaceLocks,
  createRuntimeBase,
  inFlightByWorkspace,
  isWorkspaceBusy,
  normalizeWorkspaceKey,
  releaseWorkspaceLock,
} from '../src/host/config/runtime.js';

beforeEach(() => {
  clearWorkspaceLocks();
});

const WS = 'C:/tmp/oc-locks-test';

// ─────────────────────────── ① 归一化 ───────────────────────────

test('默认并发上限契约：DEFAULT_CONCURRENCY_CAP === 3', () => {
  assert.equal(DEFAULT_CONCURRENCY_CAP, 3);
});

test('normalizeWorkspaceKey：斜杠方向 / 盘符大小写 / 尾斜杠 / 空缺归一化', () => {
  assert.equal(normalizeWorkspaceKey('D:\\Code\\App\\'), normalizeWorkspaceKey('d:/code/app'));
  assert.equal(normalizeWorkspaceKey('C:/x/'), 'c:/x');
  assert.equal(normalizeWorkspaceKey(''), '__default__');
  assert.equal(normalizeWorkspaceKey('   '), '__default__');
  assert.equal(normalizeWorkspaceKey(undefined), '__default__');
});

// ─────────────────────────── ② 互斥语义 ───────────────────────────

test('互斥语义：同工作区第二个作业被拒；同 jobId 幂等重入；错主释放无效', () => {
  assert.equal(acquireWorkspaceLock(WS, 'j1'), true);
  assert.equal(acquireWorkspaceLock(WS, 'j1'), true, '同 jobId 重入幂等');
  assert.equal(acquireWorkspaceLock(WS, 'j2'), false, '同工作区第二作业被拒');
  assert.equal(isWorkspaceBusy(WS), true);
  assert.equal(releaseWorkspaceLock(WS, 'j2'), false, '非持锁者释放无效');
  assert.equal(isWorkspaceBusy(WS), true, '错主释放后锁仍在');
  assert.equal(releaseWorkspaceLock(WS, 'j1'), true);
  assert.equal(isWorkspaceBusy(WS), false);
  assert.equal(releaseWorkspaceLock(WS, 'j1'), false, '重复释放无效');
});

test('仅凭 jobId 也可释放（runtime.forget 走的就是这条路径）', () => {
  assert.equal(acquireWorkspaceLock(WS, 'j9'), true);
  assert.equal(releaseWorkspaceLock(null, 'j9'), true);
  assert.equal(isWorkspaceBusy(WS), false);
  assert.equal(releaseWorkspaceLock(null, 'j9'), false, '已释放的 jobId 再释放无效');
  assert.equal(releaseWorkspaceLock(null, 'never-seen'), false, '未见过的 jobId 释放无效');
});

// ─────────────────────────── ③ 并发上限 ───────────────────────────

test('跨工作区放行至上限：第 4 个被拒；释放后自愈', () => {
  const w1 = `${WS}-1`;
  const w2 = `${WS}-2`;
  const w3 = `${WS}-3`;
  const w4 = `${WS}-4`;
  assert.equal(acquireWorkspaceLock(w1, 'a'), true);
  assert.equal(acquireWorkspaceLock(w2, 'b'), true);
  assert.equal(acquireWorkspaceLock(w3, 'c'), true);
  assert.equal(Object.keys(inFlightByWorkspace()).length, 3);
  assert.equal(acquireWorkspaceLock(w4, 'd'), false, '第 4 个撞 cap=3');
  assert.equal(releaseWorkspaceLock(w1, 'a'), true);
  assert.equal(acquireWorkspaceLock(w4, 'd'), true, '释放后自愈');
});

test('自定义上限：concurrencyCap=2 生效、显式 cap 参数优先、非法值回落默认', () => {
  const rt = createRuntimeBase({ concurrencyCap: 2 });
  const a = `${WS}-a`;
  const b = `${WS}-b`;
  const c = `${WS}-c`;
  assert.equal(rt.acquireWorkspaceLock(a, '1'), true);
  assert.equal(rt.acquireWorkspaceLock(b, '2'), true);
  assert.equal(rt.acquireWorkspaceLock(c, '3'), false, 'runtime 缺省用 2');

  clearWorkspaceLocks();
  assert.equal(rt.acquireWorkspaceLock(a, '1', 1), true);
  assert.equal(rt.acquireWorkspaceLock(b, '2', 1), false, '显式 cap=1 优先于 runtime 缺省');

  clearWorkspaceLocks();
  assert.equal(acquireWorkspaceLock(a, 'x', 0), true, 'cap=0 非法 ⇒ 回落默认 3');
  assert.equal(acquireWorkspaceLock(b, 'y', 0), true);
  assert.equal(acquireWorkspaceLock(c, 'z', 0), true);
  assert.equal(acquireWorkspaceLock(`${WS}-d`, 'w', 0), false, '第 4 个仍被拦');
});

// ─────────────────────────── ④ runtime 接线 ───────────────────────────

test('createRuntimeBase().forget(jobId) 自动释放工作区锁', () => {
  const rt = createRuntimeBase({});
  assert.equal(rt.acquireWorkspaceLock(WS, 'job-f'), true);
  assert.equal(rt.isWorkspaceBusy(WS), true);
  rt.forget('job-f');
  assert.equal(rt.isWorkspaceBusy(WS), false, 'forget 即释放');
  assert.equal(isWorkspaceBusy(WS), false, '模块级视图同步（同一把锁）');
});

test('inFlightByWorkspace 快照：归一键承载 jobId 与 lockedAt；释放后消失', () => {
  assert.equal(acquireWorkspaceLock('C:/Snap//', 'job-s'), true);
  const snap = inFlightByWorkspace();
  const keys = Object.keys(snap);
  assert.deepEqual(keys, [normalizeWorkspaceKey('C:/Snap//')]);
  assert.equal(snap[keys[0]].jobId, 'job-s');
  assert.equal(typeof snap[keys[0]].lockedAt, 'number');
  releaseWorkspaceLock('c:/snap', 'job-s');
  assert.deepEqual(Object.keys(inFlightByWorkspace()), []);
});
