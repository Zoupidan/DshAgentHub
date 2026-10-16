/**
 * ① 身份上移（2026-10-17）回归闸：可用性文案的 Lead 分支。
 * - hasTools=false（团队在场、工具面归成员）⇒ 团队成员口径（spawn_teammate/send_message/wait_agent + 明说不在自身工具面）；
 * - 缺省 / hasTools=true ⇒ 旧口径逐字保留（回退部署共用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityText } from '../src/host/prompts/availability.js';

const readyRuntime = (cfg = {}) => ({
  currentConfig: () => ({ enabled: true, ...cfg }),
  probeState: () => ({ status: 'done', result: { installed: true } }),
  lastRun: () => null,
});

test('Lead 口径（hasTools=false）：指引走团队成员，不教直呼工具', () => {
  const text = availabilityText(readyRuntime(), { hasTools: false });
  assert.match(text, /spawn_teammate with name "opencode"/);
  assert.match(text, /NOT on your own tool surface by design/);
  assert.match(text, /wait_agent/);
  assert.doesNotMatch(text, /opencode_run sends a task to the local OpenCode desktop app/);
});

test('缺省 / hasTools=true：旧口径逐字保留（回退部署共用）', () => {
  for (const opts of [undefined, {}, { hasTools: true }]) {
    const text = opts === undefined ? availabilityText(readyRuntime()) : availabilityText(readyRuntime(), opts);
    assert.match(text, /opencode_run sends a task to the local OpenCode desktop app/);
    assert.doesNotMatch(text, /NOT on your own tool surface/);
  }
});
