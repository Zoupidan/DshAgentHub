/**
 * 工具面收敛器（U4 心脏）—— `enabled` 是**硬闸**：不等 true，一个工具都不在。
 *
 * 结构承接 plugin-workbuddy（机制与厂商无关，逐条教训都在注释里）：
 *   1. **H-REACTIVE**：配置从 `runtime.current()` 现读（0.1.7 的 volatile 包装器由
 *      `currentConfig()` 解包）；注册/注销由 `loader/volatile-update` 事件驱动 ——
 *      读快照会让开关变成假开关。
 *   2. **未结论 ≠ 未就绪**（三态）：探测未落地（probe === null）时**乐观注册**，
 *      探测落地 `onDetected` 再收敛：服务缺失 ⇒ `SERVICE_MISSING`（工具注销）。
 *   3. **注册原子性**：`ctx.tools.register` 非原子（撞名/ schema 非法会抛）⇒
 *      半注册会让 disposers 停在 [] 而工具已挂上（OFF 永远注销不掉）⇒
 *      任一失败即回滚 + DEGRADED + `setRegistrationError`（**不外抛** —— 外抛会打断
 *      apply 里其后的状态路由/提示词装配，用户连"为什么"都看不到）。
 *   4. 注销**不杀在途作业**（作业归 ctx.jobs 管；本函数不持有其终止句柄）。
 *
 * @module host/tools/index
 */
import { REGISTRY_STATES } from '../config/constants.js';
import { makeApprovalsTool } from './approvals.js';
import { makePurgeTool } from './purge.js';
import { makeRunTool } from './run.js';
import { makeStatusTool } from './status.js';
import { PLUGIN_ID, MEMBER_NAME } from '../../shared/constants.js';
import { createHarnessMemberScope } from '../team/member-scope.js';
import { installMemberTools } from '../team/member-tools.js';

/**
 * @param {object} ctx 宿主 ctx（tools / effect / inject）
 * @param {{runtime: object, sessions: object, config: unknown, Config: object, NS: string,
 *   detect: Function, dispatch: object}} deps
 * @returns {() => void} 卸载收敛器（注销工具 + 退订探测订阅 + dispose settings fiber）
 */
