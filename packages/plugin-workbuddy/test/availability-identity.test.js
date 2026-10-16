/**
 * ① 身份上移（2026-10-17）回归闸：可用性文案的 Lead 分支。
 * - hasTools=false（团队在场、工具面归成员）⇒ 团队成员口径（spawn_teammate/send_message/wait_agent + 明说不在自身工具面）；
 * - 缺省 / hasTools=true ⇒ 旧口径逐字保留（成员视角与团队未挂的回退部署共用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityText } from '../src/host/prompts/availability.js';
import { REGISTRY_STATES } from '../src/host/config/constants.js';

const readyRuntime = (cfg = {}) => ({
  currentConfig: () => ({ enabled: true, ...cfg }),
  detected: () => ({ installed: true }),
  registry: () => REGISTRY_STATES.REGISTERED,
  registrationError: () => null,
  lastRun: () => null,
});

test('Lead 口径（hasTools=false）：指引走团队成员，不教直呼工具', () => {
  const text = availabilityText(readyRuntime(), { hasTools: false });
  assert.match(text, /spawn_teammate with name "workbuddy"/);
  assert.match(text, /NOT on your own tool surface by design/);
  assert.match(text, /wait_agent/);
  assert.doesNotMatch(text, /use workbuddy_run to delegate/);
});

test('缺省 / hasTools=true：旧口径逐字保留（成员与回退部署共用）', () => {
  for (const opts of [undefined, {}, { hasTools: true }, { hasTools: true, teamMember: true }]) {
    const text = opts === undefined ? availabilityText(readyRuntime()) : availabilityText(readyRuntime(), opts);
    assert.match(text, /use workbuddy_run to delegate a coding task as a background job/);
    assert.doesNotMatch(text, /NOT on your own tool surface/);
  }
});

test('成员视角（teamMember=true）：不给"怎么招人 / 怎么质疑"的 Lead 指引', () => {
  const text = availabilityText(readyRuntime(), { hasTools: true, teamMember: true });
  assert.doesNotMatch(text, /spawn_teammate with name/);
  assert.doesNotMatch(text, /send_message the SAME member with your objection/);
  assert.match(text, /use workbuddy_run to delegate a coding task as a background job/);
});
