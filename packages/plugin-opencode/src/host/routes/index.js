/**
 * 路由装配（③ 状态 bridge + ④ 诊断）—— ctx.webServer.register 的入参列表。
 *
 * 实证（workbuddy 同款）：`ctx.webServer.register({ kind: 'exact'|'prefix', path, handler })`
 * 返回注销函数；调用方（apply.js）负责在 effect 里注册并在卸载时注销。
 *
 * @module host/routes/index
 */
import { makeDiagnosticsRoute } from './diagnostics/get.js';
import { makeStatusRoute } from './status/get.js';

/**
 * @param {object} runtime config/runtime.js 实例
 * @param {object} sessions session/map.js api
 * @param {object} dispatch gateway/dispatch.js 实例
 * @returns {Array<{kind: string, path: string, handler: (req: any, res: any) => Promise<void>}>}
 */
export function makeRoutes(runtime, sessions, dispatch) {
  return [
    makeStatusRoute(runtime, sessions, dispatch),
    makeDiagnosticsRoute(dispatch, runtime),
  ];
}
