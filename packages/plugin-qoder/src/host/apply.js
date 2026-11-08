/**
 * 装配层（唯一装配点）。CDP+applicationInvoke 通道；零反代/零 CLI/零 GUI 自动化。
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

  // 只读探测：enabled 时才跑（U4/H-NO-EXEC-PROBE 精神；CDP 只读连接）
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

  const doReconcile = () => {
    // 尝试从宿主获取最新 config（volatile 兼容：优先 runtime 已知 + 传入 config）
    try { runtime.setConfig(config); } catch {}
    if (runtime.currentConfig()?.enabled === true && runtime.probeState?.()?.status === 'idle') {
      void runtime.reprobe(detectProbe, ctx, runtime.currentConfig());
    }
    return reconcileTools(ctx, { runtime, sessions, config, Config, NS, detect: detectProbe, dispatch });
  };

  ctx.effect?.(() => { doReconcile(); }, `${PLUGIN_ID}: tools`);

  ctx.effect?.(() => {
    const fibers = [];
    try {
      fibers.push(ctx.inject?.(['webServer', 'settings'], (sctx) => {
        sctx.effect?.(() => {
          const ds = makeRoutes(runtime, sessions, dispatch).map((r) => sctx.webServer.register(r));
          return () => { for (const d of ds) try { d(); } catch {} };
        }, `${PLUGIN_ID}: routes`);
      }));
    } catch {}
    try {
      fibers.push(ctx.inject?.(['systemPrompt'], (sctx) => {
        sctx.effect?.(() => {
          const d = sctx.systemPrompt.section({
            name: `${PLUGIN_ID}:availability`,
            order: 520,
            text: (context) => availabilityText(runtime, { hasTools: hasHarnessToolsForScope(context?.scope) }),
          });
          return () => { try { d?.(); } catch {} };
        }, `${PLUGIN_ID}: availability prompt`);
      }));
    } catch {}
    return () => { for (const f of fibers) try { void f?.dispose?.(); } catch {} };
  }, `${PLUGIN_ID}: injects`);
}

export { name, inject, apply, Config };
