/**
 * 服务连接解析 —— 从 service.json 读到「连到哪里、用什么口令」。
 *
 * 与 `probe/detect.js` 的分工：
 *   - 探测（probe/）只回答"本机有没有可用服务"，**拿不到也不需要**口令（ProbeResult 永不携带凭据）。
 *   - 本文件在下发的**当口**重新读一遍注册文件（桌面端重启会换端口与口令 ⇒ 不能用缓存糊）。
 *
 * 纪律：password 只在本模块与 HTTP 客户端的内存里流转 —— 不进日志、不进证据、不进任何载荷。
 * 事实出处：00-recon/OPENCODE-LOCAL-RECON-20261015.md §1（注册文件与鉴权形态）。
 *
 * @module host/gateway/service
 */
import { readFileSync } from 'node:fs';

import { serviceJsonCandidates } from '../config/constants.js';
import { resolveHome, validateServiceFile } from '../probe/detect.js';

/** @returns {{ok: true, servicePath: string, baseUrl: string, version: string, pid: number|null, password: string, authLine: string} | {ok: false, reason: string, servicePath: string, evidence: string}} */
export function readServiceFile(env, serviceDir = '') {
  const home = resolveHome(env);
  const candidates = serviceJsonCandidates(home, serviceDir);
  let lastReason = 'service-missing';
  let lastPath = '';
  let lastEvidence = '';
  for (const candidate of candidates) {
    let text;
    try {
      text = readFileSync(candidate, 'utf8');
    } catch {
      lastEvidence = 'missing'; // 读不到（含不存在）—— 继续下一个候选
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      lastReason = 'invalid-json';
      lastPath = candidate;
      lastEvidence = 'invalid-json';
      continue;
    }
    const verdict = validateServiceFile(parsed);
    if (!verdict.ok) {
      lastReason = verdict.reason;
      lastPath = candidate;
      lastEvidence = verdict.reason;
      continue;
    }
    return {
      ok: true,
      servicePath: candidate,
      baseUrl: verdict.url,
      version: verdict.version,
      pid: verdict.pid,
      password: parsed.password,
      // 证据口径：绝不含 password（读到什么、什么版本、哪个 pid、哪个地址）。
      authLine: `service.json ok (version=${verdict.version || 'unknown'}, pid=${verdict.pid ?? 'unknown'})`,
    };
  }
  return { ok: false, reason: lastReason, servicePath: lastPath, evidence: lastEvidence === '' ? 'no candidate readable' : lastEvidence };
}

/**
 * 连接访问器（dispatch 用）。配置**现取**（.volatile 包装的通用坑：装配期拍死的值不随设置更新）。
 *
 * @param {{resolveConfig: () => any}} deps
 */
export function createServiceAccess({ resolveConfig }) {
  return {
    /**
     * 解析一次连接。baseUrl 覆盖（cfg.baseUrl）只改地址，不改凭据来源（口令始终来自 service.json）。
     * @param {Record<string, string | undefined>} [env]
     */
    resolveConnection(env = process.env) {
      const cfg = resolveConfig() ?? {};
      const serviceDir = typeof cfg.serviceDir === 'string' ? cfg.serviceDir : '';
      const file = readServiceFile(env, serviceDir);
      if (!file.ok) {
        return { ok: false, reason: file.reason, servicePath: file.servicePath, evidence: file.evidence };
      }
      const override = typeof cfg.baseUrl === 'string' && cfg.baseUrl !== '' ? cfg.baseUrl : '';
      if (override !== '' && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override)) {
        return { ok: false, reason: 'non-loopback-url', servicePath: file.servicePath, evidence: `baseUrl override=${override}` };
      }
      return {
        ok: true,
        servicePath: file.servicePath,
        baseUrl: override !== '' ? override : file.baseUrl,
        version: file.version,
        pid: file.pid,
        password: file.password,
        authLine: file.authLine,
      };
    },
  };
}
