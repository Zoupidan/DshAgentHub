/**
 * 路由装配（loopback-only）。
 * @module host/routes/index
 */
import { makeDiagnosticsRoute } from './diagnostics/get.js';
import { makeStatusRoute } from './status/get.js';
import { makeSigninRoutes } from './signin.js';
import { makeStartupRoute } from './startup.js';
import { makeTaskDeleteRoute } from './task-delete.js';

export function makeRoutes(runtime, sessions, dispatch) {
  return [
    makeStatusRoute(runtime, sessions, dispatch),
    makeDiagnosticsRoute(dispatch, runtime),
    makeStartupRoute(runtime),
    makeTaskDeleteRoute(),
    ...makeSigninRoutes(runtime),
  ];
}
