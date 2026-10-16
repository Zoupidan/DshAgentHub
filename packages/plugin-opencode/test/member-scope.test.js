/**
 * ① 身份上移（2026-10-17）回归闸：成员 scope 安装器。
 * （plugin-opencode 版；与 plugin-workbuddy 同款测试同构。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessMemberScope } from '../src/host/team/member-scope.js';
import { MEMBER_NAME } from '../src/shared/constants.js';

function fakeCtx({ members, agents = [] } = {}) {
  const handlers = new Map();
  const ctx = {
    logger: { warn: () => {} },
    get(name) {
      if (name === 'agentTeams') {
        return members === undefined ? null : { tryMembership: (agent) => members.get(agent) };
      }
      if (name === 'agents') return { list: () => [...agents] };
      return null;
    },
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
    effect(fn) { return fn(); },
    emit(name, payload) { for (const fn of handlers.get(name) ?? []) fn(payload); },
  };
  return { ctx };
}

const memberAgent = { id: 'a-member', ctx: {} };
const leadAgent = { id: 'a-lead', ctx: {} };

test('只装名为 MEMBER_NAME 的 teammate；Lead 与异名不装；OFF ⇒ 不装、ON ⇒ 补装', () => {
  const members = new Map([
    [memberAgent, { role: 'teammate', name: MEMBER_NAME }],
    [leadAgent, { role: 'lead', name: 'lead' }],
  ]);
  const installedFor = [];
  const agentList = [memberAgent, leadAgent];
  const { ctx } = fakeCtx({ members, agents: agentList });
  const scope = createHarnessMemberScope(ctx, {
    pluginId: 'plugin-opencode',
    memberName: MEMBER_NAME,
    install: (scoped, agent) => {
      installedFor.push(agent.id);
      return () => { installedFor.push('dispose:' + agent.id); };
    },
  });
  assert.ok(scope, '团队服务在场时安装器必须存在');

  scope.setEnabled(false);
  assert.equal(scope.installedCount(), 0, 'OFF ⇒ 一个都不装');

  scope.setEnabled(true);
  assert.deepEqual(installedFor, [memberAgent.id], '只装成员；Lead 不装');
  assert.equal(scope.installedCount(), 1);

  const lateMember = { id: 'a-late', ctx: {} };
  members.set(lateMember, { role: 'teammate', name: MEMBER_NAME });
  agentList.push(lateMember);
  ctx.emit('agent/created', { agent: lateMember });
  assert.ok(installedFor.includes(lateMember.id));
  assert.equal(scope.installedCount(), 2);

  const other = { id: 'a-other', ctx: {} };
  members.set(other, { role: 'teammate', name: 'reviewer' });
  ctx.emit('agent/created', { agent: other });
  assert.ok(!installedFor.includes(other.id));

  scope.setEnabled(false);
  assert.equal(scope.installedCount(), 0);
  assert.ok(installedFor.includes('dispose:' + memberAgent.id) && installedFor.includes('dispose:' + lateMember.id));

  scope.setEnabled(true);
  ctx.emit('agent/disposed', { agent: memberAgent });
  assert.equal(scope.installedCount(), 1);
});

test('非团队成员（tryMembership ⇒ undefined）不装', () => {
  const stranger = { id: 'a-stranger', ctx: {} };
  const members = new Map();
  const installedFor = [];
  const { ctx } = fakeCtx({ members, agents: [stranger] });
  const scope = createHarnessMemberScope(ctx, {
    pluginId: 'plugin-opencode',
    memberName: MEMBER_NAME,
    install: (_scoped, agent) => { installedFor.push(agent.id); return () => {}; },
  });
  scope.setEnabled(true);
  ctx.emit('agent/created', { agent: stranger });
  assert.equal(scope.installedCount(), 0);
  assert.deepEqual(installedFor, []);
});

test('安装失败不外抛：记日志、该成员保持未装', () => {
  const members = new Map([[memberAgent, { role: 'teammate', name: MEMBER_NAME }]]);
  const warns = [];
  const { ctx } = fakeCtx({ members, agents: [memberAgent] });
  ctx.logger.warn = (m) => warns.push(String(m));
  const scope = createHarnessMemberScope(ctx, {
    pluginId: 'plugin-opencode',
    memberName: MEMBER_NAME,
    install: () => { throw new Error('boom'); },
  });
  scope.setEnabled(true);
  assert.equal(scope.installedCount(), 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /member scope install failed/);
});

test('agentTeams 缺席 ⇒ 返回 null（调用方回退全局注册）', () => {
  const { ctx } = fakeCtx({ members: undefined, agents: [] });
  const scope = createHarnessMemberScope(ctx, {
    pluginId: 'plugin-opencode',
    memberName: MEMBER_NAME,
    install: () => () => {},
  });
  assert.equal(scope, null);
});
