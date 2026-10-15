/**
 * U6 只读探测：判定本机 opencode 桌面服务是否可用（H-NO-EXEC-PROBE）。
 *
 * 通道事实：opencode 桌面端启动后把服务注册文件写到 `~/.local/state/opencode/service.json`
 *   （配置目录 `~/.config/opencode/service.json` 一份同值副本），内容 `{id, version, url, pid, password}`
 *   —— url 形如 `http://127.0.0.1:<随机端口>`。出处：00-recon/OPENCODE-LOCAL-RECON-20261015.md §1。
 *
 * 约束（硬）：探测阶段不得启动任何目标程序 —— 只允许读文件系统 / 读环境变量。
 *   本插件**不启动 opencode**（也不重启）：桌面端不在跑 ⇒ 如实报 `service-missing`，
 *   由用户自己开桌面端（与"拒绝反代、全部可视化"一致：服务必须是桌面端自己的）。
 *
 * 本文件位于 `packages/plugin-opencode/src/host/probe/`（CI ③ H-NO-EXEC-PROBE 扫描范围），
 * 全文件不得出现任何进程执行形态（spawn / exec / fork / child_process / process.binding）
 * —— 由 CI ③ 拦截。
 *
 * 产出的 ProbeResult 字段逐字见 `src/host/types/index.js` 的 typedef：
 *   { installed, reason, servicePath, baseUrl, version, pid, evidence, at, method }
 *   - evidence: 逐处留痕（查了哪条路径、结论如何）——**绝不包含 password**。
 *   - method  : 'read-only'（本探测的全部手段）。
 *
 * 可测试性：`env` 为可选第三参（默认 process.env）；apply() 只传 (ctx, config)。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import { OPENCODE_HOME_ENV, PROBE_TARGET, serviceJsonCandidates } from '../config/constants.js';

/** 纯读判定：路径存在且为文件。任何异常（含拒绝访问）一律记 false，不抛。 */
function isReadonlyFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 解析 JSON：任何异常一律 null，不抛。 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 家目录（测试可用 DSH_OPENCODE_HOME 顶掉；顺序与 workbuddy 探测同款：专用变量 > HOME > USERPROFILE > homedir()）。 */
export function resolveHome(env) {
  const dedicated = typeof env[OPENCODE_HOME_ENV] === 'string' && env[OPENCODE_HOME_ENV] !== ''
    ? env[OPENCODE_HOME_ENV] : '';
  if (dedicated !== '') return dedicated;
  if (typeof env.HOME === 'string' && env.HOME !== '') return env.HOME;
  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '') return env.USERPROFILE;
  return homedir();
}

/**
 * 校验 service.json 形状（只认本机回环地址；非回环 = 拒绝 —— 下发的 prompt 绝不离开本机）。
 * @returns {{ok: true, url: string, version: string, pid: number|null}|{ok: false, reason: string}}
 */
export function validateServiceFile(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-json' };
  }
  const url = typeof parsed.url === 'string' ? parsed.url : '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
    return { ok: false, reason: url === '' ? 'missing-url' : 'non-loopback-url' };
  }
  const version = typeof parsed.version === 'string' ? parsed.version : '';
  const pid = typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : null;
  const password = typeof parsed.password === 'string' ? parsed.password : '';
  if (password === '') return { ok: false, reason: 'missing-password' };
  return { ok: true, url, version, pid };
}

/**
 * 只读探测本机 opencode 服务。永不抛：一切异常收敛为 reason:'error' 的结果对象。
 *
 * @param {object} _ctx 宿主 ctx（探测为纯只读 fs，不需要任何执行能力）
 * @param {object} _config 生效配置（读 `serviceDir` 覆盖）
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<import('../types/index.js').ProbeResult>}
 */
export async function detectOpencode(_ctx, config, env = process.env) {
  const evidence = [];
  const at = Date.now();
  const home = resolveHome(env);
  const serviceDir = typeof config?.serviceDir === 'string' ? config.serviceDir : '';
  const candidates = serviceJsonCandidates(home, serviceDir);
  try {
    for (const candidate of candidates) {
      if (!isReadonlyFile(candidate)) {
        evidence.push({ at, method: 'read-only', target: candidate, detail: 'missing' });
        continue;
      }
      let text = null;
      try {
        text = readFileSync(candidate, 'utf8');
      } catch {
        evidence.push({ at, method: 'read-only', target: candidate, detail: 'unreadable' });
        continue;
      }
      const parsed = parseJson(text);
      const verdict = validateServiceFile(parsed);
      if (!verdict.ok) {
        evidence.push({ at, method: 'read-only', target: candidate, detail: `invalid (${verdict.reason})` });
        continue;
      }
      // 命中：只记非敏感字段（version / pid / url）——password 绝不进证据。
      evidence.push({
        at,
        method: 'read-only',
        target: candidate,
        detail: `ok (version=${verdict.version || 'unknown'}, pid=${verdict.pid ?? 'unknown'}, url=${verdict.url})`,
      });
      return {
        installed: true,
        reason: 'ok',
        servicePath: candidate,
        baseUrl: verdict.url,
        version: verdict.version,
        pid: verdict.pid,
        evidence,
        at,
        method: 'read-only',
      };
    }
    return {
      installed: false,
      reason: 'service-missing',
      servicePath: '',
      baseUrl: '',
      version: '',
      pid: null,
      evidence,
      at,
      method: 'read-only',
    };
  } catch (err) {
    evidence.push({ at, method: 'read-only', target: '(probe)', detail: `error: ${err instanceof Error ? err.message : String(err)}` });
    return {
      installed: false,
      reason: 'error',
      servicePath: '',
      baseUrl: '',
      version: '',
      pid: null,
      evidence,
      at,
      method: 'read-only',
    };
  }
}

// PROBE_TARGET 由此文件使用语义锚定（ProbeResult 由调用方按插件名归类；此处引用防误删）。
export { PROBE_TARGET };