export function reconcileTools(ctx, { runtime, sessions, config, Config, NS, detect, dispatch }) {
  const read = () => {
    const src = runtime.current();
    return typeof src === 'function' ? runtime.currentConfig() : src;
  };

  /** @type {Array<() => void>} */
  let disposers = [];

  // ★ ① 身份上移（2026-10-17）：团队在场 ⇒ 工具面归"成员身份"（名为 MEMBER_NAME 的 teammate），
  //   Lead 与其它成员的全局面一个都不注册；团队服务缺席（永远为 null）时走下方原有的全局路径（回退）。
  //   ★ 团队服务可能在本插件**之后**才就绪（bundle 加载顺序不定）⇒ 用 **deferred inject**（见 reconcile
  //     结束后的那条 ctx.inject）：服务出现时创建成员 scope 并补跑一次收敛；永远不出现 ⇒ 保持 null。
  /** @type {{setEnabled: Function, installedCount: Function, dispose: Function} | null} */
  let memberScope = null;

  const reconcile = () => {
    const cfg = read();
    const probe = runtime.detected();
    const installed = probe?.installed === true;
    // 补跑点：apply 只在 enabled 时探测 ⇒ "OFF 翻 ON"后探测从未启动（probeArgs()===null 是机器证据）。
    if (cfg?.enabled === true && probe === null && runtime.probeArgs() === null && typeof detect === 'function') {
      void runtime.probe(detect, ctx, cfg);
    }
    const want = cfg?.enabled === true && (probe === null ? true : installed);
    // ★ ① 身份上移（2026-10-17）：团队在场 ⇒ 工具面只装进成员 scope，全局一个都不注册。
    if (memberScope !== null) {
      // ★ 切到成员形态：装配顺序可能让全局先注册过 ⇒ 全局面先退场，再接管（身份唯一）。
      if (disposers.length > 0) {
        for (const d of disposers) d();
        disposers = [];
      }
      memberScope.setEnabled(want);
      runtime.setRegistrationError(null);
      runtime.setRegistry(want ? REGISTRY_STATES.REGISTERED : afterUnregister(probe, installed));
      return;
    }
    if (want && disposers.length === 0) {
      const next = [];
      try {
        next.push(ctx.tools.register(makeRunTool(runtime, sessions, read, ctx, dispatch)));
        next.push(ctx.tools.register(makeStatusTool(runtime, sessions, read, dispatch)));
        next.push(ctx.tools.register(makePurgeTool(runtime, read, dispatch)));
        next.push(ctx.tools.register(makeApprovalsTool(runtime, sessions, read, dispatch)));
      } catch (err) {
        for (const d of next) d();
        runtime.setRegistrationError(err instanceof Error ? err.message : String(err));
        runtime.setRegistry(REGISTRY_STATES.DEGRADED);
        return;
      }
      disposers = next;
      runtime.setRegistrationError(null);
      runtime.setRegistry(REGISTRY_STATES.REGISTERED);
    } else if (!want && disposers.length > 0) {
      for (const d of disposers) d();
      disposers = [];
      runtime.setRegistrationError(null);
      runtime.setRegistry(afterUnregister(probe, installed));
    } else if (!want && disposers.length === 0 && probe !== null) {
      // 未注册的稳态收敛（"查过且没有"与"还没查"不许混淆）。
      runtime.setRegistrationError(null);
      runtime.setRegistry(afterUnregister(probe, installed));
    } else if (want && disposers.length > 0 && probe !== null) {
      // 已注册 + 探测落地后的现实收敛：服务消失 ⇒ SERVICE_MISSING（工具兜底的 execute 闸仍会挡住下发）。
      runtime.setRegistry(installed ? REGISTRY_STATES.REGISTERED : REGISTRY_STATES.SERVICE_MISSING);
    }
  };

  /**
   * 注销后的注册态：**未结论 ≠ 复制过且服务缺失**。
   * probe === null（只因开关/未知而注销）⇒ UNREGISTERED，不冒充"查过且没有"。
   */
  function afterUnregister(probe, installed) {
    if (probe === null) return REGISTRY_STATES.UNREGISTERED;
    return installed ? REGISTRY_STATES.UNREGISTERED : REGISTRY_STATES.SERVICE_MISSING;
  }

  // settings：0.1.7 走隐式发现（namespace = loader 行 id；schema = 本行导出的 Config）。
  // `auto:false` = 不自动生成设置页（页面由本插件自己的 client 卡片提供）。
  const settingsFiber = ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => {
      sctx.settings.configure({ auto: false }, ctx.fiber);
    });
    // ★ 读**本插件自己的** fiber（`ctx.fiber.config`），不是 inject 出来的子 fiber ——
    //   真机教训（见 workbuddy 同名文件）：子 fiber 的 config 是空对象 ⇒ 开关恒 OFF。
    sctx.effect(() => {
      runtime.setSource(() => ctx.fiber?.config);
      reconcile();
      return sctx.on('loader/volatile-update', () => {
        reconcile();
      });
    }, `${NS}: config source`);
  });
  // 探测落地回调也必须退订：卸载后仍有在途探测完成时，无退订会向已卸载的 ctx 注册工具。
  const offDetected = runtime.onDetected(reconcile);
  // ★ ① 身份上移：团队服务 deferred inject（放在 settings 之后：收敛源先就位）——服务出现时
  //   创建成员 scope 并补跑收敛；未挂 Teams 的组合这条 fiber 永不回调 ⇒ memberScope 保持 null ⇒ 全局注册（回退）。
  ctx.inject(['agentTeams', 'agents'], (teamCtx) => {
    memberScope = createHarnessMemberScope(ctx, {
      pluginId: PLUGIN_ID,
      memberName: MEMBER_NAME,
      agentTeams: teamCtx.agentTeams,
      agents: teamCtx.agents,
      install: (scoped) => installMemberTools(scoped, { runtime, sessions, read, ctx, dispatch }),
    });
    queueMicrotask(() => { try { reconcile(); } catch { /* 收敛异常不炸注入纤维 */ } });
    teamCtx.effect(() => () => {
      try { memberScope?.setEnabled(false); } catch { /* 卸载尽最大努力 */ }
      memberScope = null;
    }, `${PLUGIN_ID}: member scope fiber`);
  });

  return () => {
    offDetected();
    for (const d of disposers) d();
    disposers = [];
    void settingsFiber?.dispose?.();
  };
}
