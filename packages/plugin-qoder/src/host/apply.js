/**
 * 装配层（唯一装配点）。CDP+applicationInvoke 通道；零反代/零 CLI/零 GUI 自动化。
 * 结构对齐 plugin-opencode（deferred inject、effect-scoped 注册、非静默失败）。
 * @module host/apply
 */
import { PLUGIN_ID, NS, TOOL_RUN } from '../shared/constants.js';
import { createRuntime } from './config/runtime.js';
import { Config } from './config/schema.js';
import { createDispatch } from './gateway/dispatch.js';
import { detectProbe } from './probe/detect.js';
import { createSessionMap } from './session/map.js';
import { makeRoutes } from './routes/index.js';
import { reconcileTools } from './tools/index.js';
import { availabilityText } from './prompts/availability.js';

const name = PLUGIN_ID;
const inject = ['tools', 'jobs'];

function apply(ctx, config) {
  const runtime = createRuntime({ pluginId: PLUGIN_ID, config, ns: NS });
  const sessions = createSessionMap(ctx, runtime);

  // 只读探测：enabled 时才跑（CDP 只读连接）
  if (runtime.currentConfig()?.enabled === true) {
    void runtime.reprobe(detectProbe, ctx, runtime.currentConfig());
  }

  const dispatch = createDispatch({
    runtime,
    sessions,
    logger: ctx.logger ?? console,
  });

  const hasHarnessToolsForScope = (scope) => {
    if (scope === undefined || scope === null) return true;
    try { return ctx.tools?.get?.(TOOL_RUN, scope) !== undefined; } catch { return true; }
  };

  // U4：工具面收敛（effect-scoped；doReconcile 触发重探测并返回 reconcile 结果）
  ctx.effect(() => {
    try { runtime.setConfig(config); } catch {}
    if (runtime.currentConfig()?.enabled === true && runtime.probeState?.()?.status === 'idle') {
      void runtime.reprobe(detectProbe, ctx, runtime.currentConfig());
    }
    reconcileTools(ctx, { runtime, sessions, config, Config, NS, detect: detectProbe, dispatch });
  }, `${PLUGIN_ID}: tools`);

  // 状态 bridge + 路由 / 可用性提示词：deferred inject，失败向上抛出以便宿主记录（不静默吞没）。
  ctx.effect(() => {
    const fibers = [
      ctx.inject(['webServer', 'settings'], (sctx) => {
        sctx.effect(() => {
          const ds = makeRoutes(runtime, sessions, dispatch)
            .map((r) => sctx.webServer.register(r));
          return () => { for (const d of ds) { try { d(); } catch {} } };
        }, `${PLUGIN_ID}: routes`);
      }),
      ctx.inject(['systemPrompt'], (sctx) => {
        sctx.effect(() => {
          const d = sctx.systemPrompt.section({
            name: `${PLUGIN_ID}:availability`,
            order: 520,
            text: (context) => availabilityText(runtime, { hasTools: hasHarnessToolsForScope(context?.scope) }),
          });
          return () => { try { d?.(); } catch {} };
        }, `${PLUGIN_ID}: availability prompt`);
      }),
    ];
    return () => { for (const f of fibers) { try { void f?.dispose?.(); } catch {} } };
  }, `${PLUGIN_ID}: injects`);
}

export { name, inject, apply, Config };
