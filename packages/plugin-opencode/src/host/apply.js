/**
 * 装配层（本插件的**唯一装配点**；`lib/index.js` 只转发到这里）。
 *
 * 装配顺序（与 workbuddy 同构，机制与厂商无关）：
 *   ① runtime（SSOT）→ ② 会话记性（session/map.js）+ 启动清扫 → ③ 只读探测（enabled 时）
 *   → ④ 下发器（createDispatcher，取**取值函数**而非快照）→ ⑤ 工具面收敛（U4 心脏）
 *   → ⑥ 状态 bridge + 诊断路由 → ⑦ 可用性提示词 section。
 *
 * inject 纪律：`tools`/`jobs` 进 inject 数组（apply 的同步回合就要用）；
 * `webServer`/`settings`/`systemPrompt` 走 **deferred inject**（它们没就绪时其余部分照常装配）。
 *
 * @module host/apply
 */
import { PLUGIN_ID, NS, TOOL_RUN } from '../shared/constants.js';
import { createRuntime } from './config/runtime.js';
import { Config } from './config/schema.js';
import { createDispatcher } from './gateway/dispatch.js';
import { detectOpencode } from './probe/detect.js';
import { availabilityText } from './prompts/availability.js';
import { makeRoutes } from './routes/index.js';
import { loadSessionMap, sweepOwnSessions } from './session/map.js';
import { reconcileTools } from './tools/index.js';

const name = PLUGIN_ID;
const inject = ['tools', 'jobs']; // ⑤⑥⑦ 的 webServer/settings/systemPrompt 走 deferred inject

/**
 * @param {object} ctx 宿主 ctx
 * @param {unknown} config 生效配置（schemastery 校验后的原样对象；volatile 字段是 {get()} 包装器）
 */
function apply(ctx, config) {
  // ① 插件端 SSOT
  const runtime = createRuntime({ pluginId: PLUGIN_ID, config, ns: NS });
  // ② 会话记性（settings 用户层，进程重启也在）+ 启动清扫（只回收 own 且陈旧的；
  //    用户绑定的会话绝不回收 —— 人指定的压过自动的）
  const sessions = loadSessionMap(ctx, NS);
  try {
    const res = sweepOwnSessions(sessions, {
      boundSessionId: (() => {
        const bound = runtime.currentConfig()?.boundSessionId;
        return typeof bound === 'string' ? bound : '';
      })(),
    });
    if (Array.isArray(res?.swept) && res.swept.length > 0) {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] swept ${res.swept.length} stale plugin-owned session(s): ${res.swept.join(', ')}`);
    }
  } catch { /* 清扫失败 = 用旧记性多跑一轮，不挡装配 */ }
  // ③ 只读探测（U6）：OFF 一律不发生（PRD-v4 ①硬闸）；补跑点在 tools/index.js 的 reconcile。
  //    ★ 必须传 runtime.currentConfig()（解包 volatile 的 {get()} 包装器），不是原始 config。
  if (runtime.currentConfig()?.enabled === true) {
    void runtime.probe(detectOpencode, ctx, runtime.currentConfig());
  }
  // ④ 下发器：**建一次，用到插件卸载**；所有可变项走取值函数（volatile 通用坑：
  //    装配期拍死 ⇒ 用户改了设置不生效）。
  const dispatch = createDispatcher({
    resolveConfig: () => runtime.currentConfig(),
    sessions,
    runtime,
  });
  // ★ ① 身份上移（2026-10-17）：可用性 section 按"这个 agent 自己的可见面"分支 ——
  //   成员（或团队未挂时的全局）见到工具口径；Lead 见到"走团队成员"口径。
  const hasHarnessToolsForScope = (scope) => {
    if (scope === undefined || scope === null) return true; // 无 scope 的取用方按老口径
    try { return ctx.tools.get(TOOL_RUN, scope) !== undefined; } catch { return true; }
  };
  // ⑤ ★ U4 心脏：工具注册 + 开关心脏（effect-scoped：随插件卸载自动移除）
  ctx.effect(() => reconcileTools(ctx, {
    runtime, sessions, config, Config, NS, detect: detectOpencode, dispatch,
  }), `${PLUGIN_ID}: tools`);
  // ⑥ 状态 bridge + 诊断路由 / ⑦ 可用性提示（单个 effect 收纳两个 fiber：卸载时一并 dispose）
  ctx.effect(() => {
    const fibers = [
      ctx.inject(['webServer', 'settings'], (sctx) => {
        sctx.effect(() => {
          const ds = makeRoutes(runtime, sessions, dispatch)
            .map((r) => sctx.webServer.register(r));
          return () => { for (const d of ds) d(); };
        }, `${PLUGIN_ID}: status bridge`);
      }),
      ctx.inject(['systemPrompt'], (sctx) => {
        sctx.effect(() => {
          const d = sctx.systemPrompt.section({
            name: `${PLUGIN_ID}:availability`,
            order: 520,
            // ★ ① 身份上移（2026-10-17）：按本 agent 的可见面分支（成员=工具口径 / Lead=团队成员口径）。
            text: (context) => availabilityText(runtime, { hasTools: hasHarnessToolsForScope(context?.scope) }),
          });
          return () => d();
        }, `${PLUGIN_ID}: availability prompt`);
      }),
    ];
    return () => { for (const f of fibers) void f?.dispose?.(); };
  }, `${PLUGIN_ID}: injects`);
}

export { name, inject, apply, Config };
