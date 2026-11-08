/** @module host/config/constants */
import { PROBE_TARGET } from '../../shared/constants.js';

export { PROBE_TARGET };

export const REGISTRY_STATES = Object.freeze({
  UNKNOWN: 'unknown',
  REGISTERED: 'registered',
  UNREGISTERED: 'unregistered',
  SERVICE_MISSING: 'service_missing',
  DEGRADED: 'degraded',
});

export const RUN_STATES = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

export const REASON_CODES = Object.freeze({
  OK: 'OK',
  CDP_UNAVAILABLE: 'CDP_UNAVAILABLE',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  BRIDGE_ERROR: 'BRIDGE_ERROR',
  DISPATCH_REJECTED: 'DISPATCH_REJECTED',
  WAIT_TIMEOUT: 'WAIT_TIMEOUT',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  WORKSPACE_UNKNOWN: 'WORKSPACE_UNKNOWN',
  MODEL_UNKNOWN: 'MODEL_UNKNOWN',
  UNVERIFIED_CAPABILITY: 'UNVERIFIED_CAPABILITY',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  INTERNAL: 'INTERNAL',
});

export const REASON_TEXT = Object.freeze({
  [REASON_CODES.OK]: '已完成（以 Qoder 会话回执为准）',
  [REASON_CODES.CDP_UNAVAILABLE]: '无法连接 Qoder CDP（请确认 Qoder 已用 --remote-debugging-port 启动；插件不代拉起/不代改配置）',
  [REASON_CODES.TARGET_NOT_FOUND]: '未找到 Qoder renderer 目标（端口可能被其他进程占用）',
  [REASON_CODES.BRIDGE_ERROR]: 'Qoder 页面 JS 桥调用失败',
  [REASON_CODES.DISPATCH_REJECTED]: 'Qoder 拒绝了本次下发（如实返回上游错误）',
  [REASON_CODES.WAIT_TIMEOUT]: '等待回执超时（任务可能仍在 Qoder 中运行；可用 session_key 再次附着）',
  [REASON_CODES.SESSION_NOT_FOUND]: '目标会话不存在或已不可复用',
  [REASON_CODES.WORKSPACE_UNKNOWN]: '未能解析工作区（新会话需要有效 workspace；不会猜测）',
  [REASON_CODES.MODEL_UNKNOWN]: '请求的模型/档位不在当前目录能力中（未下发该项）',
  [REASON_CODES.UNVERIFIED_CAPABILITY]: '该能力尚未验证（已如实标注 unknown，未编造行为）',
  [REASON_CODES.AUTH_REQUIRED]: '需要登录/配置 PAT（签到与积分）',
  [REASON_CODES.UPSTREAM_ERROR]: '上游接口返回错误（见 detail；凭据不回显）',
  [REASON_CODES.INTERNAL]: '插件内部错误',
});

export const OUTPUT_LIMIT_BYTES = 256 * 1024;
export const DEFAULT_WAIT_TIMEOUT_MS = 900_000;
export const SESSION_SUMMARY_LIMIT = 20;
export const DEFAULT_CONCURRENCY_CAP = 3;
